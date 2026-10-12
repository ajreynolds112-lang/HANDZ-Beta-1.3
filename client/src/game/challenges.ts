/**
 * Challenges: roster fighters asking the player to spar (at their gym, 3x3min,
 * Champion difficulty) or to fight (books an official fight). Requests are
 * rolled in the save funnel as weeks advance, so every week-advancing path is
 * covered without touching the weekly sim or its seeded rng order.
 *
 * Imports types only — localSaves reads this, so it must not import back.
 */
import type { CareerRosterState, ChallengeRequest, ChallengeState } from "@shared/schema";
import type { CrateId } from "./cratesConfig";

export const MAX_CHALLENGE_REQUESTS = 20;
const BASE_CHANCE = 0.35;
const CHANCE_PER_WIN = 0.01;
const FIGHT_SHARE = 0.3;
const MIN_WINS = 2;
const CHAMP_ID = 204;
/** How far above the player the Select Opponent reroll reaches (mirrors careerRoster). */
const REROLL_REACH = 20;
const REROLL_REACH_EXPANDED = 50;
const EXPANDED_BOARD_WINS = 10;
/** Week the booked official fight is fought, if any. */
export function bookedFightWeek(rs: CareerRosterState): number | null {
  return rs.selectedOpponentId != null ? rs.weekNumber + (rs.prepWeeksRemaining ?? 0) : null;
}

export function challengeStateOf(rs: CareerRosterState | null | undefined): ChallengeState {
  const c = rs?.challengeState;
  return {
    rev: c?.rev ?? 0,
    requests: c?.requests ?? [],
    away: c?.away ?? null,
    received: c?.received ?? 0,
    accepted: c?.accepted ?? 0,
    sparredRosterIds: c?.sparredRosterIds ?? [],
    contract: c?.contract ?? null,
  };
}

/** Chest a won challenge spar pays, by the player's rank. */
export function challengeChestForRank(rank: number): CrateId {
  if (rank >= 600) return "journeyman";
  if (rank >= 500) return "contender";
  if (rank >= 400) return "elite";
  if (rank >= 200) return "champion";
  if (rank >= 50) return "undisputed";
  return "goat";
}

const randInt = (lo: number, hi: number) => lo + Math.floor(Math.random() * (hi - lo + 1));

/**
 * Rolls one request per advanced week (expiring old ones first). Math.random,
 * never the seeded week rng, so existing seeded schedules stay put.
 */
export function rollChallengeWeeks(
  state: ChallengeState,
  rs: CareerRosterState,
  fromWeek: number,
  toWeek: number,
  playerWins: number,
  playerLevel: number,
): ChallengeState {
  let requests = [...state.requests];
  let received = state.received;
  const champBeaten = rs.roster.some(f => f.id === CHAMP_ID && f.beatenByPlayer);
  const steps = Math.min(toWeek - fromWeek, 52);
  for (let i = 1; i <= steps; i++) {
    const week = toWeek - steps + i;
    requests = requests.filter(r => r.expiresWeek >= week);
    if (playerWins < MIN_WINS || requests.length >= MAX_CHALLENGE_REQUESTS) continue;
    let chance = BASE_CHANCE + CHANCE_PER_WIN * playerWins;
    if ((rs.playerRank ?? 999) <= 25 && !champBeaten) chance *= 0.1;
    if (Math.random() >= chance) continue;
    const taken = new Set([CHAMP_ID, rs.selectedOpponentId, state.contract?.rosterId, ...requests.map(r => r.rosterId)]);
    const pool = rs.roster.filter(f => f.active && !f.retired && !taken.has(f.id));
    if (pool.length === 0) continue;
    // Bout requests come from the player's viewable ranking range: anyone a
    // Select Opponent reroll could show.
    const pRank = rs.playerRank ?? 999;
    const reach = (rs.expandedOpponentBoardUnlocked || playerWins >= EXPANDED_BOARD_WINS) ? REROLL_REACH_EXPANDED : REROLL_REACH;
    const inRange = pool.filter(f => f.rank > 0 && f.rank >= pRank - reach && f.rank <= pRank + REROLL_REACH);
    // The requested week is 1-8 weeks out and never a week the player fights;
    // with a fight booked it falls after that one, so the contract can follow it.
    const booked = bookedFightWeek(rs);
    const busy = new Set([booked, state.contract?.fightWeek]);
    const weekOpts = [1, 2, 3, 4, 5, 6, 7, 8].map(w => week + w).filter(w => !busy.has(w) && (booked == null || w > booked));
    let kind: ChallengeRequest["kind"] = Math.random() < FIGHT_SHARE ? "fight" : "spar";
    if (kind === "fight" && (inRange.length === 0 || weekOpts.length === 0)) kind = "spar";
    if (kind === "fight") {
      const f = inRange[Math.floor(Math.random() * inRange.length)];
      const fightWeek = weekOpts[Math.floor(Math.random() * weekOpts.length)];
      requests.push({
        id: `${week}-${f.id}-${Math.floor(Math.random() * 1e6)}`,
        rosterId: f.id,
        kind,
        level: f.level,
        receivedWeek: week,
        expiresWeek: Math.min(week + randInt(2, 16), fightWeek - 1),
        fightWeek,
      });
      received++;
      continue;
    }
    const inBand = pool.filter(f => f.level >= playerLevel + 2 && f.level <= playerLevel + 5);
    const src = inBand.length ? inBand : pool;
    const f = src[Math.floor(Math.random() * src.length)];
    requests.push({
      id: `${week}-${f.id}-${Math.floor(Math.random() * 1e6)}`,
      rosterId: f.id,
      kind,
      level: playerLevel + randInt(2, 5),
      receivedWeek: week,
      expiresWeek: week + randInt(2, 16),
    });
    received++;
  }
  return { ...state, requests, received, rev: state.rev + 1 };
}

/** Save-funnel reconcile: keep the newest copy, then roll any advanced weeks. */
export function reconcileChallengeState(
  incoming: CareerRosterState,
  saved: CareerRosterState | null | undefined,
  playerWins: number,
  playerLevel: number,
): CareerRosterState {
  const savedWeek = saved?.weekNumber ?? incoming.weekNumber;
  // A rewound week is a fresh career on the same record: take the incoming copy as is.
  if (incoming.weekNumber < savedWeek) return incoming;
  const inC = incoming.challengeState, svC = saved?.challengeState;
  let state = (svC && (!inC || svC.rev > inC.rev)) ? svC : inC;
  if (incoming.weekNumber > savedWeek) {
    state = rollChallengeWeeks(challengeStateOf({ ...incoming, challengeState: state }), incoming, savedWeek, incoming.weekNumber, playerWins, playerLevel);
  }
  // An accepted bout request becomes the booked fight as soon as nothing else
  // is booked. Re-run on every write so a stale blob can't drop it; it clears
  // once its bout has been fought (fight count moved on) or its week passed.
  const k = state?.contract;
  if (k) {
    const fights = incoming.careerFightsCompleted ?? 0;
    if (fights > k.bookAfterFights || incoming.weekNumber > k.fightWeek) {
      state = { ...challengeStateOf({ ...incoming, challengeState: state }), contract: null, rev: (state?.rev ?? 0) + 1 };
    } else if (incoming.selectedOpponentId == null) {
      return {
        ...incoming,
        selectedOpponentId: k.rosterId,
        scoutedOpponentIds: Array.from(new Set([...(incoming.scoutedOpponentIds ?? []), k.rosterId])),
        prepWeeksRemaining: k.fightWeek - incoming.weekNumber,
        negotiationAttemptsUsed: 0,
        doghouseUsedThisCamp: false,
        nightmareUsesThisCamp: 0,
        challengeState: k.bookAfterFights === fights ? state : { ...state!, contract: { ...k, bookAfterFights: fights }, rev: state!.rev + 1 },
      };
    }
  }
  return state === inC ? incoming : { ...incoming, challengeState: state };
}

/** Applies `fn` to the freshest saved challenge state and bumps rev. */
export function nextChallengeState(rs: CareerRosterState | null | undefined, fn: (c: ChallengeState) => ChallengeState): ChallengeState {
  const c = fn(challengeStateOf(rs));
  return { ...c, rev: challengeStateOf(rs).rev + 1 };
}
