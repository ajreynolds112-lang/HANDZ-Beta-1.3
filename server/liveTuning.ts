/**
 * Neural Network live update. The workspace publishes every tunable, the AI
 * Training state and every replacement sound to the shared bucket as they
 * change; the live server polls it and serves the newest, and live pages
 * reload onto it (LiveTuningUpdater on the client). No Publish needed.
 */
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { bucket, HERE } from "./bucket";
import { readTunedDefaults } from "./tuningDefaults";

const soundKey = (name: string) => `live-tuning/sounds/${name}`;
const SOUND_DIR = path.resolve(process.cwd(), "data", "sounds");
const POLL_MS = 15_000;

/**
 * One published document: `<name>.json` plus a small `<name>-rev.json` that
 * points at it, so live polls the tiny file and downloads the big one only on
 * change.
 */
function channel(name: string) {
  const dataKey = `live-tuning/${name}.json`;
  const revKey = `live-tuning/${name}-rev.json`;
  let publishing = false;
  let queued: string | null = null;
  let current: { rev: string; text: string } | null = null;

  return {
    /** Workspace. Latest-wins: one upload in flight; edits meanwhile collapse into one follow-up. */
    publish(doc: unknown): void {
      if (HERE !== "dev") return;
      queued = JSON.stringify(doc);
      if (publishing) return;
      publishing = true;
      void (async () => {
        try {
          while (queued !== null) {
            const text: string = queued;
            queued = null;
            const rev = createHash("sha256").update(text).digest("hex").slice(0, 16);
            // Data first, then the rev that points at it, so a poll never sees a rev without its data.
            const up = await bucket().uploadFromText(dataKey, text);
            if (!up.ok) { console.error(`[live-tuning] ${name} upload failed:`, up.error); continue; }
            const mark = await bucket().uploadFromText(revKey, JSON.stringify({ rev, at: new Date().toISOString() }));
            if (!mark.ok) console.error(`[live-tuning] ${name} upload failed:`, mark.error);
          }
        } catch (error) {
          console.error(`[live-tuning] ${name} upload failed:`, error);
        } finally {
          publishing = false;
        }
      })();
    },
    /** Live. */
    async poll(): Promise<void> {
      const mark = await bucket().downloadAsText(revKey);
      if (!mark.ok) return; // nothing published yet
      const { rev } = JSON.parse(mark.value) as { rev: string };
      if (current?.rev === rev) return;
      const res = await bucket().downloadAsText(dataKey);
      if (res.ok) current = { rev, text: res.value };
    },
    current: () => current,
  };
}

const tuning = channel("bundle");
const training = channel("training");

export const publishLiveTuning = (bundle: unknown) => tuning.publish(bundle);
export const publishLiveTraining = (params: unknown) => training.publish({ params });

export function publishLiveSound(name: string, body: Buffer): void {
  if (HERE !== "dev") return;
  void bucket().uploadFromBytes(soundKey(name), body)
    .then(r => { if (!r.ok) console.error("[live-tuning] sound upload failed:", r.error); })
    .catch(error => console.error("[live-tuning] sound upload failed:", error));
}

/** Workspace boot: push the current bundle and any sounds the bucket lacks. */
async function seedFromWorkspace(): Promise<void> {
  const bundle = readTunedDefaults();
  if (bundle) publishLiveTuning(bundle);
  if (!fs.existsSync(SOUND_DIR)) return;
  for (const name of fs.readdirSync(SOUND_DIR)) {
    const exists = await bucket().exists(soundKey(name));
    if (exists.ok && !exists.value) publishLiveSound(name, fs.readFileSync(path.join(SOUND_DIR, name)));
  }
}

// ── live side ───────────────────────────────────────────────────────────────
let bundleCache: { rev: string; bundle: Record<string, unknown> | null } | null = null;

/** The tunables a live page should carry: the workspace's newest publish, else (null) the build's file. */
export function liveTunedBundle(): Record<string, unknown> | null {
  const cur = tuning.current();
  if (!cur) return null;
  if (bundleCache?.rev !== cur.rev) {
    let bundle: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(cur.text);
      if (parsed && typeof parsed === "object" && parsed.params && typeof parsed.params === "object") bundle = parsed;
    } catch { /* a bad publish falls back to the build's file */ }
    bundleCache = { rev: cur.rev, bundle };
  }
  return bundleCache.bundle;
}

/** The live publish in force (tunables + training), so pages can tell they're behind. Null in the workspace. */
export function liveTuningRev(): string | null {
  return HERE === "live" ? `${tuning.current()?.rev ?? "build"}.${training.current()?.rev ?? "none"}` : null;
}
export const liveTrainingRev = (): string | null => HERE === "live" ? training.current()?.rev ?? null : null;
/** The published AI Training document (`{ params }`), live only. */
export const liveTrainingText = (): string | null => HERE === "live" ? training.current()?.text ?? null : null;

/** Live: a replacement sound uploaded since the last Publish comes from the bucket. */
export async function liveSound(name: string): Promise<Buffer | null> {
  if (HERE !== "live" || !/^[a-zA-Z0-9]{1,40}-[0-9a-f]{12}\.(mp3|wav)$/.test(name)) return null;
  const res = await bucket().downloadAsBytes(soundKey(name));
  return res.ok ? res.value[0] : null;
}

export async function initLiveTuning(): Promise<void> {
  if (!process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID) return;
  if (HERE === "dev") {
    void seedFromWorkspace().catch(error => console.error("[live-tuning] seed failed:", error));
    return;
  }
  const pollAll = () => Promise.all([tuning.poll(), training.poll()])
    .catch(error => console.error("[live-tuning] poll failed:", error));
  // Load before the first page is served (bounded), so pages don't open one publish behind.
  await Promise.race([pollAll(), new Promise(r => setTimeout(r, 8000))]);
  setInterval(() => { void pollAll(); }, POLL_MS).unref();
}
