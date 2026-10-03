/**
 * Generate the 3D arena props with Tripo3D, offline.
 *
 *   npx tsx script/generateTripoAssets.ts            # generate anything missing
 *   npx tsx script/generateTripoAssets.ts ring_bell  # only the named props
 *
 * Calls the Tripo v3 API directly with the TRIPO_API_KEY secret (read from the
 * environment, never printed or committed). For each prop in PROP_CATALOG it:
 *   1. submits a text-to-model task (smart low-poly, face limit, textured),
 *      retrying once without smart low-poly if that mode fails for the prompt,
 *   2. polls until done and downloads the GLB at once — Tripo's output URLs
 *      expire after five minutes,
 *   3. writes client/public/models/<id>.glb and records it in manifest.json.
 *
 * Props already in the manifest with their file on disk are skipped, so a rerun
 * only fills the gaps. A prop that fails is reported and left out of the
 * manifest; the game builds a code stand-in for anything missing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { PROP_CATALOG, type PropManifest, type PropManifestEntry, type PropSpec } from "../client/src/game/three/propCatalog";

const OUT_DIR = path.resolve(import.meta.dirname, "..", "client", "public", "models");
const MANIFEST_PATH = path.join(OUT_DIR, "manifest.json");
const POLL_MS = 4000;
/** Props generated at once. */
const CONCURRENCY = 4;
const TASK_TIMEOUT_MS = 10 * 60 * 1000;

const API_BASE = "https://openapi.tripo3d.ai/v3";
const MODEL_VERSION = "v3.1-20260211";
const API_KEY = process.env.TRIPO_API_KEY;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function tripo<T = any>(apiPath: string, body?: unknown): Promise<T> {
  if (!API_KEY) throw new Error("TRIPO_API_KEY is not set");
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_BASE}${apiPath}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if ((res.status === 429 || res.status >= 502) && attempt < 8) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    const text = await res.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!res.ok || !json || json.code !== 0) {
      const msg = json?.message ?? text.slice(0, 200);
      throw new Error(`Tripo ${apiPath} failed (${res.status}, code ${json?.code ?? "?"}): ${msg}`);
    }
    return json.data as T;
  }
}

async function createTextToModel(body: Record<string, unknown>): Promise<string> {
  const data = await tripo<{ task_id: string }>("/generation/text-to-model", body);
  return data.task_id;
}

async function waitForTask(taskId: string): Promise<any> {
  const start = Date.now();
  for (;;) {
    const data = await tripo<any>(`/tasks/${taskId}`);
    const status = data.status as string;
    if (status === "success") return data;
    if (status === "failed" || status === "cancelled" || status === "banned" || status === "expired" || status === "unknown") {
      throw new Error(`task ${taskId} ended with status ${status}`);
    }
    if (Date.now() - start > TASK_TIMEOUT_MS) throw new Error(`task ${taskId} timed out (last status ${status})`);
    process.stdout.write(`    ${taskId}: ${status} ${data.progress ?? ""}%\r`);
    await sleep(POLL_MS);
  }
}

function modelUrlOf(task: any): string | null {
  const out = task?.output ?? {};
  return out.model_url ?? out.model ?? out.pbr_model ?? null;
}

async function download(url: string): Promise<Buffer> {
  // Output URLs are pre-signed CDN links, not Tripo API paths: plain fetch.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** Triangle count read straight out of the GLB's JSON chunk. */
function glbFaceCount(buf: Buffer): number | null {
  try {
    if (buf.readUInt32LE(0) !== 0x46546c67) return null; // "glTF"
    const jsonLen = buf.readUInt32LE(12);
    const gltf = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
    let faces = 0;
    for (const mesh of gltf.meshes ?? []) {
      for (const prim of mesh.primitives ?? []) {
        const acc = prim.indices != null ? gltf.accessors[prim.indices] : gltf.accessors[prim.attributes?.POSITION];
        if (acc?.count) faces += Math.floor(acc.count / 3);
      }
    }
    return faces;
  } catch {
    return null;
  }
}

function readManifest(): PropManifest {
  if (existsSync(MANIFEST_PATH)) {
    try {
      const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as PropManifest;
      if (Array.isArray(m.assets)) return m;
    } catch { /* rewrite below */ }
  }
  return { generator: "tripo3d", assets: [] };
}

function writeManifest(m: PropManifest): void {
  m.assets.sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2) + "\n");
}

async function generate(spec: PropSpec): Promise<PropManifestEntry> {
  const base = {
    prompt: spec.prompt,
    model: MODEL_VERSION,
    face_limit: spec.faceLimit,
    texture: true,
    pbr: false,
    texture_quality: "standard",
  };
  let taskId: string;
  let modelTask: any;
  try {
    console.log(`  ${spec.id}: text-to-model (smart low-poly, ${spec.faceLimit} faces)`);
    taskId = await createTextToModel({ ...base, smart_low_poly: true });
    modelTask = await waitForTask(taskId);
  } catch (err) {
    // Smart low-poly can refuse complex prompts; plain mode honours face_limit too.
    console.warn(`\n  ${spec.id}: smart low-poly failed (${(err as Error).message}); retrying in standard mode`);
    taskId = await createTextToModel(base);
    modelTask = await waitForTask(taskId);
  }
  if (modelTask.credits_consumed != null) console.log(`\n  ${spec.id}: ${modelTask.credits_consumed} credits`);

  const url = modelUrlOf(modelTask);
  if (!url) throw new Error("task finished without a model URL");
  const buf = await download(url);
  const file = `${spec.id}.glb`;
  writeFileSync(path.join(OUT_DIR, file), buf);
  console.log(`\n  ${spec.id}: saved ${file} (${(buf.length / 1024).toFixed(0)} KB)`);
  return {
    id: spec.id,
    file,
    prompt: spec.prompt,
    taskId,
    faceCount: glbFaceCount(buf),
    generatedAt: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const only = new Set(process.argv.slice(2));
  const manifest = readManifest();
  const failures: string[] = [];

  const todo = PROP_CATALOG.filter(spec => {
    if (only.size > 0 && !only.has(spec.id)) return false;
    const existing = manifest.assets.find(a => a.id === spec.id);
    if (existing && existsSync(path.join(OUT_DIR, existing.file))) {
      console.log(`  ${spec.id}: already generated, skipping`);
      return false;
    }
    return true;
  });
  // A few tasks at a time: Tripo runs them in parallel, and the manifest is
  // only ever written from this one process, so there is no write race.
  const queue = [...todo];
  const worker = async (): Promise<void> => {
    for (let spec = queue.shift(); spec; spec = queue.shift()) {
      try {
        const entry = await generate(spec);
        manifest.assets = manifest.assets.filter(a => a.id !== spec!.id);
        manifest.assets.push(entry);
        // Written after every prop so an interrupted run keeps what it finished.
        writeManifest(manifest);
      } catch (err) {
        failures.push(spec.id);
        console.error(`  ${spec.id}: FAILED — ${(err as Error).message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  writeManifest(manifest);
  if (failures.length > 0) {
    console.error(`\n${failures.length} prop(s) not generated: ${failures.join(", ")}. The game uses code-built stand-ins for these.`);
    process.exitCode = 1;
  } else {
    console.log("\nAll props generated.");
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
