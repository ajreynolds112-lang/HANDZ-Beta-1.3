/**
 * Generate the 3D boxer assets with Tripo3D, offline.
 *
 *   npx tsx script/generateTripoFighter.ts             # generate anything missing
 *   npx tsx script/generateTripoFighter.ts body glove  # only the named parts
 *
 * One shared base body (untextured so every region tints from the fighter's
 * colours) is generated, then auto-rigged as a biped with Mixamo bone names.
 * Gloves, shoes and headgear are separate untextured models the game attaches
 * to the hand, foot and head bones. Output: client/public/models/fighter/*.glb
 * plus fighter-manifest.json. Uses the TRIPO_API_KEY secret from the env.
 *
 * Anything that fails is left out of the manifest; the game then builds the
 * code rig (same bone names) for the body, or a primitive for a gear piece.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";

const OUT_DIR = path.resolve(import.meta.dirname, "..", "client", "public", "models", "fighter");
const MANIFEST_PATH = path.join(OUT_DIR, "fighter-manifest.json");
const API_BASE = "https://openapi.tripo3d.ai/v3";
const MODEL_VERSION = "v3.1-20260211";
const API_KEY = process.env.TRIPO_API_KEY;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

interface PartSpec { id: string; prompt: string; faceLimit: number; rig?: boolean }

const PARTS: PartSpec[] = [
  {
    id: "body",
    prompt: "low poly game character, athletic muscular male boxer, bald head, barefoot, bare hands, wearing only plain loose boxing shorts, "
      + "standing straight in T-pose with arms stretched out horizontally to the sides, legs slightly apart, symmetrical, neutral face, "
      + "single plain light grey material, no patterns, no logos",
    faceLimit: 10000,
    rig: true,
  },
  {
    id: "glove",
    prompt: "single boxing glove, low poly game asset, smooth rounded leather glove with a short padded wrist cuff, plain untextured, "
      + "glove pointing forward, no logo, no laces",
    faceLimit: 1500,
  },
  {
    id: "shoe",
    prompt: "single high-top boxing shoe, low poly game asset, ankle-high boot with front lacing and thin flat sole, plain untextured, side view pointing forward, no logo",
    faceLimit: 1500,
  },
  {
    id: "headgear",
    prompt: "boxing sparring headgear helmet only, low poly game asset, padded head guard with open face, cheek pads and forehead pad, plain untextured, no logo, no head inside",
    faceLimit: 2000,
  },
];

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
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
    if (!res.ok || !json || json.code !== 0) {
      throw new Error(`Tripo ${apiPath} failed (${res.status}, code ${json?.code ?? "?"}): ${json?.message ?? text.slice(0, 200)}`);
    }
    return json.data as T;
  }
}

async function waitForTask(taskId: string): Promise<any> {
  const start = Date.now();
  for (;;) {
    const data = await tripo<any>(`/tasks/${taskId}`);
    if (data.status === "success") return data;
    if (["failed", "cancelled", "banned", "expired", "unknown"].includes(data.status)) {
      throw new Error(`task ${taskId} ended with status ${data.status}`);
    }
    if (Date.now() - start > 12 * 60 * 1000) throw new Error(`task ${taskId} timed out`);
    await sleep(4000);
  }
}

async function downloadOutput(task: any, file: string): Promise<number> {
  const out = task?.output ?? {};
  const url = out.model_url ?? out.model ?? out.pbr_model;
  if (!url) throw new Error("task finished without a model URL");
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(path.join(OUT_DIR, file), buf);
  return buf.length;
}

type Manifest = { generator: string; parts: Record<string, { file: string; taskId: string; rigged?: boolean; prompt: string }> };

function readManifest(): Manifest {
  try {
    const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
    if (m && m.parts) return m;
  } catch { /* fresh */ }
  return { generator: "tripo3d", parts: {} };
}

async function generatePart(spec: PartSpec): Promise<Manifest["parts"][string]> {
  console.log(`${spec.id}: text-to-model`);
  const { task_id } = await tripo<{ task_id: string }>("/generation/text-to-model", {
    prompt: spec.prompt,
    model: MODEL_VERSION,
    face_limit: spec.faceLimit,
    texture: false,
    pbr: false,
  });
  const modelTask = await waitForTask(task_id);
  if (!spec.rig) {
    const file = `${spec.id}.glb`;
    const bytes = await downloadOutput(modelTask, file);
    console.log(`${spec.id}: saved ${file} (${(bytes / 1024).toFixed(0)} KB)`);
    return { file, taskId: task_id, prompt: spec.prompt };
  }
  // Keep the unrigged mesh too, for inspection if the rig is rejected (not loaded by the game; delete before shipping).
  await downloadOutput(modelTask, `${spec.id}_unrigged.glb`);
  const check = await tripo<{ task_id: string }>("/animations/rig-check", { input: task_id });
  const checkTask = await waitForTask(check.task_id);
  console.log(`${spec.id}: rig-check`, JSON.stringify(checkTask.output));
  if (checkTask.output?.riggable === false) throw new Error("model is not riggable");
  const rig = await tripo<{ task_id: string }>("/animations/rig", {
    input: task_id,
    model: "v1.0-20240301",
    rig_type: "biped",
    spec: "mixamo",
    out_format: "glb",
  });
  const rigTask = await waitForTask(rig.task_id);
  const file = `${spec.id}.glb`;
  const bytes = await downloadOutput(rigTask, file);
  console.log(`${spec.id}: rigged, saved ${file} (${(bytes / 1024).toFixed(0)} KB)`);
  return { file, taskId: rig.task_id, rigged: true, prompt: spec.prompt };
}

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const only = new Set(process.argv.slice(2));
  const manifest = readManifest();
  const jobs = PARTS.filter(p => (only.size === 0 || only.has(p.id))
    && !(manifest.parts[p.id] && existsSync(path.join(OUT_DIR, manifest.parts[p.id].file)) && only.size === 0));
  const results = await Promise.allSettled(jobs.map(async p => {
    manifest.parts[p.id] = await generatePart(p);
    writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  }));
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      console.error(`${jobs[i].id}: FAILED — ${(r.reason as Error).message}`);
      process.exitCode = 1;
    }
  });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

main().catch(err => { console.error(err); process.exit(1); });
