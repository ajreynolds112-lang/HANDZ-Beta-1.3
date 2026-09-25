/**
 * The Champion AI's situation-keyed parameter memory, as ordinary play sees it.
 *
 * Training assembles two things and publishes them here together: the champion's
 * 218 fundamental parameters, and a store of remembered situations per
 * fundamental. At fight time the AI reads the situation it is in, finds the
 * fundamental whose remembered situations resemble it most, and adopts that
 * fundamental's parameters until a different situation takes over.
 *
 * This module is deliberately tiny and imports nothing from the UI. Both the
 * training screen (which writes) and the AI (which reads) depend on it, and
 * routing either through the other would close an import cycle.
 */
import {
  type FundamentalStateStore, type Situation, type FundamentalState,
  serializeStore, deserializeStore, matchState, SIMILARITY_FLOOR,
  situationSimilarity,
} from "./fundamentalStates";

const LS_KEY = "handz_champion_fundamental_states";

export interface ChampionFundamentals {
  /** The champion's full parameter set — every fundamental, not just one. */
  params: Record<string, number>;
  /** Fundamental key -> remembered situations. */
  store: FundamentalStateStore;
}

/** Read once, then held. The hot path must not parse JSON. */
let cache: ChampionFundamentals | null | undefined;

export function getChampionFundamentals(): ChampionFundamentals | null {
  if (cache !== undefined) return cache;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return (cache = null);
    const parsed = JSON.parse(raw) as { params?: unknown; store?: unknown };
    const params: Record<string, number> = {};
    if (parsed.params && typeof parsed.params === "object") {
      for (const [k, v] of Object.entries(parsed.params as Record<string, unknown>)) {
        if (typeof v === "number" && Number.isFinite(v)) params[k] = v;
      }
    }
    const store = deserializeStore(parsed.store);
    // Parameters without remembered situations can never be selected, and
    // situations without parameters have nothing to apply.
    if (Object.keys(params).length === 0 || Object.keys(store).length === 0) return (cache = null);
    return (cache = { params, store });
  } catch {
    return (cache = null);
  }
}

export function publishChampionFundamentals(params: Record<string, number>, store: FundamentalStateStore) {
  cache = { params: { ...params }, store };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ params, store: serializeStore(store) }));
  } catch { /* storage full — the in-memory copy still drives this session */ }
}

export function clearChampionFundamentals() {
  cache = null;
  try { localStorage.removeItem(LS_KEY); } catch { /* nothing to clear */ }
}

/**
 * Which fundamental best suits the situation, and the parameters it was
 * remembered under.
 *
 * Every fundamental with remembered situations is a candidate: the winner is
 * whichever one has a remembered situation closest to this one. Below the
 * activation floor nothing is close enough to be worth adopting, and null means
 * carry on with whatever is already in effect rather than snapping back to the
 * base — a situation nothing was learned in is not evidence that the current
 * fundamental has stopped applying.
 */
export function bestFundamentalFor(
  store: FundamentalStateStore,
  situation: Situation,
): { fundKey: string; state: FundamentalState; score: number } | null {
  let best: { fundKey: string; state: FundamentalState; score: number } | null = null;

  for (const fundKey of Object.keys(store)) {
    const hit = matchState(store, fundKey, situation);
    if (!hit) continue;
    const score = situationSimilarity(situation, hit.s);
    if (score < SIMILARITY_FLOOR) continue;
    if (!best || score > best.score) best = { fundKey, state: hit, score };
  }
  return best;
}
