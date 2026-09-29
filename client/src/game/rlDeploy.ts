/**
 * ===== DEPLOYED RL POLICY =====
 *
 * Where the RL tactical policy is used and which weights it runs. One
 * localStorage section, `handz_rl_policy`, registered in the tuning bundle so
 * it downloads, uploads, publishes and ships as a build default like every
 * other tunable. It is player/tuning config, never career data.
 *
 * The parsed policy is cached on the raw stored string, so any write (the
 * Neural Network card, a bundle upload, build seeding) invalidates it on its
 * own with nothing to call.
 */
import type { AIDifficulty } from "./types";
import { RL_OBS_SIZE } from "./rlObservation";
import { rlPolicyFromJson, validateRlPolicyJson, type RlPolicy, type RlPolicyJson } from "./rlPolicy";

export const RL_DEPLOY_KEY = "handz_rl_policy";

export type RlDeployMode = "off" | "champion" | "all";
export const RL_DEPLOY_MODES: RlDeployMode[] = ["off", "champion", "all"];
export const RL_DEPLOY_MODE_LABELS: Record<RlDeployMode, string> = {
  off: "Off",
  champion: "Champion only",
  all: "All AI",
};

export interface RlDeployConfig {
  mode: RlDeployMode;
  policy: RlPolicyJson | null;
}

function readRaw(): string | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage.getItem(RL_DEPLOY_KEY);
  } catch {
    return null;
  }
}

function parseConfig(raw: string | null): RlDeployConfig {
  if (!raw) return { mode: "off", policy: null };
  try {
    const d = JSON.parse(raw) as Partial<RlDeployConfig> | null;
    const mode: RlDeployMode = d && RL_DEPLOY_MODES.includes(d.mode as RlDeployMode) ? (d.mode as RlDeployMode) : "off";
    const policy = d && d.policy && !validateRlPolicyJson(d.policy) ? (d.policy as RlPolicyJson) : null;
    return { mode, policy };
  } catch {
    return { mode: "off", policy: null };
  }
}

export function loadRlDeployConfig(): RlDeployConfig {
  return parseConfig(readRaw());
}

export function saveRlDeployConfig(cfg: RlDeployConfig): void {
  try {
    localStorage.setItem(RL_DEPLOY_KEY, JSON.stringify({ mode: cfg.mode, policy: cfg.policy }));
  } catch {
    /* out of storage: the previous config stays in force */
  }
}

/**
 * Why a policy file can't be deployed in this build, or null. Beyond the file
 * format itself, the network has to read the observation this build produces.
 */
export function rlPolicyDeployProblem(data: unknown): string | null {
  const bad = validateRlPolicyJson(data);
  if (bad) return bad;
  const obs = (data as RlPolicyJson).shape.obsSize;
  if (obs !== RL_OBS_SIZE) {
    return `Policy reads ${obs} observation values; this build produces ${RL_OBS_SIZE}.`;
  }
  return null;
}

let cacheRaw: string | null | undefined;
let cachePolicy: RlPolicy | null = null;
let cacheMode: RlDeployMode = "off";

function refresh(): void {
  const raw = readRaw();
  if (raw === cacheRaw) return;
  cacheRaw = raw;
  const cfg = parseConfig(raw);
  cacheMode = cfg.mode;
  cachePolicy = null;
  if (cfg.policy && !rlPolicyDeployProblem(cfg.policy)) {
    try {
      cachePolicy = rlPolicyFromJson(cfg.policy);
    } catch (err) {
      console.warn("[rl] deployed policy failed to load:", err);
    }
  }
}

/** The deployed policy regardless of mode, or null. */
export function getDeployedRlPolicy(): RlPolicy | null {
  refresh();
  return cachePolicy;
}

/**
 * The policy a brain being built for this fight should carry, or null for the
 * weighted chooser. Training-roster seeds are the caller's to exclude.
 */
export function rlPolicyForDifficulty(difficulty: AIDifficulty): RlPolicy | null {
  refresh();
  if (!cachePolicy || cacheMode === "off") return null;
  if (cacheMode === "champion" && difficulty !== "champion") return null;
  return cachePolicy;
}
