/**
 * The Neural Network screen's parameter bundle.
 *
 * Every tunable the screen exposes lives in its own localStorage key, written
 * by whichever card owns it — the punch animation editor, the AI graphs, the
 * roster generation screen, fight tips, the items tab, the level ramps, the XP
 * multipliers and the cards on the main column. This module is the one place
 * that knows the whole list, so the screen can hand it all over as a single
 * file and take it all back.
 *
 * Two jobs beyond download/upload:
 *
 *  - `seedTunedDefaults` reads the bundle the server inlines into the page
 *    (`window.__HANDZ_TUNED__`) and writes it into localStorage before anything
 *    else boots. That is what makes a tweak survive publishing: the workspace
 *    writes its parameters to disk, the file ships with the build, and every
 *    browser that opens the published app starts from those numbers instead of
 *    the built-in defaults. No card has to know about it — they all read the
 *    same keys they always did.
 *
 *  - `startTuningDefaultsWatcher` pushes the current bundle back to the dev
 *    server whenever any of those keys changes, so "tweaked" and "uploaded"
 *    both become the new default with nothing to press.
 */
import { reloadScaling } from "./scalingConfig";
import { invalidatePunchAnimCache } from "./punchAnimConfig";
import { reloadRefinementTuning } from "@/game/refinementTuning";
import { reloadChampionFundamentals } from "@/game/championStates";

/**
 * Every parameter key the Neural Network screen exposes, against the shape its
 * own loader expects at the top level.
 *
 * Only the outermost shape: each card already merges its section field by field
 * over its defaults, so a wrong number inside lands on that card's default. An
 * object where an array belongs is the one hand-edit that gets past those
 * loaders and crashes the screen that reads it, so that is what's checked.
 *
 * Order is cosmetic — it sets the order of sections in the downloaded file.
 */
const PARAM_SHAPES = {
  // Punch animation editor
  handz_punch_anim: "object",
  // AI graphs: live state, "set as default" snapshots, named presets, per-opponent overrides
  handz_neural_state: "object",
  handz_neural_defaults: "object",
  handz_neural_presets: "array",
  handz_fighter_neural: "object",
  // Roster generation screen (bands, equipment, refinements, endurance, crates)
  handz_roster_gen_config: "object",
  // Fight tips
  handz_fight_tips: "array",
  // Items tab: catalog, its one-time recategorisation stamp, drop distribution, daily rewards
  handz_items_config: "array",
  handz_items_recategorized: "array",
  handz_item_dist_config: "object",
  handz_daily_reward_config: "object",
  // Level stat ramps, gap terms, stat-point coefficients and caps
  handz_scaling_config: "object",
  // XP / stat-point multipliers, live and "set as default"
  handz_xp_config: "object",
  handz_xp_defaults: "object",
  // Cards down the main column
  handz_max_stamina_config: "object",
  handz_refinement_tuning: "object",
  handz_turn_config: "object",
  handz_ai_range_config: "object",
  handz_rc_config: "object",
  handz_stoppage_config: "object",
  handz_ai_pattern_config: "object",
  handz_fatigue_config: "object",
  handz_directional_perfect_block: "boolean",
  handz_nightmare_bypass: "boolean",
  handz_refinement_bypass: "boolean",
  // Pattern-memory "under the hood" HUD switch
  handz_under_the_hood: "boolean",
  // RL tactical policy: deployment mode + the deployed network's weights. The
  // last policy deployed from AI Training is what a publish ships.
  handz_rl_policy: "object",
  // Fundamentals training output: the champion's parameters + remembered
  // situations, published each time a fundamental closes.
  handz_champion_fundamental_states: "object",
} as const satisfies Record<string, "object" | "array" | "boolean">;

export type TuningParamKey = keyof typeof PARAM_SHAPES;

export const TUNING_PARAM_KEYS = Object.keys(PARAM_SHAPES) as TuningParamKey[];

function shapeOf(value: unknown): "object" | "array" | "boolean" | "other" {
  if (Array.isArray(value)) return "array";
  if (typeof value === "boolean") return "boolean";
  if (value !== null && typeof value === "object") return "object";
  return "other";
}

/** null when the section can be stored, else what it should have been. */
function checkShape(key: TuningParamKey, value: unknown): string | null {
  const want = PARAM_SHAPES[key];
  return shapeOf(value) === want ? null : `"${key}" must be ${want === "array" ? "a list" : want === "boolean" ? "true or false" : "an object"}.`;
}

export const TUNING_BUNDLE_KIND = "handz-neural-parameters";
export const TUNING_BUNDLE_VERSION = 1;

/** Stamp of the shipped bundle this browser has already taken. */
const TUNED_REV_KEY = "handz_tuned_rev";

const DEFAULTS_ENDPOINT = "/api/tuning-defaults";

export interface TuningBundle {
  kind: typeof TUNING_BUNDLE_KIND;
  version: number;
  exportedAt: string;
  /** Key -> value, JSON-decoded so the downloaded file is editable by hand. */
  params: Record<string, unknown>;
}

function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * localStorage holds strings; every section is stored as JSON (the toggles as
 * a bare `true`/`false`), so the file reads as real numbers rather than an
 * escaped blob. A value that won't parse, or that isn't the shape its loader
 * expects, is already broken in this browser and is left out rather than
 * carried into a file that then fails to upload.
 */
export function collectTuningParams(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of TUNING_PARAM_KEYS) {
    const raw = readRaw(key);
    if (raw === null) continue;
    try {
      const value = JSON.parse(raw);
      if (checkShape(key, value)) continue;
      out[key] = value;
    } catch {
      /* not JSON: nothing a parameter file can carry */
    }
  }
  return out;
}

export function buildTuningBundle(): TuningBundle {
  return {
    kind: TUNING_BUNDLE_KIND,
    version: TUNING_BUNDLE_VERSION,
    exportedAt: new Date().toISOString(),
    params: collectTuningParams(),
  };
}

/** `null` when the payload can be applied, otherwise the reason to show. */
export function validateTuningBundle(data: unknown): string | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "File must be a JSON object.";
  }
  const bundle = data as Record<string, unknown>;
  if (bundle.kind !== TUNING_BUNDLE_KIND) {
    return `Not a parameter file — "kind" must be "${TUNING_BUNDLE_KIND}".`;
  }
  const version = bundle.version;
  if (typeof version !== "number" || !Number.isFinite(version)) {
    return `"version" must be a number.`;
  }
  if (version > TUNING_BUNDLE_VERSION) {
    return `File is version ${version}, this build reads up to ${TUNING_BUNDLE_VERSION}.`;
  }
  const params = bundle.params;
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return `"params" must be a JSON object.`;
  }
  const known = TUNING_PARAM_KEYS as readonly string[];
  const strays = Object.keys(params).filter(k => !known.includes(k));
  if (strays.length > 0) {
    return `Unknown parameter section: ${strays.slice(0, 3).join(", ")}${strays.length > 3 ? "…" : ""}`;
  }
  for (const key of TUNING_PARAM_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(params, key)) continue;
    const wrong = checkShape(key, (params as Record<string, unknown>)[key]);
    if (wrong) return wrong;
  }
  return null;
}

/**
 * @param dropMissing remove keys the bundle doesn't carry. An upload is a
 * replacement, so a section deleted from the file goes back to its built-in
 * default; seeding is additive and never clears what the browser already has.
 */
function writeParams(params: Record<string, unknown>, dropMissing: boolean): void {
  for (const key of TUNING_PARAM_KEYS) {
    try {
      if (!Object.prototype.hasOwnProperty.call(params, key)) {
        if (dropMissing) localStorage.removeItem(key);
        continue;
      }
      const value = params[key];
      // Also guards seeding, where a bad section in a shipped file would
      // otherwise reach a loader on every boot with no one to report it to.
      if (checkShape(key, value)) continue;
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* out of storage / private mode: the rest of the bundle still lands */
    }
  }
}

/**
 * Configs the fight loop reads through a module-level cache. The items catalog
 * and its drop distribution key their caches on the raw stored string, so a
 * write invalidates them on its own; these don't.
 */
export function invalidateTuningCaches(): void {
  try { reloadScaling(); } catch { /* nothing to reload */ }
  try { invalidatePunchAnimCache(); } catch { /* nothing to reload */ }
  try { reloadRefinementTuning(); } catch { /* nothing to reload */ }
  try { reloadChampionFundamentals(); } catch { /* nothing to reload */ }
}

/** Replace every parameter with the bundle's. Validate first. */
export function applyTuningBundle(bundle: TuningBundle): void {
  writeParams(bundle.params, true);
  invalidateTuningCaches();
}

/** FNV-1a. Used for change detection and the shipped-bundle stamp, not security. */
function hashString(s: string, seed = 0x811c9dc5): number {
  let h = seed;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Cheap fingerprint of every parameter key, for spotting an edit. */
export function tuningSignature(): string {
  let h = 0x811c9dc5;
  for (const key of TUNING_PARAM_KEYS) {
    h = hashString(key, h);
    h = hashString(readRaw(key) ?? "\u0000", h);
  }
  return h.toString(16);
}

/**
 * Take the parameters the server inlined into the page. Runs once per shipped
 * bundle: the stamp means a reset made in this browser isn't undone on every
 * reload, while a new build's numbers still arrive.
 */
export function seedTunedDefaults(): void {
  if (typeof window === "undefined") return;
  const injected = (window as unknown as { __HANDZ_TUNED__?: unknown }).__HANDZ_TUNED__;
  if (!injected || typeof injected !== "object") return;
  const params = (injected as { params?: unknown }).params;
  if (!params || typeof params !== "object" || Array.isArray(params)) return;

  let serialized: string;
  try {
    serialized = JSON.stringify(params);
  } catch {
    return;
  }
  const rev = hashString(serialized).toString(16);
  try {
    if (localStorage.getItem(TUNED_REV_KEY) === rev) return;
    writeParams(params as Record<string, unknown>, false);
    localStorage.setItem(TUNED_REV_KEY, rev);
  } catch {
    /* no storage: the app still runs on its built-in defaults */
  }
}

/** Stops asking once the server says these are baked in (a published build). */
let pushRefused = false;

/**
 * Hand the current parameters to the server so they become the defaults the
 * next build ships. A published server refuses — its filesystem doesn't
 * survive a redeploy — so the caller neither waits on this nor reports it.
 */
export async function pushTuningDefaults(): Promise<boolean> {
  if (pushRefused) return false;
  try {
    const res = await fetch(DEFAULTS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(buildTuningBundle()),
    });
    if (res.status === 403) pushRefused = true;
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Watch every parameter key and push the bundle whenever one changes. Polling
 * rather than wrapping each card's save: there are twenty-odd writers across
 * six screens, and the cost here is one hash of values already in memory.
 *
 * @returns a stop function that flushes a pending change on the way out.
 */
export function startTuningDefaultsWatcher(intervalMs = 1500): () => void {
  // Empty, so the first tick always pushes: a section newly added to the
  // registry (or deployed while no watcher ran) reaches the file without
  // waiting for some other edit.
  let last = "";
  let inFlight = false;
  let queued = false;

  const send = () => {
    const sig = tuningSignature();
    if (sig === last) return;
    last = sig;
    inFlight = true;
    void pushTuningDefaults().finally(() => {
      inFlight = false;
      // An edit made mid-request — including the last one before the screen
      // closed — still has to reach disk.
      if (queued) {
        queued = false;
        send();
      }
    });
  };

  const flush = () => {
    if (pushRefused) return;
    if (inFlight) {
      queued = true;
      return;
    }
    send();
  };

  const id = window.setInterval(flush, intervalMs);
  return () => {
    window.clearInterval(id);
    flush();
  };
}
