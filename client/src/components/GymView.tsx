import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { CareerRosterState, Fighter, SkillPoints } from "@shared/schema";
import { ShoppingBag, Zap } from "lucide-react";
import LockerView from "@/components/LockerView";
import ItemStoreView from "@/components/ItemStoreView";
import ActiveBoostsHud from "@/components/ActiveBoostsHud";
import { hasUnseenItems, markItemsSeen } from "@/lib/itemInventory";
import { getGymIncomeMult, hasPerk } from "@/game/itemEffects";
import { clampPassiveClock } from "@/game/gymIncome";
import { diamondLevelUpCost } from "@/game/diamondLevelCost";
import { isEquipmentCrateUnlocked, pendingEquipmentUnlocks } from "@/game/equipmentConfig";
import { equipmentCareerWins } from "@/lib/equipmentUpgrades";
import RefinementProgressMeter from "@/components/RefinementProgressMeter";
import PunchEnduranceMeter from "@/components/PunchEnduranceMeter";
import DefensiveMasteryMeter from "@/components/DefensiveMasteryMeter";
import PurePowerMeter from "@/components/PurePowerMeter";
import DailyRewardBadge from "@/components/DailyRewardBadge";
import * as localSaves from "@/lib/localSaves";
import { createInitialState, startFight, updateGame } from "@/game/engine";
import { useEnterKey, ENTER_PRIORITY } from "@/hooks/useEnterKey";
import { FightScene3D } from "@/game/three/FightScene3D";
import { setGymDressing, setGymLook } from "@/game/three/gym3d";
import EditGymPanel from "@/components/EditGymPanel";
import { GYM_RENAME_FORCE, type GymLook, gymLookOf } from "@/game/gymLook";
import { ChevronLeft } from "lucide-react";
import { GYM_PLAYER_PX, gymZoneAnchor, pickGymZone, projectGymPoint } from "@/game/three/gymLayout";
import { ringColorsOf } from "@/game/ringColors";
import type { GameState, FighterColors } from "@/game/types";
import { type Archetype, SKIN_COLOR_PRESETS } from "@/game/types";

// ==================== CONSTANTS ====================
const CW = 800;
const CH = 600;
const GYM_LS_KEY = "handz_gym_state";
/** How often standing in the gym banks what the equipment has produced. */
const PASSIVE_TICK_MS = 10_000;
/** Seconds the pointer must rest on the ring before the camera pans to it. */
const RING_DWELL_S = 1;
/** Seconds the home ↔ ring camera pan takes. */
const RING_PAN_S = 0.9;

const BASE_FPH = { ring: 450, weightRack: 300, heavyBag: 120 } as const;
const BASE_UPGRADE_COST = { ring: 1500, weightRack: 1000, heavyBag: 400 } as const;

// ==================== TYPES ====================
interface GymItemState { level: number; }
interface GymState {
  ring: GymItemState;
  weightRack: GymItemState;
  heavyBag1: GymItemState;
  heavyBag2: GymItemState;
  heavyBag3: GymItemState;
  lastUpdate: number;
}
type GymZone = "ring" | "weights" | "bag1" | "bag2" | "bag3" | "lockers" | "door" | "trophyA" | "trophyB" | "office" | "player" | "equipCrate";

export interface GymWeeklyBonus {
  trainingType: string;
  bonusType: string;
  value: number;
}

export interface GymViewProps {
  fighter: Fighter;
  playerColors: FighterColors;
  playerRank: number | null;
  weeklyBonus: GymWeeklyBonus | null;
  trainingLocked: boolean;
  trainingLockReason?: "fightWeek" | "weeklyLimit";
  refinementSpent: number;
  refinementUnlocked: boolean;
  /** Refinement just unlocked and the case has never been opened — shows a red dot. */
  refinementUnseen?: boolean;
  /** Opens the Equipment Upgrades page from the gym crate. */
  onOpenEquipment: () => void;
  onExit: () => void;
  onOpenPlanner: () => void;
  onOpenStats: () => void;
  onOpenRefinements: () => void;
  onOpenEditColors: () => void;
  onOpenEditRingColors: () => void;
  onLevelUp: () => void;
  /**
   * "available" — the free weekly sweep is unspent.
   * "paid" — free sweep spent, but it's the back half of the week, so another
   *          sweep can be bought for PAID_SWEEP_SHARD_COST shards.
   * "used" / "notCamp" — no sweep possible.
   */
  sweepStatus: "available" | "paid" | "notCamp" | "used";
  onSweep: (type: "weightLifting" | "heavyBag") => void;
  onStartSparring: () => void;
  onStartWeightLifting: () => void;
  onStartBagWork: () => void;
  /** Unscored 60-second bag session; open even when training is locked. */
  onStartFreeBag?: () => void;
  /** Fight week only: walk straight out to the scheduled bout from the gym. */
  onFightNow?: () => void;
  onForceChange: (delta: number) => void;
  /** Credit Limit Increase — trade FORCE_PER_DIAMOND Force for 1 Diamond. */
  onForceToDiamond?: () => void;
  /** Roster state, so week/camp-scoped item boosts resolve correctly. */
  roster?: CareerRosterState | null;
  /**
   * Midnight passed with the gym open — the daily chests are due again. The
   * parent owns the claim; the HUD badge only spots the rollover.
   */
  onDailyRewardDue?: () => void;
  /**
   * Called with the freshly persisted save after the Locker sells or arms an
   * item, so the parent can replace its snapshot. Without this the next
   * activity is started from a fighter whose inventory predates the change.
   */
  onFighterChanged?: (fighter: Fighter) => void;
  overlayBanner?: React.ReactNode;
}

/** Credit Limit Increase exchange rate. */
export const FORCE_PER_DIAMOND = 500_000;

/**
 * Shard price of a second sweep in the same week. Only ever charged in the
 * back half of the week — in the front half the free weekly sweep covers it.
 */
export const PAID_SWEEP_SHARD_COST = 20_000;


// ==================== FORMULAS ====================
function fph(base: number, level: number): number {
  return Math.round(base * Math.pow(1.2, level - 1) * 10) / 10;
}
function upgradeCostFor(baseCost: number, currentLevel: number): number {
  return Math.round(baseCost * Math.pow(1.25, currentLevel - 1));
}

// ==================== LOCAL STORAGE ====================
function getDefaultGymState(): GymState {
  return { ring: { level: 1 }, weightRack: { level: 1 }, heavyBag1: { level: 1 }, heavyBag2: { level: 1 }, heavyBag3: { level: 1 }, lastUpdate: Date.now() };
}
function loadGymState(): GymState {
  try {
    const raw = localStorage.getItem(GYM_LS_KEY);
    if (!raw) return getDefaultGymState();
    const s = JSON.parse(raw) as Partial<GymState>;
    return {
      ring: s.ring ?? { level: 1 }, weightRack: s.weightRack ?? { level: 1 },
      heavyBag1: s.heavyBag1 ?? { level: 1 }, heavyBag2: s.heavyBag2 ?? { level: 1 },
      heavyBag3: s.heavyBag3 ?? { level: 1 }, lastUpdate: s.lastUpdate ?? Date.now(),
    };
  } catch { return getDefaultGymState(); }
}
function saveGymState(s: GymState): void {
  localStorage.setItem(GYM_LS_KEY, JSON.stringify(s));
}

// ==================== TROPHIES & MEDALS ====================
// 1 trophy per 3 career wins (random case, spills over when one is full, 30/case).
// 1 medal per 20 refinement points spent (same rules, 40/case). Persisted per save.
interface TrophyState {
  winsCredited: number;
  refCredited: number;
  aTrophies: number;
  bTrophies: number;
  aMedals: number;
  bMedals: number;
}
const TROPHY_CAP = 30;
const MEDAL_CAP = 40;
function defaultTrophyState(): TrophyState {
  return { winsCredited: 0, refCredited: 0, aTrophies: 0, bTrophies: 0, aMedals: 0, bMedals: 0 };
}
function trophyKey(fighterId: string): string { return `handz_trophies_${fighterId}`; }
function loadTrophyState(fighterId: string): TrophyState {
  try {
    const raw = localStorage.getItem(trophyKey(fighterId));
    if (!raw) return defaultTrophyState();
    return { ...defaultTrophyState(), ...(JSON.parse(raw) as Partial<TrophyState>) };
  } catch { return defaultTrophyState(); }
}
function reconcileTrophyState(fighterId: string, wins: number, refSpent: number): TrophyState {
  const s = loadTrophyState(fighterId);
  let changed = false;
  while (s.winsCredited + 3 <= wins) {
    s.winsCredited += 3;
    changed = true;
    const aFull = s.aTrophies >= TROPHY_CAP, bFull = s.bTrophies >= TROPHY_CAP;
    if (aFull && bFull) continue;
    const toA = aFull ? false : bFull ? true : Math.random() < 0.5;
    if (toA) s.aTrophies++; else s.bTrophies++;
  }
  while (s.refCredited + 20 <= refSpent) {
    s.refCredited += 20;
    changed = true;
    const aFull = s.aMedals >= MEDAL_CAP, bFull = s.bMedals >= MEDAL_CAP;
    if (aFull && bFull) continue;
    const toA = aFull ? false : bFull ? true : Math.random() < 0.5;
    if (toA) s.aMedals++; else s.bMedals++;
  }
  if (changed) localStorage.setItem(trophyKey(fighterId), JSON.stringify(s));
  return s;
}

// ==================== GYM FIGHT (CPU VS CPU) ====================
const GYM_ARCHETYPES: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];

const GYM_GLOVE_COLORS = ["#cc2222","#1155cc","#22aa44","#cc8800","#aa22aa","#cc4411","#116688","#880011","#226622","#555555"];
const GYM_TRUNK_COLORS = ["#2244aa","#222222","#aa2222","#225522","#884400","#441188","#113355","#663322","#1a1a4a","#334433"];
const GYM_SOCK_COLORS  = ["#f0f0f0","#e6e6e6","#111111","#cc2222","#1155cc","#ddaa00"];
const GYM_SHOE_COLORS  = ["#1a1a1a","#2a1a1a","#ffffff","#cc2222","#1155cc","#333300","#2a2a2a","#111111","#442200","#003322"];

function randomGymColors(): FighterColors {
  const pick = <T,>(arr: T[]) => arr[Math.floor(Math.random() * arr.length)];
  return {
    skin: pick(SKIN_COLOR_PRESETS),
    gloves: pick(GYM_GLOVE_COLORS),
    gloveTape: Math.random() < 0.5 ? "#eeeeee" : "#dddddd",
    trunks: pick(GYM_TRUNK_COLORS),
    shoes: pick(GYM_SHOE_COLORS),
    socks: pick(GYM_SOCK_COLORS),
  };
}

function makeGymFight(): GameState {
  const a1 = GYM_ARCHETYPES[Math.floor(Math.random() * GYM_ARCHETYPES.length)];
  const a2 = GYM_ARCHETYPES[Math.floor(Math.random() * GYM_ARCHETYPES.length)];
  const gs = startFight(
    createInitialState(), a1,
    40, 40,
    "RED", randomGymColors(),
    true, "contender",
    1, 55,
    "normal",
    65, 65,
    a2, "BLUE",
    undefined,
    false, false, false, false,
    true,       // cpuVsCpu
    randomGymColors(),  // overrideEnemyColors
    true,       // sparringMode — gym environment: wood floor, no crowd
  );
  gs.menuBackground = true;
  gs.staticCamera = true; // fixed fully-zoomed-out camera
  return gs;
}

// ==================== MAIN COMPONENT ====================
export default function GymView({
  fighter, playerColors, playerRank, weeklyBonus, trainingLocked, trainingLockReason, refinementSpent, refinementUnlocked, refinementUnseen,
  onExit, onOpenPlanner, onOpenStats, onOpenRefinements, onOpenEquipment, onOpenEditColors, onOpenEditRingColors, onLevelUp, sweepStatus, onSweep,
  onStartSparring, onStartWeightLifting, onStartBagWork, onStartFreeBag, onFightNow, onForceChange,
  onForceToDiamond, roster, overlayBanner, onFighterChanged, onDailyRewardDue,
}: GymViewProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const hoveredRef = useRef<GymZone | null>(null);
  const gymRef = useRef<GymState>(loadGymState());
  const gymFightRef = useRef<GameState | null>(null);
  const fightIdleTimerRef = useRef<number>(0); // counts up while fight is not active
  const lastFrameTimeRef = useRef<number>(0);
  const trophyRef = useRef<TrophyState>(defaultTrophyState());
  const playerColorsRef = useRef<FighterColors>(playerColors);
  playerColorsRef.current = playerColors;

  // The gym is a WebGL scene under a transparent 2D canvas that keeps the
  // mouse handling.
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<FightScene3D | null>(null);
  // The idle player's own fabricated state (never the sparring sim's).
  const idleStateRef = useRef<GameState | null>(null);

  // Equipment Upgrades: the crate's lid, hover label and click all key off the
  // player's career wins.
  const equipWins = equipmentCareerWins(fighter);
  const equipUnlocked = isEquipmentCrateUnlocked(equipWins);
  const equipUnlockedRef = useRef(equipUnlocked);
  equipUnlockedRef.current = equipUnlocked;
  const equipPending = pendingEquipmentUnlocks(equipWins, roster?.equipmentSeenSlots ?? undefined);

  const [gymState, setGymState] = useState<GymState>(() => { const s=loadGymState(); gymRef.current=s; return s; });
  const [hoveredZone, setHoveredZone] = useState<GymZone | null>(null);
  const [popup, setPopup] = useState<{ zone: GymZone; x: number; y: number } | null>(null);
  const [confirmingLevelUp, setConfirmingLevelUp] = useState(false);
  const [confirmingSweep, setConfirmingSweep] = useState(false);
  useEffect(() => { setConfirmingLevelUp(false); setConfirmingSweep(false); }, [popup]);
  const [currentForce, setCurrentForce] = useState<number>(fighter.force ?? 0);
  const [earnedOnEnter, setEarnedOnEnter] = useState<number>(0);
  const [convertOpen, setConvertOpen] = useState(false);
  const [confirmDiamond, setConfirmDiamond] = useState(false);
  useEffect(() => { if (!convertOpen) setConfirmDiamond(false); }, [convertOpen]);
  const [lockerOpen, setLockerOpen] = useState(false);
  const [storeOpen, setStoreOpen] = useState(false);
  // Red dot over the lockers while the save holds items the player hasn't seen.
  // Read from the stored save — the in-memory fighter prop can be stale on slot load.
  const [unseenItems, setUnseenItems] = useState<boolean>(() => hasUnseenItems(localSaves.getFighter(fighter.id)));
  const openLocker = useCallback(() => {
    // The unseen ids survive the whole visit so the Locker can flag each new item;
    // they're cleared on close (see closeLocker), which also drops the red dot.
    setLockerOpen(true);
  }, []);
  const closeLocker = useCallback(() => {
    setLockerOpen(false);
    markItemsSeen(fighter.id);
    setUnseenItems(false);
  }, [fighter.id]);
  // Shards live on the stored save — the in-memory fighter prop can be stale on slot load.
  const [currentShards, setCurrentShards] = useState<number>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem("handz_saves") || "[]").find((f: { id: string }) => f.id === fighter.id);
      return saved?.shards ?? fighter.shards ?? 0;
    } catch { return fighter.shards ?? 0; }
  });
  const currentForceRef = useRef<number>(fighter.force ?? 0);

  useEffect(() => { currentForceRef.current = currentForce; }, [currentForce]);
  useEffect(() => { setCurrentForce(fighter.force ?? 0); }, [fighter.force]);
  // A paid sweep debits shards through the parent, so follow the prop back down.
  useEffect(() => { setCurrentShards(fighter.shards ?? 0); }, [fighter.shards]);


  // Re-check for new items whenever the save changes under us (e.g. a crate
  // granted by the fight the player just came back from).
  useEffect(() => {
    if (lockerOpen) return;
    setUnseenItems(hasUnseenItems(localSaves.getFighter(fighter.id)));
  }, [fighter.id, fighter.wins, fighter.careerBoutIndex, lockerOpen]);

  // Credit trophies (per 3 wins) and medals (per 20 refinement points spent)
  useEffect(() => {
    trophyRef.current = reconcileTrophyState(fighter.id, fighter.wins ?? 0, refinementSpent);
  }, [fighter.id, fighter.wins, refinementSpent]);

  // The 3D cases and crate (home screen and sparring) read this snapshot.
  useEffect(() => {
    const t = trophyRef.current;
    const wins = fighter.wins ?? 0;
    const fights = wins + (fighter.losses ?? 0) + (fighter.draws ?? 0);
    setGymDressing({
      aTrophies: t.aTrophies, aMedals: t.aMedals, bTrophies: t.bTrophies, bMedals: t.bMedals, crateUnlocked: equipUnlocked,
      goldGloves: [wins >= 100, fights >= 300, fights >= 500],
    });
  }, [fighter.id, fighter.wins, fighter.losses, fighter.draws, refinementSpent, equipUnlocked]);

  useEffect(() => {
    const gl = glCanvasRef.current;
    if (!gl) return;
    let scene: FightScene3D;
    try {
      scene = new FightScene3D(gl);
    } catch (err) {
      console.error("[3D] gym view unavailable", err);
      return;
    }
    sceneRef.current = scene;
    const idle = makeGymFight();
    idle.sparringMode = false; // no headgear on the fighter idling by the bench
    idle.player.x = GYM_PLAYER_PX.x;
    idle.player.z = GYM_PLAYER_PX.z;
    idle.player.facingAngle = GYM_PLAYER_PX.facing;
    idle.player.rhythmLevel = 0;
    idle.player.swayOffset = 0;
    idleStateRef.current = idle;
    return () => {
      sceneRef.current = null;
      idleStateRef.current = null;
      scene.dispose();
    };
  }, []);

  // Fight week: no sparring in the ring, gym goes dark (night), monitor glows white
  const isFightWeek = trainingLockReason === "fightWeek";
  const [fightConfirmOpen, setFightConfirmOpen] = useState(false);
  useEnterKey(() => { setFightConfirmOpen(false); onFightNow?.(); }, { enabled: fightConfirmOpen && !!onFightNow, priority: ENTER_PRIORITY.milestone });
  const isFightWeekRef = useRef(isFightWeek);
  isFightWeekRef.current = isFightWeek;

  // Null until the player saves a palette, so an untouched career keeps the
  // stock ring (and its per-bout colour variety) exactly as before.
  const ringPalette = useMemo(
    () => (fighter.ringColors ? ringColorsOf(fighter) : null),
    [fighter],
  );
  const ringPaletteRef = useRef(ringPalette);
  ringPaletteRef.current = ringPalette;

  // Gym customisation (walls, name, theme, bags). The 3D gym reads a
  // module-level snapshot so sparring bouts wear it too; Edit Gym previews
  // its draft through the same snapshot and restores the saved look on close.
  // Read from the stored save (bumped on every write) so a stale fighter prop
  // can never show — or later save back — an older look.
  const [lookVersion, setLookVersion] = useState(0);
  const savedLook = useMemo(() => gymLookOf(localSaves.getFighter(fighter.id) ?? fighter), [fighter, lookVersion]);
  const [editGymOpen, setEditGymOpen] = useState(false);
  const editGymOpenRef = useRef(false);
  editGymOpenRef.current = editGymOpen;
  useEffect(() => { if (!editGymOpen) setGymLook(savedLook); }, [savedLook, editGymOpen]);
  const previewLook = useCallback((l: GymLook) => setGymLook(l), []);

  // Ring view: resting the pointer on the ring for RING_DWELL_S pans the
  // camera ringside; the back arrow returns. After returning, the pointer has
  // to leave the ring before another dwell can start.
  const [ringViewOpen, setRingViewOpen] = useState(false);
  const ringViewOpenRef = useRef(false);
  ringViewOpenRef.current = ringViewOpen;
  const ringDwellRef = useRef(0);
  const ringArmedRef = useRef(true);
  const ringPanRef = useRef(0); // 0 = home, 1 = ringside (linear progress)
  const popupOpenRef = useRef(false);

  // Init background CPU fight on mount (fight week: empty ring — fighters parked
  // far off-screen and the sim never runs, so only the gym scene renders)
  useEffect(() => {
    const gs = makeGymFight();
    if (isFightWeekRef.current) {
      gs.player.x = -9999;
      gs.enemy.x = -9999;
      gs.refereeVisible = false;
    }
    gymFightRef.current = gs;
    fightIdleTimerRef.current = 0;
  }, []);

  // The props these use change identity between renders, but the income timer
  // below must not be torn down and rebuilt for that — it reads them by ref.
  const onForceChangeRef = useRef(onForceChange);
  useEffect(() => { onForceChangeRef.current = onForceChange; }, [onForceChange]);
  const fighterRef = useRef(fighter);
  useEffect(() => { fighterRef.current = fighter; }, [fighter]);

  /**
   * Bank the Force the equipment has produced since `lastUpdate` and return it.
   *
   * The clock only ever moves forward by time that was actually paid out: the
   * sub-1-Force remainder is left on the clock rather than discarded, so short
   * visits accumulate instead of each one flooring to zero. The 2-day cap on
   * idle growth, and any clock reading from the future, are handled by
   * clampPassiveClock before any of this.
   */
  const creditPassiveIncome = useCallback((): number => {
    const state = gymRef.current;
    const now = Date.now();
    const elapsed = (now - clampPassiveClock(state.lastUpdate, now)) / 3_600_000;
    let earned = 0;
    let carryHours = 0;
    if (elapsed > 0) {
      const perHour = (fph(BASE_FPH.ring, state.ring.level)
        + fph(BASE_FPH.weightRack, state.weightRack.level)
        + fph(BASE_FPH.heavyBag, state.heavyBag1.level)
        + fph(BASE_FPH.heavyBag, state.heavyBag2.level)
        + fph(BASE_FPH.heavyBag, state.heavyBag3.level))
        // An armed AC boost multiplies passive income for its 24h window. The
        // save is the source of truth — the prop can be stale on slot load.
        * getGymIncomeMult(localSaves.getFighter(fighterRef.current.id) ?? fighterRef.current, now);
      const exact = perHour * elapsed;
      earned = Math.floor(exact);
      if (perHour > 0) carryHours = (exact - earned) / perHour;
    }
    const updated = { ...state, lastUpdate: now - carryHours * 3_600_000 };
    gymRef.current = updated;
    setGymState(updated);
    saveGymState(updated);
    if (earned > 0) {
      onForceChangeRef.current(earned);
      setCurrentForce(prev => prev + earned);
    }
    return earned;
  }, []);

  // Income earned while away, banked on arrival — the banner auto-dismisses.
  useEffect(() => {
    const earned = creditPassiveIncome();
    if (earned <= 0) return;
    setEarnedOnEnter(earned);
    const timer = setTimeout(() => setEarnedOnEnter(0), 3000);
    return () => clearTimeout(timer);
  }, [creditPassiveIncome]);

  // …and it keeps coming in while the gym is open, so the balance visibly ticks
  // up instead of only moving when the screen is re-entered.
  useEffect(() => {
    const tick = window.setInterval(() => { creditPassiveIncome(); }, PASSIVE_TICK_MS);
    return () => window.clearInterval(tick);
  }, [creditPassiveIncome]);

  // Main render + fight loop
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const maybeCtx = canvas.getContext("2d"); if (!maybeCtx) return;
    const ctx: CanvasRenderingContext2D = maybeCtx;
    let running = true;

    function loop(now: number) {
      if (!running) return;
      const dt = Math.min(0.05, (now - (lastFrameTimeRef.current || now)) / 1000);
      lastFrameTimeRef.current = now;

      const fightWeek = isFightWeekRef.current;
      let gs = gymFightRef.current;
      if (gs) {
        if (fightWeek) {
          // Empty ring — no sparring sim on fight week
        } else if (gs.phase === "prefight" || gs.phase === "fighting") {
          gs = updateGame(gs, dt);
          if (gs.isPaused) gs.isPaused = false; // don't pause background fight
          gymFightRef.current = gs;
          fightIdleTimerRef.current = 0;
        } else {
          // Fight ended or in countdown/roundEnd — wait 3s then restart
          fightIdleTimerRef.current += dt;
          if (fightIdleTimerRef.current >= 3) {
            gs = makeGymFight();
            gymFightRef.current = gs;
            fightIdleTimerRef.current = 0;
          }
        }
        // Re-applied every frame, not just at fight creation: the sparring bout
        // restarts every 3s and startFight rerolls a random canvas colour each
        // time. A saved palette outranks that roll, and a palette saved while
        // the gym is open takes hold on the next frame.
        gs.ringColors = ringPaletteRef.current ?? undefined;
        const scene = sceneRef.current;
        if (scene) {
          const idle = idleStateRef.current;
          if (idle) idle.player.bobPhase = ((idle.player.bobPhase || 0) + dt * 2.6 * Math.PI * 2) % (Math.PI * 2);
          if (hoveredRef.current === "ring") {
            if (!ringViewOpenRef.current && ringArmedRef.current && !fightWeek && !popupOpenRef.current && !editGymOpenRef.current) {
              ringDwellRef.current += dt;
              if (ringDwellRef.current >= RING_DWELL_S) {
                ringDwellRef.current = 0;
                ringViewOpenRef.current = true;
                setRingViewOpen(true);
              }
            }
          } else {
            ringDwellRef.current = 0;
            ringArmedRef.current = true;
          }
          const panTarget = ringViewOpenRef.current ? 1 : 0;
          const panStep = dt / RING_PAN_S;
          ringPanRef.current = panTarget > ringPanRef.current
            ? Math.min(panTarget, ringPanRef.current + panStep)
            : Math.max(panTarget, ringPanRef.current - panStep);
          const p = ringPanRef.current;
          scene.render(gs, {
            gymHome: {
              hovered: hoveredRef.current,
              night: fightWeek,
              idle: idle ? { fighter: idle.player, state: idle, colors: playerColorsRef.current } : null,
              hideFighters: fightWeek,
              ringView: p * p * (3 - 2 * p),
            },
          });
          // The home camera drifts, so the floating tags and dots follow it
          // every frame instead of only on React renders.
          const host = canvasRef.current?.parentElement;
          if (host) {
            host.querySelectorAll<HTMLElement>("[data-gym-anchor]").forEach(el => {
              const p = projectGymPoint(gymZoneAnchor(el.dataset.gymAnchor as GymZone), scene.homeCamera);
              el.style.left = `${(p.x / CW) * 100}%`;
              el.style.top = `${((p.y - Number(el.dataset.gymLift || 0)) / CH) * 100}%`;
            });
          }
        }
      }
      ctx.clearRect(0, 0, CW, CH);
      rafRef.current = requestAnimationFrame(loop);
    }

    rafRef.current = requestAnimationFrame(loop);
    return () => { running = false; cancelAnimationFrame(rafRef.current); };
  }, []);

  const getCanvasXY = (e: React.MouseEvent<HTMLCanvasElement>): [number, number] => {
    const c = canvasRef.current; if (!c) return [0, 0];
    const r = c.getBoundingClientRect();
    return [(e.clientX - r.left) * (CW / r.width), (e.clientY - r.top) * (CH / r.height)];
  };

  const handleMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const [mx, my] = getCanvasXY(e);
    const zone = sceneRef.current ? pickGymZone(mx, my, sceneRef.current.homeCamera) : null;
    hoveredRef.current = zone;
    setHoveredZone(zone);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const closeRingView = useCallback(() => {
    ringViewOpenRef.current = false;
    ringArmedRef.current = false;
    ringDwellRef.current = 0;
    setRingViewOpen(false);
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (editGymOpenRef.current) return;
    if (popup) { setPopup(null); return; }
    const zone = hoveredRef.current;
    if (!zone) return;
    if (zone === "door") { onExit(); return; }
    if (zone === "trophyA") { onOpenStats(); return; }
    if (zone === "lockers") { openLocker(); return; }
    if (zone === "trophyB") {
      if (refinementUnlocked) onOpenRefinements();
      else setPopup({ zone, x: e.clientX, y: e.clientY });
      return;
    }
    // A padlocked crate says so on hover and does nothing on click.
    if (zone === "equipCrate" && !equipUnlockedRef.current) return;
    setPopup({ zone, x: e.clientX, y: e.clientY });
  }, [popup, onExit, onOpenPlanner, onOpenStats, onOpenRefinements, refinementUnlocked, openLocker]);

  useEffect(() => { popupOpenRef.current = popup !== null; }, [popup]);

  // ── Edit Gym purchases: priced off the stored save, never the prop ──
  const syncFromSave = useCallback((f: Fighter) => {
    setCurrentForce(f.force ?? 0);
    currentForceRef.current = f.force ?? 0;
    onFighterChanged?.(f);
  }, [onFighterChanged]);
  const saveGymLookPatch = useCallback((patch: GymLook, cost?: { force?: number }): boolean => {
    const fresh = localSaves.getFighter(fighter.id) ?? fighter;
    const data: Parameters<typeof localSaves.updateFighter>[1] = { gymLook: { ...gymLookOf(fresh), ...patch } as Record<string, string> };
    if (cost?.force) {
      const bal = fresh.force ?? 0;
      if (bal < cost.force) return false;
      data.force = bal - cost.force;
    }
    const updated = localSaves.updateFighter(fighter.id, data);
    if (!updated) return false;
    setLookVersion(v => v + 1);
    syncFromSave(updated);
    return true;
  }, [fighter, syncFromSave]);

  const handleUpgrade = useCallback((itemKey: keyof Omit<GymState, "lastUpdate">, baseCost: number) => {
    const gs = gymRef.current;
    const item = gs[itemKey] as GymItemState;
    if (item.level >= 500) return;
    const cost = upgradeCostFor(baseCost, item.level);
    if (currentForceRef.current < cost) return;
    const newState = { ...gs, [itemKey]: { level: item.level + 1 } };
    gymRef.current = newState;
    setGymState(newState);
    saveGymState(newState);
    onForceChange(-cost);
    // The panel stays open on its new level and price so the player can buy
    // again — so the ref has to drop synchronously. Waiting for the state
    // effect would let a second click inside the same frame spend Force the
    // fighter no longer has.
    currentForceRef.current = Math.max(0, currentForceRef.current - cost);
    setCurrentForce(prev => Math.max(0, prev - cost));
  }, [onForceChange]);

  const acIncomeMult = getGymIncomeMult(fighter);
  const totalFPH = (fph(BASE_FPH.ring, gymState.ring.level)
    + fph(BASE_FPH.weightRack, gymState.weightRack.level)
    + fph(BASE_FPH.heavyBag, gymState.heavyBag1.level)
    + fph(BASE_FPH.heavyBag, gymState.heavyBag2.level)
    + fph(BASE_FPH.heavyBag, gymState.heavyBag3.level)) * acIncomeMult;
  const canConvertDiamonds = hasPerk(fighter, "diamondConversion", roster);

  const displayName = [fighter.firstName, fighter.nickname ? `"${fighter.nickname}"` : "", fighter.lastName]
    .filter(Boolean).join(" ") || fighter.name;
  const recordStr = `${fighter.wins ?? 0}-${fighter.losses ?? 0}${(fighter.draws ?? 0) > 0 ? `-${fighter.draws}` : ""}`;
  const statLine = (fighter.skillPoints ?? { power: 0, speed: 0, defense: 0, stamina: 0, focus: 0 }) as SkillPoints;

  const bonusFor = (zone: GymZone): string | null => {
    if (!weeklyBonus) return null;
    const tag = weeklyBonus.bonusType === "xp" ? "+XP" : "+SP";
    if (zone === "ring" && weeklyBonus.trainingType === "sparring") return tag;
    if (zone === "weights" && weeklyBonus.trainingType === "weightLifting") return tag;
    if ((zone === "bag1" || zone === "bag2" || zone === "bag3") && weeklyBonus.trainingType === "heavyBag") return tag;
    return null;
  };

  const getZoneLabel = (zone: GymZone): string => {
    const ts = trophyRef.current;
    const bonus = bonusFor(zone);
    const bonusSuffix = bonus ? ` — ★ Weekly bonus: ${bonus}` : "";
    if (zone === "ring") return `Sparring Ring — Lv.${gymState.ring.level} — ${fph(BASE_FPH.ring, gymState.ring.level)} Force/HR${bonusSuffix}`;
    if (zone === "weights") return `Weightlifting — Lv.${gymState.weightRack.level} — ${fph(BASE_FPH.weightRack, gymState.weightRack.level)} Force/HR${bonusSuffix}`;
    if (zone === "bag1") return `Heavy Bag — Lv.${gymState.heavyBag1.level} — ${fph(BASE_FPH.heavyBag, gymState.heavyBag1.level)} Force/HR${bonusSuffix}`;
    if (zone === "bag2") return `Heavy Bag — Lv.${gymState.heavyBag2.level} — ${fph(BASE_FPH.heavyBag, gymState.heavyBag2.level)} Force/HR${bonusSuffix}`;
    if (zone === "bag3") return `Heavy Bag — Lv.${gymState.heavyBag3.level} — ${fph(BASE_FPH.heavyBag, gymState.heavyBag3.level)} Force/HR${bonusSuffix}`;
    if (zone === "lockers") return "Lockers — Your Item Locker";
    if (zone === "door") return "Exit Gym — Back to Main Menu";
    if (zone === "trophyA") return `Trophy Case — ${ts.aTrophies} trophies · ${ts.aMedals} medals — Career Stats`;
    if (zone === "trophyB") return refinementUnlocked
      ? `Trophy Case — ${ts.bTrophies} trophies · ${ts.bMedals} medals — Skill Refinement`
      : "Trophy Case — Skill Refinement (unlocks at rank 650)";
    if (zone === "office") return "Office — Fight Planner · Edit Gym";
    if (zone === "equipCrate") return equipUnlocked ? "Equipment Crate — Equipment Upgrades" : "Locked";
    // Stat points live on the permanent strip at the bottom of the screen, so the
    // player's hover label stays short.
    if (zone === "player") return `${displayName} — Lv.${fighter.level} · Rank #${playerRank}`;
    return "";
  };

  // Screen spot (canvas px) for a tag hung over a gym object. The render loop
  // re-places anchored tags each frame (camera drift); this is the first frame.
  const tagPos = (zone: GymZone, liftPx = 0): { x: number; y: number } => {
    const p = projectGymPoint(gymZoneAnchor(zone));
    return { x: p.x, y: p.y - liftPx };
  };
  const anchorAttrs = (zone: GymZone, liftPx = 0) => ({ "data-gym-anchor": zone, "data-gym-lift": String(liftPx) });
  const bonusZone: GymZone | null = weeklyBonus
    ? weeklyBonus.trainingType === "heavyBag" ? "bag1" : weeklyBonus.trainingType === "weightLifting" ? "weights" : "ring"
    : null;
  const bonusTagPos = bonusZone ? tagPos(bonusZone, 4) : null;

  const PopupMenu = () => {
    if (!popup) return null;
    const left = Math.max(4, Math.min(popup.x + 8, window.innerWidth - 215));
    // Taller menus (bag popup in fight camp) sit higher, and scroll rather than
    // run off the bottom of the screen.
    const top = Math.max(4, Math.min(popup.y + 8, window.innerHeight - 320));

    const CanAfford = (cost: number) => currentForce >= cost;
    const btnBase = "w-full text-left rounded px-2.5 py-2 text-xs font-bold transition-colors";
    const btnAction = `${btnBase} text-white bg-[#634b3b] hover:bg-[#7a5c4a] active:opacity-80`;
    const btnUpgrade = (cost: number) => `${btnBase} ${CanAfford(cost) ? "text-yellow-300 bg-yellow-900/50 hover:bg-yellow-800/60" : "text-white/35 bg-white/5 cursor-not-allowed"}`;
    const lockMsg = trainingLockReason === "fightWeek"
      ? "🔒 Fight week — no training. Rest up!"
      : "🔒 Weekly training limit reached (2/2)";
    const LockedNote = () => (
      <div className="text-orange-300/90 text-[10px] bg-orange-950/50 border border-orange-500/25 rounded px-2 py-1.5" data-testid="gym-training-locked">{lockMsg}</div>
    );

    /**
     * Sweep row for a training station. The free weekly sweep is a plain
     * action; once it's spent, the back half of the week offers a shard-priced
     * repeat, greyed out when the player can't cover it.
     */
    const SweepControl = ({ testPrefix }: { testPrefix: string }) => {
      if (sweepStatus === "available") {
        return <button className={btnAction} onClick={() => setConfirmingSweep(true)} data-testid={`${testPrefix}-sweep`}>🧹 Sweep</button>;
      }
      if (sweepStatus === "paid") {
        const affordable = currentShards >= PAID_SWEEP_SHARD_COST;
        return (
          <button
            className={`${btnBase} ${affordable ? "text-sky-300 bg-sky-900/50 hover:bg-sky-800/60" : "text-white/35 bg-white/5 cursor-not-allowed"}`}
            onClick={() => { if (affordable) setConfirmingSweep(true); }}
            data-testid={`${testPrefix}-sweep-paid`}
          >
            🧹 Sweep Again — {PAID_SWEEP_SHARD_COST.toLocaleString()} shards
          </button>
        );
      }
      return (
        <div className="text-white/40 text-[10px] text-center py-1" data-testid={`${testPrefix}-sweep-locked`}>
          🧹 Sweep — {sweepStatus === "used" ? "already used this week" : "fight camp only"}
        </div>
      );
    };

    const RepProgress = ({ fighter: f, activity }: { fighter: Fighter; activity: "weightLifting" | "heavyBag" }) => {
      const tbAny = f.trainingBonuses as { totalTrainingReps?: number; wlTotalReps?: number; hbTotalReps?: number } | null;
      const totalReps = tbAny?.totalTrainingReps || 0;
      const typeReps = (activity === "weightLifting" ? tbAny?.wlTotalReps : tbAny?.hbTotalReps) || 0;
      return (
        <div className="text-white/60 text-[10px] mb-1" data-testid="gym-rep-progress">
          Reps: {totalReps % 50}/50 → ⭐ · {typeReps % 300}/300 → 💎
        </div>
      );
    };

    return (
      <div
        className="fixed bg-[#1a1a1a] border border-white/20 rounded-lg p-3 z-[70] min-w-[195px] shadow-xl space-y-1.5"
        style={{ left, top, maxHeight: `calc(100vh - ${top + 4}px)`, overflowY: "auto" }}
        onClick={e => e.stopPropagation()}
      >
        {popup.zone === "ring" && <>
          <div className="text-white font-bold text-xs">Sparring Ring</div>
          <div className="text-yellow-400 text-[10px] mb-1">Lv.{gymState.ring.level} · {fph(BASE_FPH.ring, gymState.ring.level)} Force/HR</div>
          {trainingLocked ? <LockedNote /> : <button className={btnAction} onClick={() => { setPopup(null); onStartSparring(); }} data-testid="gym-ring-spar">🥊 Spar</button>}
          {gymState.ring.level < 500
            ? <button className={btnUpgrade(upgradeCostFor(BASE_UPGRADE_COST.ring, gymState.ring.level))}
                onClick={() => handleUpgrade("ring", BASE_UPGRADE_COST.ring)} data-testid="gym-ring-upgrade">
                ⬆ Upgrade — {upgradeCostFor(BASE_UPGRADE_COST.ring, gymState.ring.level).toLocaleString()} Force</button>
            : <div className="text-yellow-400 text-xs text-center py-1">★ MAX LEVEL 500</div>}
          <button className={btnAction} onClick={() => { setPopup(null); onOpenEditRingColors(); }} data-testid="gym-ring-colors">🎨 Ring Colors</button>
        </>}

        {popup.zone === "office" && <>
          <div className="text-white font-bold text-xs">Office</div>
          <button className={btnAction} onClick={() => { setPopup(null); onOpenPlanner(); }} data-testid="gym-office-enter">🚪 Enter</button>
          <button className={btnAction} onClick={() => { setPopup(null); closeRingView(); setEditGymOpen(true); }} data-testid="gym-office-edit">🎨 Edit Gym</button>
        </>}

        {popup.zone === "equipCrate" && <>
          <div className="text-white font-bold text-xs">Equipment Crate</div>
          <div className="text-yellow-400 text-[10px] mb-1">Upgrade your gloves, shoes, trunks, mouthguard and wraps</div>
          <button className={btnAction} onClick={() => { setPopup(null); onOpenEquipment(); }} data-testid="gym-equipment-enter">📦 Enter</button>
        </>}

        {popup.zone === "weights" && <>
          <div className="text-white font-bold text-xs">Weightlifting</div>
          <div className="text-yellow-400 text-[10px]">Lv.{gymState.weightRack.level} · {fph(BASE_FPH.weightRack, gymState.weightRack.level)} Force/HR</div>
          <RepProgress fighter={fighter} activity="weightLifting" />
          {confirmingSweep ? <>
            <div className="text-cyan-300 text-[10px] font-bold text-center">
              Sweep Weightlifting?{sweepStatus === "paid" ? ` — ${PAID_SWEEP_SHARD_COST.toLocaleString()} shards` : ""}
            </div>
            <button className={btnAction} onClick={() => { setConfirmingSweep(false); setPopup(null); onSweep("weightLifting"); }} data-testid="gym-weights-sweep-confirm">🧹 Confirm</button>
            <button className={`${btnBase} text-white/60 bg-white/5 hover:bg-white/10`} onClick={() => setConfirmingSweep(false)} data-testid="gym-weights-sweep-cancel">Cancel</button>
          </> : <>
          {gymState.weightRack.level < 500
            ? <button className={btnUpgrade(upgradeCostFor(BASE_UPGRADE_COST.weightRack, gymState.weightRack.level))}
                onClick={() => handleUpgrade("weightRack", BASE_UPGRADE_COST.weightRack)} data-testid="gym-weights-upgrade">
                ⬆ Upgrade — {upgradeCostFor(BASE_UPGRADE_COST.weightRack, gymState.weightRack.level).toLocaleString()} Force</button>
            : <div className="text-yellow-400 text-xs text-center py-1">★ MAX LEVEL 500</div>}
          {trainingLocked ? <LockedNote /> : <button className={btnAction} onClick={() => { setPopup(null); onStartWeightLifting(); }} data-testid="gym-weights-train">💪 Train</button>}
          {!trainingLocked && <SweepControl testPrefix="gym-weights" />}
          </>}
        </>}

        {(popup.zone === "bag1" || popup.zone === "bag2" || popup.zone === "bag3") && (() => {
          const key = popup.zone === "bag1" ? "heavyBag1" : popup.zone === "bag2" ? "heavyBag2" : "heavyBag3";
          const level = (gymState[key as keyof typeof gymState] as GymItemState).level;
          const cost = upgradeCostFor(BASE_UPGRADE_COST.heavyBag, level);
          return <>
            <div className="text-white font-bold text-xs">Heavy Bag</div>
            <div className="text-yellow-400 text-[10px]">Lv.{level} · {fph(BASE_FPH.heavyBag, level)} Force/HR</div>
            <RepProgress fighter={fighter} activity="heavyBag" />
            {confirmingSweep ? <>
              <div className="text-cyan-300 text-[10px] font-bold text-center">
                Sweep Heavybag?{sweepStatus === "paid" ? ` — ${PAID_SWEEP_SHARD_COST.toLocaleString()} shards` : ""}
              </div>
              <button className={btnAction} onClick={() => { setConfirmingSweep(false); setPopup(null); onSweep("heavyBag"); }} data-testid="gym-bag-sweep-confirm">🧹 Confirm</button>
              <button className={`${btnBase} text-white/60 bg-white/5 hover:bg-white/10`} onClick={() => setConfirmingSweep(false)} data-testid="gym-bag-sweep-cancel">Cancel</button>
            </> : <>
            {level < 500
              ? <button className={btnUpgrade(cost)} onClick={() => handleUpgrade(key as "heavyBag1" | "heavyBag2" | "heavyBag3", BASE_UPGRADE_COST.heavyBag)} data-testid="gym-bag-upgrade">
                  ⬆ Upgrade — {cost.toLocaleString()} Force</button>
              : <div className="text-yellow-400 text-xs text-center py-1">★ MAX LEVEL 500</div>}
            {trainingLocked ? <LockedNote /> : <button className={btnAction} onClick={() => { setPopup(null); onStartBagWork(); }} data-testid="gym-bag-train">👊 Bag Work</button>}
            {onStartFreeBag && <button className={btnAction} onClick={() => { setPopup(null); onStartFreeBag(); }} data-testid="gym-bag-free">🥊 Free Mode</button>}
            {!trainingLocked && <SweepControl testPrefix="gym-bag" />}
            </>}
          </>;
        })()}

        {popup.zone === "player" && (() => {
          const sp = fighter.skillPoints ?? { power: 0, speed: 0, defense: 0, stamina: 0, focus: 0 };
          const levelUpCost = diamondLevelUpCost(fighter.diamondLevelsBought ?? 0);
          return <>
          <div className="text-white font-bold text-xs">{displayName}</div>
          <div className="text-yellow-400 text-[10px]">Level {fighter.level} · Rank #{playerRank}</div>
          <div className="text-white/70 text-[10px]" data-testid="gym-player-stats">
            PWR {sp.power} · SPD {sp.speed} · DEF {sp.defense} · STA {sp.stamina} · FOC {sp.focus}
          </div>
          <div className="text-cyan-300 text-[10px] mb-1">Looking sharp. Want a new look?</div>
          {confirmingLevelUp ? <>
            <div className="text-cyan-300 text-[10px] font-bold text-center">Spend {levelUpCost.toLocaleString()} diamond{levelUpCost === 1 ? "" : "s"} to level up?</div>
            {/* Confirming drops back to the panel's normal buttons — showing the
                new level and the next price — rather than closing it. */}
            <button className={btnAction} onClick={() => { setConfirmingLevelUp(false); onLevelUp(); }} data-testid="gym-player-levelup-confirm">💎 Confirm</button>
            <button className={`${btnBase} text-white/60 bg-white/5 hover:bg-white/10`} onClick={() => setConfirmingLevelUp(false)} data-testid="gym-player-levelup-cancel">Cancel</button>
          </> : <>
            {(fighter.diamonds ?? 0) >= levelUpCost
              ? <button className={btnAction} onClick={() => setConfirmingLevelUp(true)} data-testid="gym-player-levelup">⬆ Level Up — {levelUpCost.toLocaleString()} 💎</button>
              : <button className={`${btnBase} text-white/40 bg-white/5 cursor-not-allowed`} disabled data-testid="gym-player-levelup">⬆ Level Up — needs {levelUpCost.toLocaleString()} 💎</button>}
            <button className={btnAction} onClick={() => { setPopup(null); onOpenEditColors(); }} data-testid="gym-player-edit-colors">🎨 Edit Colors</button>
            <button className={`${btnBase} text-white/60 bg-white/5 hover:bg-white/10`} onClick={() => setPopup(null)} data-testid="gym-player-cancel">Not now</button>
          </>}
          </>;
        })()}

        {popup.zone === "trophyB" && <>
          <div className="text-white font-bold text-xs">Skill Refinement</div>
          <div className="text-purple-300 text-[10px]">🔒 Unlocks at rank 650. Keep climbing the rankings!</div>
        </>}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-black overflow-hidden flex items-center justify-center" data-testid="gym-view">
      <div className="relative" style={{ height: "100vh", width: "auto", display: "flex" }}>
        <canvas
          ref={glCanvasRef}
          className="absolute inset-0 block pointer-events-none"
          style={{ width: "100%", height: "100%" }}
          data-testid="gym-canvas-3d"
        />
        <canvas
          ref={canvasRef}
          width={CW}
          height={CH}
          className="block relative"
          style={{ height: "100vh", width: "auto", cursor: hoveredZone ? "pointer" : "default" }}
          onMouseMove={handleMouseMove}
          onMouseLeave={() => { hoveredRef.current = null; setHoveredZone(null); }}
          onClick={handleClick}
          data-testid="gym-canvas"
        />

        {/* Ringside view: back to the regular gym shot. */}
        {ringViewOpen && (
          <button
            className="absolute left-3 top-1/2 -translate-y-1/2 z-[75] flex items-center gap-1 rounded-full border border-white/25 bg-black/70 py-2 pl-2 pr-4 text-sm font-bold uppercase tracking-wider text-white hover:bg-black/90 hover:border-yellow-400/70"
            onClick={closeRingView}
            data-testid="gym-ring-back"
          ><ChevronLeft className="h-6 w-6" />Back</button>
        )}

        {editGymOpen && (
          <EditGymPanel
            saved={savedLook}
            force={currentForce}
            onPreview={previewLook}
            onSaveFree={(patch) => { saveGymLookPatch(patch); }}
            onBuyName={(name) => saveGymLookPatch({ name }, { force: GYM_RENAME_FORCE })}
            onOpenRingColors={() => { setEditGymOpen(false); onOpenEditRingColors(); }}
            onClose={() => setEditGymOpen(false)}
          />
        )}

        {/* Fight week: go straight to the bout, or visit the office first. */}
        {isFightWeek && onFightNow && (
          <button
            className="absolute bottom-4 right-4 z-[70] rounded-md px-7 py-3 text-xl font-black uppercase tracking-[0.2em] text-black bg-yellow-500 hover:bg-yellow-400 border-2 border-yellow-300 shadow-[0_0_24px_rgba(234,179,8,0.45)] transition-colors"
            onClick={() => { setPopup(null); setFightConfirmOpen(true); }}
            data-testid="gym-fight-now"
          >Fight</button>
        )}

        {overlayBanner && (
          <div className="absolute bottom-3 right-3 pointer-events-none z-[70]">
            {overlayBanner}
          </div>
        )}

        {/* Active item boosts — bottom-left corner, lifted just clear of the
            centred stat-point bar so the two never collide on a narrow canvas.
            Hover any icon for what it's doing right now. */}
        <ActiveBoostsHud
          fighter={fighter}
          roster={roster}
          className="absolute bottom-14 left-3 z-[70] max-w-[220px]"
          size={30}
          tooltipAlign="left"
        />
        {/* Fighter header — top-left */}
        <div className="absolute top-3 left-3 flex flex-col items-start gap-1.5 pointer-events-none z-[60]">
          <div className="bg-black/70 border border-white/10 rounded px-3 py-1.5">
            <div className="text-yellow-400 font-black italic uppercase text-sm leading-tight" style={{ textShadow: "1px 1px 0 rgba(0,0,0,0.7)" }} data-testid="gym-header-name">{displayName}</div>
            <div className="text-white/85 text-[11px] font-mono" data-testid="gym-header-record">{recordStr}{(fighter.knockouts ?? 0) > 0 ? ` · ${fighter.knockouts} KO` : ""}</div>
            <div className="text-white/60 text-[10px]" data-testid="gym-header-rank">{playerRank != null ? `Rank #${playerRank}` : "Unranked"} · Lv.{fighter.level}</div>
          </div>
          {/* How close the climb is to opening Skill Refinement — sits directly
              under the name/record banner and vanishes once unlocked. */}
          <RefinementProgressMeter roster={roster} unlocked={refinementUnlocked} className="pointer-events-auto" />
          {/* Gym conditioning — stacks under the refinement meter, and takes its
              place in the column once that one has nothing left to show. */}
          <PunchEnduranceMeter roster={roster} fighterId={fighter.id} className="pointer-events-auto" />
          {/* Defensive Mastery — mastery bar and the diamond ladder. */}
          <DefensiveMasteryMeter fighter={fighter} roster={roster} onFighterChanged={onFighterChanged} className="pointer-events-auto" />
          <PurePowerMeter roster={roster} className="pointer-events-auto" />
          {/* Daily chests — time left until the 00:00 reset, worked out from the
              device clock so it keeps running offline. */}
          <DailyRewardBadge roster={roster} onDue={onDailyRewardDue} className="pointer-events-auto" />
        </div>

        {/* Force / Diamond HUD — overlaid inside canvas, top-right */}
        <div className="absolute top-3 right-3 flex flex-col items-end gap-1 pointer-events-none z-[60]">
          <button
            className={"flex items-center gap-1.5 bg-black/75 border border-white/10 rounded px-2 py-1 pointer-events-auto transition-colors " + (canConvertDiamonds ? "hover:border-yellow-500/50" : "cursor-default")}
            onClick={() => { if (canConvertDiamonds) setConvertOpen(true); }}
            title={canConvertDiamonds ? "Convert Force to Diamonds" : "Force"}
            data-testid="gym-force-chip"
          >
            <Zap className="w-3 h-3 text-yellow-400 fill-yellow-400" />
            <span className="text-yellow-400 font-bold text-sm font-mono">{currentForce.toLocaleString()}</span>
            {canConvertDiamonds && <span className="text-white/40 text-[9px] font-bold ml-0.5">⇄ 💎</span>}
          </button>
          <div className="flex items-center gap-1.5 bg-black/75 border border-white/10 rounded px-2 py-1">
            <span className="text-sm leading-none">💎</span>
            <span className="text-cyan-300 font-bold text-sm font-mono">{fighter.diamonds ?? 0}</span>
          </div>
          <div className="flex items-center gap-1.5 bg-black/75 border border-white/10 rounded px-2 py-1">
            <span className="text-sm leading-none">🔷</span>
            <span className="text-sky-300 font-bold text-sm font-mono" data-testid="gym-shards-chip">{currentShards.toLocaleString()}</span>
          </div>
          <div className="flex items-center gap-0.5 bg-black/50 rounded px-1.5 py-0.5">
            <Zap className="w-2 h-2 text-yellow-400/60" />
            <span className="text-yellow-400/60 text-[10px] font-mono">{totalFPH.toFixed(1)}/hr</span>
            {acIncomeMult > 1 && <span className="text-cyan-300/80 text-[10px] font-mono font-bold">×{acIncomeMult}</span>}
          </div>
          {/* Item store — sits directly under the production rate, since Force
              is what it spends. */}
          <button
            className="flex items-center gap-1 bg-black/75 border border-white/10 rounded px-2 py-1 mt-0.5 pointer-events-auto hover:border-yellow-500/50 transition-colors"
            onClick={() => setStoreOpen(true)}
            title="Spend Force (or Diamonds) on items"
            data-testid="gym-store-chip"
          >
            <ShoppingBag className="w-3 h-3 text-yellow-400" />
            <span className="text-yellow-300 font-bold text-[10px] uppercase tracking-wider">Store</span>
          </button>
        </div>

        {/* Passive income earned banner — below the header, auto-dismisses after 3s */}
        {earnedOnEnter > 0 && (
          <div className="absolute top-[4.6rem] left-3 bg-yellow-900/85 border border-yellow-500/50 rounded px-2 py-1 pointer-events-none z-[60]">
            <span className="text-yellow-200 text-xs font-bold">+{earnedOnEnter.toLocaleString()} Force earned while away</span>
          </div>
        )}

        {/* New-items notification — red pulsating dot floating over the lockers */}
        {unseenItems && !lockerOpen && (
          <div
            className="absolute z-[58] pointer-events-none"
            style={{
              left: `${(tagPos("lockers").x / CW) * 100}%`,
              top: `${(tagPos("lockers").y / CH) * 100}%`,
              transform: "translate(-50%,-100%)",
            }}
            {...anchorAttrs("lockers")}
            data-testid="gym-locker-new-items-dot"
          >
            <span className="relative flex h-3.5 w-3.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 animate-ping" />
              <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-red-600 border border-red-300 shadow-[0_0_8px_rgba(255,60,60,0.9)]" />
            </span>
          </div>
        )}

        {/* Refinement unlocked but never opened — red dot over the Skill Refinement case */}
        {refinementUnseen && (
          <div
            className="absolute z-[58] pointer-events-none"
            style={{
              left: `${(tagPos("trophyB").x / CW) * 100}%`,
              top: `${(tagPos("trophyB").y / CH) * 100}%`,
              transform: "translate(-50%,-100%)",
            }}
            {...anchorAttrs("trophyB")}
            data-testid="gym-refinement-new-dot"
          >
            <span className="relative flex h-3.5 w-3.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 animate-ping" />
              <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-red-600 border border-red-300 shadow-[0_0_8px_rgba(255,60,60,0.9)]" />
            </span>
          </div>
        )}

        {/* Newly unlocked equipment the player hasn't seen — red dot over the crate */}
        {equipUnlocked && equipPending.length > 0 && (
          <div
            className="absolute z-[58] pointer-events-none"
            style={{
              left: `${(tagPos("equipCrate").x / CW) * 100}%`,
              top: `${(tagPos("equipCrate").y / CH) * 100}%`,
              transform: "translate(-50%,-100%)",
            }}
            {...anchorAttrs("equipCrate")}
            data-testid="gym-equipment-new-dot"
          >
            <span className="relative flex h-3.5 w-3.5">
              <span className="absolute inline-flex h-full w-full rounded-full bg-red-500 opacity-75 animate-ping" />
              <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-red-600 border border-red-300 shadow-[0_0_8px_rgba(255,60,60,0.9)]" />
            </span>
          </div>
        )}

        {/* Weekly training bonus tag over the matching gym object */}
        {weeklyBonus && bonusTagPos && (
          <div
            className="absolute z-[55] pointer-events-none"
            style={{ left: `${(bonusTagPos.x / CW) * 100}%`, top: `${(bonusTagPos.y / CH) * 100}%`, transform: "translate(-50%,-100%)" }}
            {...(bonusZone ? anchorAttrs(bonusZone, 4) : {})}
            data-testid="gym-weekly-bonus-tag"
          >
            <span className="inline-block text-[11px] font-black text-black bg-yellow-400 border border-yellow-200 rounded px-1.5 py-0.5 shadow-lg animate-bounce">
              {weeklyBonus.bonusType === "xp" ? "+XP" : "+SP"}
            </span>
          </div>
        )}

        {/* Stat points — always on, bottom middle */}
        <div
          className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/75 border border-yellow-600/40 rounded px-3 py-1.5 pointer-events-none whitespace-nowrap z-[60]"
          data-testid="gym-stat-points"
        >
          <span className="text-yellow-400 text-xs font-bold font-mono tracking-wide" style={{ textShadow: "1px 1px 0 rgba(0,0,0,0.7)" }}>
            PWR {statLine.power} · SPD {statLine.speed} · DEF {statLine.defense} · STA {statLine.stamina} · FOC {statLine.focus}
          </span>
        </div>

        {/* Hover tooltip — sits above the stat point strip */}
        {hoveredZone && !popup && (
          <div className="absolute bottom-14 left-1/2 -translate-x-1/2 bg-black/80 border border-white/20 rounded px-3 py-1.5 pointer-events-none whitespace-nowrap z-[60]">
            <span className="text-white text-xs font-bold">{getZoneLabel(hoveredZone)}</span>
          </div>
        )}
      </div>

      {/* Force → Diamond convert dialog */}
      {convertOpen && (
        <div className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center" onClick={() => setConvertOpen(false)}>
          <div className="bg-[#1a1a1a] border border-white/20 rounded-lg p-4 w-80 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="text-white font-bold text-sm mb-1">Convert Force to Diamonds</div>
            <p className="text-white/70 text-xs mb-3">
              You have <span className="text-yellow-300 font-bold">⚡ {currentForce.toLocaleString()}</span> Force and <span className="text-cyan-300 font-bold">💎 {fighter.diamonds ?? 0}</span>.
            </p>

            {/* Credit Limit Increase unlocks the Force → Diamond exchange. */}
            {canConvertDiamonds && (
              <div className="mb-3 border-t border-white/10 pt-2" data-testid="gym-diamond-convert">
                {confirmDiamond ? (
                  <div className="flex items-center gap-2">
                    <span className="text-cyan-200 text-xs font-bold flex-1">
                      Spend {FORCE_PER_DIAMOND.toLocaleString()} Force for 💎 1?
                    </span>
                    <button
                      className="rounded px-2.5 py-1.5 text-[11px] font-bold text-black bg-cyan-400 hover:bg-cyan-300"
                      onClick={() => {
                        onForceToDiamond?.();
                        setCurrentForce(prev => Math.max(0, prev - FORCE_PER_DIAMOND));
                        currentForceRef.current = Math.max(0, currentForceRef.current - FORCE_PER_DIAMOND);
                        setConfirmDiamond(false);
                      }}
                      data-testid="gym-diamond-convert-confirm"
                    >Confirm</button>
                    <button
                      className="rounded px-2.5 py-1.5 text-[11px] font-bold text-white/70 bg-white/10 hover:bg-white/20"
                      onClick={() => setConfirmDiamond(false)}
                      data-testid="gym-diamond-convert-cancel"
                    >Cancel</button>
                  </div>
                ) : (
                  <button
                    className={`w-full rounded px-2.5 py-2 text-xs font-bold transition-colors ${currentForce >= FORCE_PER_DIAMOND ? "text-black bg-cyan-400 hover:bg-cyan-300" : "text-white/35 bg-white/5 cursor-not-allowed"}`}
                    disabled={currentForce < FORCE_PER_DIAMOND}
                    onClick={() => setConfirmDiamond(true)}
                    data-testid="gym-diamond-convert-open"
                  >Convert to Diamonds — {FORCE_PER_DIAMOND.toLocaleString()} ⚡ → 💎 1</button>
                )}
              </div>
            )}

            <div className="flex gap-2">
              <button
                className="flex-1 rounded px-2.5 py-2 text-xs font-bold text-white/80 bg-white/10 hover:bg-white/20 transition-colors"
                onClick={() => setConvertOpen(false)}
                data-testid="gym-convert-cancel"
              >Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Locker — item inventory popup */}
      {lockerOpen && (
        <LockerView
          fighterId={fighter.id}
          roster={roster}
          onClose={closeLocker}
          onChanged={(f) => {
            setCurrentShards(f.shards ?? 0);
            setCurrentForce(f.force ?? 0);
            currentForceRef.current = f.force ?? 0;
            onFighterChanged?.(f);
          }}
        />
      )}

      {/* Item store — buy items with Force, topping up with Diamonds */}
      {storeOpen && (
        <ItemStoreView
          fighterId={fighter.id}
          playerRank={playerRank}
          onClose={() => setStoreOpen(false)}
          onChanged={(f) => {
            setCurrentShards(f.shards ?? 0);
            setCurrentForce(f.force ?? 0);
            currentForceRef.current = f.force ?? 0;
            onFighterChanged?.(f);
          }}
        />
      )}

      {fightConfirmOpen && onFightNow && (
        <div className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center" onClick={() => setFightConfirmOpen(false)} data-testid="gym-fight-confirm">
          <div className="bg-gray-950 border border-yellow-600/60 rounded-lg px-10 py-7 shadow-xl text-center" onClick={e => e.stopPropagation()}>
            <div className="text-4xl font-black uppercase tracking-[0.25em] text-yellow-400 mb-6" data-testid="text-fight-confirm">READY?</div>
            <div className="flex gap-3 justify-center">
              <button
                className="rounded px-6 py-2 text-sm font-black uppercase tracking-widest text-black bg-yellow-500 hover:bg-yellow-400"
                onClick={() => { setFightConfirmOpen(false); onFightNow(); }}
                data-testid="gym-fight-confirm-yes"
              >Yes</button>
              <button
                className="rounded px-6 py-2 text-sm font-black uppercase tracking-widest text-white/80 bg-white/10 hover:bg-white/20"
                onClick={() => setFightConfirmOpen(false)}
                data-testid="gym-fight-confirm-no"
              >No</button>
            </div>
          </div>
        </div>
      )}

      {/* Popup click-away overlay */}
      {popup && <div className="fixed inset-0 z-[65]" onClick={() => setPopup(null)} />}
      <PopupMenu />
    </div>
  );
}
