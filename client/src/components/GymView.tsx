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
import DailyRewardBadge from "@/components/DailyRewardBadge";
import * as localSaves from "@/lib/localSaves";
import { createInitialState, startFight, updateGame } from "@/game/engine";
import { renderGame, renderFighterPreview, renderFightersOnly, getCameraView, setGymEnvironmentDrawer } from "@/game/renderer";
import { getGraphicsMode } from "@/game/graphicsSetting";
import { FightScene3D } from "@/game/three/FightScene3D";
import { setGymDressing } from "@/game/three/gym3d";
import { GYM_PLAYER_PX, gymZoneAnchor, pickGymZone, projectGymPoint } from "@/game/three/gymLayout";
import { ringColorsOf } from "@/game/ringColors";
import type { GameState, FighterColors } from "@/game/types";
import { type Archetype, SKIN_COLOR_PRESETS } from "@/game/types";

// ==================== CONSTANTS ====================
const CW = 800;
const CH = 600;
// Must match engine.ts ring constants exactly
const RING_CX = 400;
const RING_CY = 260;
const RING_HW = 280;
const RING_HH = 180;
const GYM_LS_KEY = "handz_gym_state";
/** How often standing in the gym banks what the equipment has produced. */
const PASSIVE_TICK_MS = 10_000;

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

// ==================== CAMERA PROJECTION ====================
// Mirrors the renderer's world→screen mapping (CAM_ZOOM=1.35, CAM_PITCH=0.62,
// screen center 400/288, canvas re-center 400/300 → net static offset (0,+12)).
// The defaults collapse to the gym home screen's static camera (yaw 0, zoom 1,
// focus on ring center); drawSparringGymEnvironment temporarily overrides the
// cam vars so the same equipment code follows the live sparring camera.
const PSX = 1.35;        // horizontal + height scale (CAM_ZOOM)
const PSY = 0.62 * 1.35; // floor depth scale (CAM_PITCH * CAM_ZOOM)
const CAM_FX0 = 400;     // CAM_SCREEN_CX
const CAM_FY0 = 288;     // CAM_SCREEN_CY (600 * 0.48)
let camYaw = 0, camZoom = 1, camFx = CAM_FX0, camFy = CAM_FY0;
function projX(wx: number, wz: number = RING_CY): number {
  const rx = wx - RING_CX, rz = wz - RING_CY;
  const rotX = rx * Math.cos(camYaw) + rz * Math.sin(camYaw);
  return 400 + (CAM_FX0 + rotX * PSX - camFx) * camZoom;
}
function projY(wz: number, wy = 0, wx: number = RING_CX): number {
  const rx = wx - RING_CX, rz = wz - RING_CY;
  const rotZ = -rx * Math.sin(camYaw) + rz * Math.cos(camYaw);
  return 300 + (CAM_FY0 + rotZ * PSY - wy * PSX - camFy) * camZoom;
}

// Ring diamond as it appears on screen under the static camera
const RING_SCR_CX = 400;
const RING_SCR_CY = 300;
const RING_SCR_HW = RING_HW * PSX;
const RING_SCR_HH = RING_HH * PSY;

// Equipment rows sit parallel to the nearest ring edge (Clash-of-Clans style)
const YAW_NE = Math.atan2(-RING_HH, RING_HW); // parallel to upper-left / lower-right edges
const YAW_SE = Math.atan2(RING_HH, RING_HW);  // parallel to upper-right / lower-left edges

// World anchors for the floor-standing equipment in the 4 corners
const EQ = {
  trophyA:   { cx: 190, cz: 112 },
  exitDoor:  { cx: 252, cz: 72 },
  trophyB:   { cx: 314, cz: 32 },
  plateRack: { cx: 506, cz: 45 },
  bench:     { cx: 576, cz: 90 },
  dumbbells: { cx: 646, cz: 135 },
  lockers:   { cx: 185, cz: 412 },
  bag3:      { cx: 280, cz: 466 },
  bag1:      { cx: 520, cz: 466 },
  bag2:      { cx: 590, cz: 421 },
  equipCrate:{ cx: 650, cz: 450 },
  desk:      { cx: 592, cz: 528 },
  chair:     { cx: 592, cz: 554 },
  bottles:   { cx: 540, cz: 546 },
  woodBench: { cx: 160, cz: 480 },
  player:    { cx: 225, cz: 480 },
} as const;

// Player sprite composited from an offscreen renderFighterPreview canvas.
// Feet in that 160x192 canvas sit at y = 192*0.82 ≈ 157.
const PLAYER_PC_W = 160;
const PLAYER_PC_H = 192;
const PLAYER_FEET_Y = Math.round(PLAYER_PC_H * 0.82);
const PLAYER_SX = projX(EQ.player.cx);
const PLAYER_SY = projY(EQ.player.cz);

// ==================== HIT DETECTION ====================
function pointInDiamond(px: number, py: number, cx: number, cy: number, hw: number, hh: number): boolean {
  return Math.abs(px - cx) / hw + Math.abs(py - cy) / hh <= 1;
}

type Rect = { x: number; y: number; w: number; h: number };
function rectUnion(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}
// Screen rect around a floor-anchored object: world anchor + half-width/height in screen px
function objRect(cx: number, cz: number, halfWpx: number, hPx: number, pad = 6): Rect {
  const sx = projX(cx), sy = projY(cz);
  return { x: sx - halfWpx - pad, y: sy - hPx - pad, w: (halfWpx + pad) * 2, h: hPx + pad * 2 };
}

// Clickable screen areas derived from the projected equipment footprints.
// Earlier entries win where rects overlap (player sits in front of the lockers).
const HITRECTS: { zone: GymZone; rect: Rect }[] = [
  { zone: "player", rect: objRect(EQ.player.cx, EQ.player.cz, 24, 105) },
  { zone: "office", rect: [
      objRect(EQ.desk.cx, EQ.desk.cz, 48, 60),
      objRect(EQ.chair.cx, EQ.chair.cz, 20, 40),
      objRect(EQ.bottles.cx, EQ.bottles.cz, 24, 36),
    ].reduce(rectUnion) },
  { zone: "trophyA", rect: objRect(EQ.trophyA.cx, EQ.trophyA.cz, 46, 76) },
  { zone: "door", rect: objRect(EQ.exitDoor.cx, EQ.exitDoor.cz, 26, 100) },
  { zone: "trophyB", rect: objRect(EQ.trophyB.cx, EQ.trophyB.cz, 46, 76) },
  { zone: "weights", rect: [
      objRect(EQ.plateRack.cx, EQ.plateRack.cz, 30, 44),
      objRect(EQ.bench.cx, EQ.bench.cz, 44, 58),
      objRect(EQ.dumbbells.cx, EQ.dumbbells.cz, 32, 42),
    ].reduce(rectUnion) },
  { zone: "bag3", rect: objRect(EQ.bag3.cx, EQ.bag3.cz, 22, 92) },
  { zone: "lockers", rect: objRect(EQ.lockers.cx, EQ.lockers.cz, 62, 76) },
  { zone: "bag1", rect: objRect(EQ.bag1.cx, EQ.bag1.cz, 22, 92) },
  { zone: "bag2", rect: objRect(EQ.bag2.cx, EQ.bag2.cz, 22, 92) },
  { zone: "equipCrate", rect: objRect(EQ.equipCrate.cx, EQ.equipCrate.cz, 26, 40) },
];

// ==================== PSEUDO-3D DRAW HELPERS ====================
type Pt = [number, number];

function lerpPt(a: Pt, b: Pt, t: number): Pt {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

function quad(ctx: CanvasRenderingContext2D, pts: Pt[], fill: string, outline = "rgba(0,0,0,0.35)"): void {
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
  ctx.closePath();
  ctx.fillStyle = fill; ctx.fill();
  ctx.strokeStyle = outline; ctx.lineWidth = 0.8; ctx.stroke();
}

function insetQuad(q: Pt[], t: number): Pt[] {
  const cx = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
  const cy = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
  return q.map(([x, y]) => [x + (cx - x) * t, y + (cy - y) * t] as Pt);
}

// Bilinear point on a face quad [bottomLeft, bottomRight, topRight, topLeft]
// u: 0..1 along width, v: 0..1 from bottom edge to top edge
function facePt(q: Pt[], u: number, v: number): Pt {
  return lerpPt(lerpPt(q[0], q[1], u), lerpPt(q[3], q[2], u), v);
}
function faceSub(q: Pt[], u0: number, u1: number, v0: number, v1: number): Pt[] {
  return [facePt(q, u0, v0), facePt(q, u1, v0), facePt(q, u1, v1), facePt(q, u0, v1)];
}

interface PrismFaces { base: Pt[]; top: Pt[]; front: Pt[]; topFace: Pt[]; }

// Angled box standing on the gym floor, projected with the fixed camera.
// Footprint corner order: front-left, front-right, back-right, back-left.
// Draws the visible side face, the front face and the top face (CoC style).
function drawPrism(
  ctx: CanvasRenderingContext2D,
  cx: number, cz: number, w: number, d: number, h: number, yaw: number,
  front: string, side: string, topCol: string, y0 = 0,
): PrismFaces {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const hw = w / 2, hd = d / 2;
  const foot: Pt[] = ([[-hw, hd], [hw, hd], [hw, -hd], [-hw, -hd]] as Pt[])
    .map(([px, pz]) => [cx + px * ca - pz * sa, cz + px * sa + pz * ca] as Pt);
  const base: Pt[] = foot.map(([wx, wz]) => [projX(wx, wz), projY(wz, y0, wx)] as Pt);
  const top: Pt[] = foot.map(([wx, wz]) => [projX(wx, wz), projY(wz, y0 + h, wx)] as Pt);
  if (sa > 0.02) quad(ctx, [base[1], base[2], top[2], top[1]], side);       // right side visible
  else if (sa < -0.02) quad(ctx, [base[3], base[0], top[0], top[3]], side); // left side visible
  const frontQ: Pt[] = [base[0], base[1], top[1], top[0]];
  quad(ctx, frontQ, front);
  const topQ: Pt[] = [top[0], top[1], top[2], top[3]];
  quad(ctx, topQ, topCol);
  return { base, top, front: frontQ, topFace: topQ };
}

function drawFloorShadow(ctx: CanvasRenderingContext2D, cx: number, cz: number, rxW: number, rzW: number, alpha = 0.22): void {
  ctx.fillStyle = `rgba(25,15,8,${alpha})`;
  ctx.beginPath();
  ctx.ellipse(projX(cx, cz), projY(cz, 0, cx), rxW * PSX * camZoom, rzW * PSY * camZoom, 0, 0, Math.PI * 2);
  ctx.fill();
}

// Glowing floor ellipse under an object (hover highlight), aligned with its yaw
function drawHoverGlow(ctx: CanvasRenderingContext2D, cx: number, cz: number, halfLenW: number, halfDepW: number, yaw: number, rgb: string): void {
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const rx = halfLenW * Math.hypot(ca * PSX, sa * PSY) * camZoom;
  const rot = Math.atan2(sa * PSY, ca * PSX);
  const ry = halfDepW * PSY * camZoom;
  const sx = projX(cx, cz), sy = projY(cz, 0, cx);
  ctx.fillStyle = `rgba(${rgb},0.14)`;
  ctx.beginPath();
  ctx.ellipse(sx, sy, rx, ry, rot, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = `rgba(${rgb},0.55)`;
  ctx.lineWidth = 2;
  ctx.stroke();
}

// Vertical cylinder standing on the floor (bases, poles, heavy bags)
function drawCylinder(
  ctx: CanvasRenderingContext2D,
  cx: number, cz: number, r: number, y0: number, y1: number,
  cL: string, cM: string, cR: string, topCol: string,
): void {
  const sx = projX(cx, cz), rx = r * PSX * camZoom, ry = r * PSY * camZoom;
  const yb = projY(cz, y0, cx), yt = projY(cz, y1, cx);
  const g = ctx.createLinearGradient(sx - rx, 0, sx + rx, 0);
  g.addColorStop(0, cL); g.addColorStop(0.35, cM); g.addColorStop(1, cR);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(sx - rx, yt);
  ctx.lineTo(sx - rx, yb);
  ctx.ellipse(sx, yb, rx, ry, 0, Math.PI, 0, true);
  ctx.lineTo(sx + rx, yt);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 0.8; ctx.stroke();
  ctx.fillStyle = topCol;
  ctx.beginPath();
  ctx.ellipse(sx, yt, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

// ==================== EQUIPMENT DRAW FUNCTIONS ====================
// All equipment stands on the gym floor as angled pseudo-3D objects
// projected with the same fixed camera as the ring.

// Wider display case with earned trophies (gold cups) and medals (silver discs)
// arranged on three shelves, filling top-down as they are earned.
function drawTrophyCaseObj(ctx: CanvasRenderingContext2D, cx: number, cz: number, yaw: number, trophies: number, medals: number): void {
  drawFloorShadow(ctx, cx, cz, 38, 16);
  const f = drawPrism(ctx, cx, cz, 64, 18, 52, yaw, "#6b4c22", "#4a3015", "#9b7242");
  // glass front with gold trim
  quad(ctx, insetQuad(f.front, 0.1), "rgba(180,220,255,0.15)", "rgba(212,175,55,0.65)");
  // two shelf lines
  ctx.strokeStyle = "rgba(100,70,30,0.55)"; ctx.lineWidth = 1;
  for (const v of [0.37, 0.64]) {
    const shL = facePt(f.front, 0.08, v), shR = facePt(f.front, 0.92, v);
    ctx.beginPath(); ctx.moveTo(shL[0], shL[1]); ctx.lineTo(shR[0], shR[1]); ctx.stroke();
  }
  // earned items fill 3 shelves x 8 slots, trophies first, then medals
  const shelfV = [0.78, 0.52, 0.24]; // item base heights (top shelf first)
  const slots = 8;
  const total = Math.min(trophies + medals, shelfV.length * slots);
  for (let i = 0; i < total; i++) {
    const shelf = Math.floor(i / slots);
    const col = i % slots;
    const u = 0.14 + (col / (slots - 1)) * 0.72;
    const p = facePt(f.front, u, shelfV[shelf]);
    if (i < trophies) {
      // tiny gold cup: bowl + stem base
      ctx.fillStyle = "#D4AF37";
      ctx.beginPath(); ctx.arc(p[0], p[1] - 2.2, 2.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(p[0] - 1.9, p[1] + 0.4, 3.8, 1.5);
    } else {
      // medal: ribbon tick + disc
      ctx.strokeStyle = "#7a2030"; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(p[0], p[1] - 4.6); ctx.lineTo(p[0], p[1] - 1.6); ctx.stroke();
      ctx.fillStyle = "#c8ccd4";
      ctx.beginPath(); ctx.arc(p[0], p[1] - 1.2, 1.9, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.35)"; ctx.lineWidth = 0.6; ctx.stroke();
    }
  }
}

function drawExitDoorObj(ctx: CanvasRenderingContext2D, cx: number, cz: number, yaw: number): void {
  drawFloorShadow(ctx, cx, cz, 22, 12);
  const f = drawPrism(ctx, cx, cz, 34, 10, 58, yaw, "#7a5535", "#57381f", "#8f6a42");
  // recessed door panel + window
  quad(ctx, faceSub(f.front, 0.12, 0.88, 0.04, 0.94), "#5d3f22", "rgba(0,0,0,0.4)");
  quad(ctx, faceSub(f.front, 0.3, 0.7, 0.6, 0.85), "rgba(180,220,255,0.32)", "#3d2b1a");
  // knob
  const knob = facePt(f.front, 0.8, 0.46);
  ctx.fillStyle = "#D4AF37";
  ctx.beginPath(); ctx.arc(knob[0], knob[1], 1.8, 0, Math.PI * 2); ctx.fill();
  // EXIT sign above the door
  const sign = drawPrism(ctx, cx, cz, 26, 6, 10, yaw, "#bb0000", "#800000", "#d42222", 62);
  const tc = facePt(sign.front, 0.5, 0.5);
  ctx.fillStyle = "#fff"; ctx.font = "bold 8px sans-serif"; ctx.textAlign = "center";
  ctx.fillText("EXIT", tc[0], tc[1] + 3);
}

function drawPlateRackObj(ctx: CanvasRenderingContext2D, cx: number, cz: number, yaw: number): void {
  drawFloorShadow(ctx, cx, cz, 25, 11);
  const f = drawPrism(ctx, cx, cz, 40, 12, 22, yaw, "#3c3c3c", "#262626", "#505050");
  // weight plates standing in the rack
  const plateCols = ["#cc2222", "#1155cc", "#e8e8e8", "#cc2222"];
  const plateR = [7.5, 7, 6.5, 6];
  for (let i = 0; i < 4; i++) {
    const p = facePt(f.topFace, 0.17 + i * 0.22, 0.5);
    ctx.fillStyle = plateCols[i];
    ctx.beginPath(); ctx.arc(p[0], p[1] - plateR[i] + 2, plateR[i], 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.lineWidth = 0.8; ctx.stroke();
    ctx.fillStyle = "#222";
    ctx.beginPath(); ctx.arc(p[0], p[1] - plateR[i] + 2, 1.6, 0, Math.PI * 2); ctx.fill();
  }
}

function drawBenchObj(ctx: CanvasRenderingContext2D, cx: number, cz: number, yaw: number): void {
  drawFloorShadow(ctx, cx, cz, 33, 15);
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  // two upright posts at the head end (back one first)
  const posts: [number, number][] = [[-14, -8.5], [-14, 8.5]]
    .map(([px, pz]) => [cx + px * ca - pz * sa, cz + px * sa + pz * ca]);
  posts.sort((a, b) => a[1] - b[1]);
  drawPrism(ctx, posts[0][0], posts[0][1], 4.5, 4.5, 34, yaw, "#3a3a3a", "#242424", "#4e4e4e");
  // bench pad
  drawPrism(ctx, cx, cz, 40, 12, 13, yaw, "#6e1f1f", "#4a1414", "#963030");
  drawPrism(ctx, posts[1][0], posts[1][1], 4.5, 4.5, 34, yaw, "#3a3a3a", "#242424", "#4e4e4e");
  // barbell resting across the posts
  const be: [number, number][] = [[-14, -16.5], [-14, 16.5]]
    .map(([px, pz]) => [cx + px * ca - pz * sa, cz + px * sa + pz * ca]);
  const p1: Pt = [projX(be[0][0], be[0][1]), projY(be[0][1], 34, be[0][0])];
  const p2: Pt = [projX(be[1][0], be[1][1]), projY(be[1][1], 34, be[1][0])];
  ctx.strokeStyle = "#999"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(p1[0], p1[1]); ctx.lineTo(p2[0], p2[1]); ctx.stroke();
  for (const [pp, col] of [[p1, "#cc2222"], [p2, "#1155cc"]] as [Pt, string][]) {
    ctx.fillStyle = "#1b1b1b";
    ctx.beginPath(); ctx.arc(pp[0], pp[1], 7.5, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.stroke();
  }
}

function drawDumbbellRackObj(ctx: CanvasRenderingContext2D, cx: number, cz: number, yaw: number): void {
  drawFloorShadow(ctx, cx, cz, 27, 11);
  const f = drawPrism(ctx, cx, cz, 44, 13, 22, yaw, "#35353f", "#22222a", "#4a4a56");
  // dumbbells lying on top
  for (const u of [0.18, 0.5, 0.82]) {
    const a = facePt(f.topFace, u, 0.18), b = facePt(f.topFace, u, 0.82);
    ctx.strokeStyle = "#999"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    ctx.fillStyle = "#2e2e2e";
    for (const p of [a, b]) {
      ctx.beginPath(); ctx.arc(p[0], p[1], 3, 0, Math.PI * 2); ctx.fill();
    }
  }
}

function drawLockersObj(ctx: CanvasRenderingContext2D, cx: number, cz: number, yaw: number): void {
  drawFloorShadow(ctx, cx, cz, 50, 13);
  const f = drawPrism(ctx, cx, cz, 92, 16, 52, yaw, "#44607e", "#31485f", "#5a7896");
  for (let i = 0; i < 4; i++) {
    const u0 = i * 0.25 + 0.02, u1 = (i + 1) * 0.25 - 0.02;
    quad(ctx, faceSub(f.front, u0, u1, 0.05, 0.95), i % 2 ? "#3d5c7a" : "#4a6a8a", "rgba(0,0,0,0.28)");
    // vents
    ctx.strokeStyle = "rgba(0,0,0,0.3)"; ctx.lineWidth = 0.7;
    for (let j = 0; j < 3; j++) {
      const a = facePt(f.front, u0 + 0.03, 0.72 + j * 0.07);
      const b = facePt(f.front, u1 - 0.03, 0.72 + j * 0.07);
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
    }
    // handle
    const hd = facePt(f.front, u1 - 0.06, 0.48);
    ctx.fillStyle = "#c9c9c9";
    ctx.beginPath(); ctx.arc(hd[0], hd[1], 1.3, 0, Math.PI * 2); ctx.fill();
  }
}

// Free-standing heavy bag: round base + pole + padded bag cylinder
function drawStandBagObj(ctx: CanvasRenderingContext2D, cx: number, cz: number): void {
  drawFloorShadow(ctx, cx, cz, 17, 10);
  drawCylinder(ctx, cx, cz, 13, 0, 5, "#191919", "#343434", "#101010", "#2c2c2c");
  drawCylinder(ctx, cx, cz, 2.6, 5, 16, "#3c3c3c", "#6a6a6a", "#2c2c2c", "#555555");
  drawCylinder(ctx, cx, cz, 10.5, 16, 64, "#4a1515", "#8b3a3a", "#3a1010", "#5c1c1c");
  const sx = projX(cx, cz), rx = 10.5 * PSX * camZoom;
  // vertical sheen
  ctx.fillStyle = "rgba(255,130,100,0.10)";
  ctx.fillRect(sx - 6, projY(cz, 60, cx), 6, projY(cz, 20, cx) - projY(cz, 60, cx));
  // tape lines
  ctx.strokeStyle = "rgba(220,220,220,0.25)"; ctx.lineWidth = 1.5;
  for (const wy of [30, 48]) {
    const y = projY(cz, wy, cx);
    ctx.beginPath(); ctx.moveTo(sx - rx + 2, y); ctx.lineTo(sx + rx - 2, y); ctx.stroke();
  }
}

// The manager's office desk below the heavy bags — opens the Fight Planner
let monitorScreenQuad: Pt[] | null = null;

function drawOfficeObj(ctx: CanvasRenderingContext2D, night = false): void {
  const yaw = YAW_NE;
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const at = (cx: number, cz: number, px: number, pz: number): [number, number] =>
    [cx + px * ca - pz * sa, cz + px * sa + pz * ca];

  // desk
  {
    const { cx, cz } = EQ.desk;
    drawFloorShadow(ctx, cx, cz, 36, 15);
    const f = drawPrism(ctx, cx, cz, 62, 24, 26, yaw, "#5d4024", "#43301b", "#7a5a36");
    // drawer fronts
    quad(ctx, faceSub(f.front, 0.58, 0.94, 0.14, 0.5), "#4e351e", "rgba(0,0,0,0.35)");
    quad(ctx, faceSub(f.front, 0.58, 0.94, 0.56, 0.92), "#4e351e", "rgba(0,0,0,0.35)");
    for (const v of [0.32, 0.74]) {
      const hd = facePt(f.front, 0.76, v);
      ctx.fillStyle = "#c9a24a";
      ctx.fillRect(hd[0] - 3, hd[1] - 0.8, 6, 1.6);
    }
    // monitor on the desktop
    const [mx, mz] = at(cx, cz, -14, -3);
    const mon = drawPrism(ctx, mx, mz, 17, 3, 12, yaw, "#0d1116", "#080b0e", "#1a222b", 30);
    monitorScreenQuad = insetQuad(mon.front, 0.16);
    quad(ctx, monitorScreenQuad, night ? "#f2f6ff" : "rgba(120,200,255,0.5)", "rgba(0,0,0,0.4)");
    drawPrism(ctx, mx, mz, 5, 3, 4, yaw, "#20262e", "#161b21", "#2a323c", 26);
    // papers + phone on the desktop
    const [px1, pz1] = at(cx, cz, 8, 2);
    drawPrism(ctx, px1, pz1, 12, 8, 1.4, yaw, "#d8d2c2", "#b8b2a2", "#efe9d9", 26);
    const [px2, pz2] = at(cx, cz, 22, -3);
    drawPrism(ctx, px2, pz2, 7, 5, 2, yaw, "#20262e", "#14181e", "#2c343e", 26);
  }

  // office chair pulled up on the near side of the desk (closer to the camera,
  // so it must be drawn after the desk to layer on top of it)
  {
    const { cx, cz } = EQ.chair;
    drawFloorShadow(ctx, cx, cz, 13, 8, 0.18);
    // backrest behind the seat
    const [bx, bz] = at(cx, cz, 0, 8);
    drawPrism(ctx, bx, bz, 18, 4, 30, yaw, "#252c38", "#181d26", "#2f3846");
    drawPrism(ctx, cx, cz, 18, 16, 14, yaw, "#2c3442", "#1e242e", "#39434f");
  }

  // crate of water bottles beside the desk
  {
    const { cx, cz } = EQ.bottles;
    drawFloorShadow(ctx, cx, cz, 15, 9, 0.18);
    drawPrism(ctx, cx, cz, 26, 14, 10, yaw, "#28486a", "#1c3450", "#356087");
    for (const off of [-7.5, 0, 7.5]) {
      const [bx, bz] = at(cx, cz, off, 0);
      drawCylinder(ctx, bx, bz, 3, 10, 22, "#5a8fc0", "#9cc4e8", "#3f6f9e", "#cfe6f8");
    }
  }
}

// Simple wooden seating bench (decoration next to the player)
function drawWoodBenchObj(ctx: CanvasRenderingContext2D, cx: number, cz: number, yaw: number): void {
  drawFloorShadow(ctx, cx, cz, 28, 11);
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const legs: [number, number][] = [[-19, 0], [19, 0]]
    .map(([px, pz]) => [cx + px * ca - pz * sa, cz + px * sa + pz * ca]);
  legs.sort((a, b) => a[1] - b[1]);
  for (const [lx, lz] of legs) {
    drawPrism(ctx, lx, lz, 5, 9, 12, yaw, "#4e3620", "#3a2817", "#5f452b");
  }
  // seat plank
  drawPrism(ctx, cx, cz, 52, 13, 4.5, yaw, "#8a6134", "#6b4a26", "#a87c48", 12);
}

// ==================== CORNER ZONES ====================
const GLOW_EXIT = "110,220,90";
const GLOW_WEIGHTS = "255,215,80";
const GLOW_BAG = "255,150,50";
const GLOW_TROPHY = "255,215,80";
const GLOW_MEDAL = "227,99,255";
const GLOW_OFFICE = "120,180,255";
const GLOW_PLAYER = "80,220,220";
const GLOW_CRATE = "255,190,90";

// Trophy case / exit door / medal case row — top-left, angled parallel to the
// upper-left ring edge. Each object is its own clickable zone.
function drawExitRow(ctx: CanvasRenderingContext2D, hz: GymZone | null, ts: TrophyState): void {
  if (hz === "trophyA") drawHoverGlow(ctx, EQ.trophyA.cx, EQ.trophyA.cz, 36, 16, YAW_NE, GLOW_TROPHY);
  if (hz === "door") drawHoverGlow(ctx, EQ.exitDoor.cx, EQ.exitDoor.cz, 21, 12, YAW_NE, GLOW_EXIT);
  if (hz === "trophyB") drawHoverGlow(ctx, EQ.trophyB.cx, EQ.trophyB.cz, 36, 16, YAW_NE, GLOW_MEDAL);
  drawTrophyCaseObj(ctx, EQ.trophyA.cx, EQ.trophyA.cz, YAW_NE, ts.aTrophies, ts.aMedals);
  drawExitDoorObj(ctx, EQ.exitDoor.cx, EQ.exitDoor.cz, YAW_NE);
  drawTrophyCaseObj(ctx, EQ.trophyB.cx, EQ.trophyB.cz, YAW_NE, ts.bTrophies, ts.bMedals);
}

// Weight row — top-right, angled parallel to the upper-right ring edge
function drawWeightArea(ctx: CanvasRenderingContext2D, hovered: boolean): void {
  if (hovered) {
    drawHoverGlow(ctx, EQ.plateRack.cx, EQ.plateRack.cz, 25, 11, YAW_SE, GLOW_WEIGHTS);
    drawHoverGlow(ctx, EQ.bench.cx, EQ.bench.cz, 32, 16, YAW_SE, GLOW_WEIGHTS);
    drawHoverGlow(ctx, EQ.dumbbells.cx, EQ.dumbbells.cz, 27, 11, YAW_SE, GLOW_WEIGHTS);
  }
  drawPlateRackObj(ctx, EQ.plateRack.cx, EQ.plateRack.cz, YAW_SE);
  drawBenchObj(ctx, EQ.bench.cx, EQ.bench.cz, YAW_SE);
  drawDumbbellRackObj(ctx, EQ.dumbbells.cx, EQ.dumbbells.cz, YAW_SE);
}

// Lockers + free-standing bag — bottom-left, angled parallel to the lower-left ring edge
function drawLockerArea(ctx: CanvasRenderingContext2D, bagHovered: boolean, lockersHovered = false): void {
  if (lockersHovered) drawHoverGlow(ctx, EQ.lockers.cx, EQ.lockers.cz, 52, 12, YAW_SE, GLOW_BAG);
  if (bagHovered) drawHoverGlow(ctx, EQ.bag3.cx, EQ.bag3.cz, 16, 12, 0, GLOW_BAG);
  drawLockersObj(ctx, EQ.lockers.cx, EQ.lockers.cz, YAW_SE);
  drawStandBagObj(ctx, EQ.bag3.cx, EQ.bag3.cz);
}

// Equipment Upgrades crate, beside the far-right heavy bag. Padlocked until the
// player's first career win, lid open from then on.
function drawEquipmentCrateObj(ctx: CanvasRenderingContext2D, cx: number, cz: number, unlocked: boolean): void {
  const yaw = YAW_SE;
  const ca = Math.cos(yaw), sa = Math.sin(yaw);
  const at = (px: number, pz: number): [number, number] => [cx + px * ca - pz * sa, cz + px * sa + pz * ca];

  drawFloorShadow(ctx, cx, cz, 22, 12);
  // Crate body, then its plank frame: a corner post at each front edge and a
  // mid rail — without them the stacked slats read as a pile of boards.
  drawPrism(ctx, cx, cz, 34, 24, 32, yaw, "#8a5f33", "#5b3d1f", "#a2743f");
  for (const off of [-14, 14]) {
    const [bx, bz] = at(off, 0);
    drawPrism(ctx, bx, bz, 6, 25, 32, yaw, "#6b4726", "#472e17", "#7d5530");
  }
  drawPrism(ctx, cx, cz, 35, 25, 4, yaw, "#6b4726", "#472e17", "#7d5530", 14);

  if (unlocked) {
    // Hollow interior, the lid tipped off the back, and a warm glow.
    drawPrism(ctx, cx, cz, 26, 17, 1, yaw, "#2a1c0f", "#20150b", "#2a1c0f", 31);
    const [lx, lz] = at(1, -17);
    drawPrism(ctx, lx, lz, 34, 7, 4, yaw, "#8a6134", "#5f4120", "#a87c48", 30);
    const gx = projX(cx, cz), gy = projY(cz, 32, cx);
    const glow = ctx.createRadialGradient(gx, gy, 0, gx, gy, 30);
    glow.addColorStop(0, "rgba(255,205,110,0.45)");
    glow.addColorStop(1, "rgba(255,205,110,0)");
    ctx.fillStyle = glow;
    ctx.beginPath(); ctx.ellipse(gx, gy, 30, 15, 0, 0, Math.PI * 2); ctx.fill();
    // A glove and a roll of wraps sitting proud of the rim.
    const [ux, uz] = at(-6, 3);
    drawCylinder(ctx, ux, uz, 7, 26, 42, "#8f2020", "#c94040", "#6d1616", "#a33030");
    const [wx, wz] = at(8, 2);
    drawPrism(ctx, wx, wz, 11, 9, 9, yaw, "#d8d2c4", "#aba492", "#efe9dc", 28);
  } else {
    // Nailed shut, with a padlock hanging off the front face.
    drawPrism(ctx, cx, cz, 36, 26, 4, yaw, "#77522c", "#4f351b", "#8d6236", 32);
    const [px, pz] = at(0, 12);
    const sx = projX(px, pz), sy = projY(pz, 17, px);
    ctx.strokeStyle = "#8b939e"; ctx.lineWidth = 2.4;
    ctx.beginPath(); ctx.arc(sx, sy - 6, 4, Math.PI, 0); ctx.stroke();
    ctx.fillStyle = "#cdd6e2";
    ctx.fillRect(sx - 5.5, sy - 6, 11, 9);
    ctx.strokeStyle = "rgba(0,0,0,0.45)"; ctx.lineWidth = 1;
    ctx.strokeRect(sx - 5.5, sy - 6, 11, 9);
    ctx.fillStyle = "#55606d";
    ctx.fillRect(sx - 1, sy - 3, 2, 4);
  }
}

// Two free-standing bags — bottom-right (far bag drawn first)
function drawBagCorner(ctx: CanvasRenderingContext2D, hovered1: boolean, hovered2: boolean, crateHovered = false, crateUnlocked = false): void {
  if (hovered2) drawHoverGlow(ctx, EQ.bag2.cx, EQ.bag2.cz, 16, 12, 0, GLOW_BAG);
  if (hovered1) drawHoverGlow(ctx, EQ.bag1.cx, EQ.bag1.cz, 16, 12, 0, GLOW_BAG);
  if (crateHovered) drawHoverGlow(ctx, EQ.equipCrate.cx, EQ.equipCrate.cz, 22, 13, YAW_SE, GLOW_CRATE);
  drawStandBagObj(ctx, EQ.bag2.cx, EQ.bag2.cz);
  drawEquipmentCrateObj(ctx, EQ.equipCrate.cx, EQ.equipCrate.cz, crateUnlocked);
  drawStandBagObj(ctx, EQ.bag1.cx, EQ.bag1.cz);
}

function drawRingHover(ctx: CanvasRenderingContext2D): void {
  ctx.strokeStyle="rgba(255,220,80,0.58)"; ctx.lineWidth=2;
  ctx.beginPath();
  ctx.moveTo(RING_SCR_CX, RING_SCR_CY - RING_SCR_HH);
  ctx.lineTo(RING_SCR_CX + RING_SCR_HW, RING_SCR_CY);
  ctx.lineTo(RING_SCR_CX, RING_SCR_CY + RING_SCR_HH);
  ctx.lineTo(RING_SCR_CX - RING_SCR_HW, RING_SCR_CY);
  ctx.closePath();
  ctx.stroke();
}

// ==================== SPARRING GYM ENVIRONMENT ====================
// All sparring modes (any difficulty, Nightmare, Doghouse) take place in the
// gym: renderGame calls this hook to paint the gym equipment around the ring,
// projected with the live fight camera (yaw / auto-zoom / focus follow).
// The last trophy state seen on the gym home screen fills the display cases.
let lastTrophyState: TrophyState = defaultTrophyState();
// Same idea for the Equipment crate's lid: the sparring environment has no
// fighter to read career wins off, so it reuses whatever the gym home screen
// last drew.
let lastCrateUnlocked = false;

export function drawSparringGymEnvironment(ctx: CanvasRenderingContext2D, state: GameState): void {
  const cam = getCameraView();
  camYaw = cam.yaw; camZoom = cam.zoom; camFx = cam.focusX; camFy = cam.focusY;
  try {
    // Draw ALL gym equipment first, then re-draw the fighters (and referee)
    // on top so no prop ever covers a fighter — name labels may end up under
    // the equipment, but the fighter bodies always render above it.
    drawExitRow(ctx, null, lastTrophyState);
    drawWeightArea(ctx, false);
    drawLockerArea(ctx, false);
    drawWoodBenchObj(ctx, EQ.woodBench.cx, EQ.woodBench.cz, YAW_SE);
    drawBagCorner(ctx, false, false, false, lastCrateUnlocked);
    // An Import Ticket bout is fought with the gym lights out, the same night
    // dressing fight week uses: the office monitor is the only thing still lit.
    const lightsOff = state.importSparring === true;
    drawOfficeObj(ctx, lightsOff);
    if (lightsOff) {
      // Darken the ring and everything around it, then relight the monitor.
      // The fighters are drawn after this, so the ring stays readable.
      ctx.fillStyle = "rgba(8, 12, 34, 0.52)";
      ctx.fillRect(0, 0, CW, CH);
      if (monitorScreenQuad) {
        const q = monitorScreenQuad;
        const cx0 = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
        const cy0 = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
        const glow = ctx.createRadialGradient(cx0, cy0, 2, cx0, cy0, 42);
        glow.addColorStop(0, "rgba(220, 232, 255, 0.5)");
        glow.addColorStop(1, "rgba(220, 232, 255, 0)");
        ctx.fillStyle = glow;
        ctx.fillRect(cx0 - 42, cy0 - 42, 84, 84);
        quad(ctx, q, "#f2f6ff", "rgba(255,255,255,0.85)");
      }
    }
    // includeZ 300 keeps the front ring ropes overlapping fighters near the
    // bottom edge; everyone else is re-drawn above the equipment.
    renderFightersOnly(ctx, state, Number.POSITIVE_INFINITY, 300);
  } finally {
    // Restore the static gym home screen camera
    camYaw = 0; camZoom = 1; camFx = CAM_FX0; camFy = CAM_FY0;
  }
}
setGymEnvironmentDrawer(drawSparringGymEnvironment);

// ==================== MAIN COMPONENT ====================
export default function GymView({
  fighter, playerColors, playerRank, weeklyBonus, trainingLocked, trainingLockReason, refinementSpent, refinementUnlocked, refinementUnseen,
  onExit, onOpenPlanner, onOpenStats, onOpenRefinements, onOpenEquipment, onOpenEditColors, onOpenEditRingColors, onLevelUp, sweepStatus, onSweep,
  onStartSparring, onStartWeightLifting, onStartBagWork, onForceChange,
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
  const playerPhaseRef = useRef<number>(Math.random() * Math.PI * 2);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  playerColorsRef.current = playerColors;

  // 3D graphics: the gym is a WebGL scene under a transparent 2D canvas that
  // keeps the mouse handling. Falls back to the 2D gym if WebGL won't start.
  const [view3d, setView3d] = useState<boolean>(() => getGraphicsMode() === "3d");
  const view3dRef = useRef(view3d);
  view3dRef.current = view3d;
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<FightScene3D | null>(null);
  // The idle player's own fabricated state (never the sparring sim's).
  const idleStateRef = useRef<GameState | null>(null);

  // Equipment Upgrades: the crate's lid, hover label and click all key off the
  // player's career wins. The draw loop reads it off a ref, and the sparring
  // environment reuses the last value the home screen drew.
  const equipWins = equipmentCareerWins(fighter);
  const equipUnlocked = isEquipmentCrateUnlocked(equipWins);
  const equipUnlockedRef = useRef(equipUnlocked);
  equipUnlockedRef.current = equipUnlocked;
  lastCrateUnlocked = equipUnlocked;
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
    lastTrophyState = trophyRef.current;
  }, [fighter.id, fighter.wins, refinementSpent]);

  // The 3D cases and crate (home screen and sparring) read this snapshot.
  useEffect(() => {
    const t = trophyRef.current;
    setGymDressing({ aTrophies: t.aTrophies, aMedals: t.aMedals, bTrophies: t.bTrophies, bMedals: t.bMedals, crateUnlocked: equipUnlocked });
  }, [fighter.id, fighter.wins, refinementSpent, equipUnlocked]);

  useEffect(() => {
    if (!view3d) return;
    const gl = glCanvasRef.current;
    if (!gl) return;
    let scene: FightScene3D;
    try {
      scene = new FightScene3D(gl);
    } catch (err) {
      console.warn("3D gym unavailable, using the 2D gym", err);
      setView3d(false);
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
  }, [view3d]);

  // Fight week: no sparring in the ring, gym goes dark (night), monitor glows white
  const isFightWeek = trainingLockReason === "fightWeek";
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
        if (view3dRef.current && scene) {
          const idle = idleStateRef.current;
          if (idle) idle.player.bobPhase = ((idle.player.bobPhase || 0) + dt * 2.6 * Math.PI * 2) % (Math.PI * 2);
          ctx.clearRect(0, 0, CW, CH);
          scene.render(gs, {
            gymHome: {
              hovered: hoveredRef.current,
              night: fightWeek,
              idle: idle ? { fighter: idle.player, state: idle, colors: playerColorsRef.current } : null,
              hideFighters: fightWeek,
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
          rafRef.current = requestAnimationFrame(loop);
          return;
        }
        renderGame(ctx, gs);
      } else {
        ctx.fillStyle = "#111"; ctx.fillRect(0, 0, CW, CH);
      }

      // Draw gym equipment overlays around the ring
      const hz = hoveredRef.current;
      drawExitRow(ctx, hz, trophyRef.current);
      drawWeightArea(ctx, hz === "weights");
      drawLockerArea(ctx, hz === "bag3", hz === "lockers");

      // Wooden bench + the player's fighter, idling by the lockers
      drawWoodBenchObj(ctx, EQ.woodBench.cx, EQ.woodBench.cz, YAW_SE);
      if (hz === "player") drawHoverGlow(ctx, EQ.player.cx, EQ.player.cz, 15, 9, 0, GLOW_PLAYER);
      drawFloorShadow(ctx, EQ.player.cx, EQ.player.cz, 14, 8, 0.28);
      playerPhaseRef.current += dt * (2 * 0.8 + 1.0) * Math.PI * 2;
      if (playerPhaseRef.current > Math.PI * 2) playerPhaseRef.current -= Math.PI * 2;
      let pc = previewCanvasRef.current;
      if (!pc) {
        pc = document.createElement("canvas");
        pc.width = PLAYER_PC_W; pc.height = PLAYER_PC_H;
        previewCanvasRef.current = pc;
      }
      const pctx = pc.getContext("2d");
      if (pctx) {
        renderFighterPreview(pctx, PLAYER_PC_W, PLAYER_PC_H, playerColorsRef.current, playerPhaseRef.current, 1);
        ctx.drawImage(pc, PLAYER_SX - PLAYER_PC_W / 2, PLAYER_SY - PLAYER_FEET_Y, PLAYER_PC_W, PLAYER_PC_H);
      }

      drawBagCorner(ctx, hz === "bag1", hz === "bag2", hz === "equipCrate", equipUnlockedRef.current);
      if (hz === "office") {
        drawHoverGlow(ctx, EQ.desk.cx, EQ.desk.cz, 33, 15, YAW_NE, GLOW_OFFICE);
        drawHoverGlow(ctx, EQ.bottles.cx, EQ.bottles.cz, 15, 9, YAW_NE, GLOW_OFFICE);
      }
      drawOfficeObj(ctx, fightWeek);

      // Re-draw the sparring fighters after ALL equipment so no prop ever
      // covers them (name labels may sit under the props, bodies never do).
      if (gs && !fightWeek) renderFightersOnly(ctx, gs, Number.POSITIVE_INFINITY, 300);

      // Fight week: gym at night — darken everything, then relight the monitor
      if (fightWeek) {
        ctx.fillStyle = "rgba(8, 12, 34, 0.52)";
        ctx.fillRect(0, 0, CW, CH);
        if (monitorScreenQuad) {
          const q = monitorScreenQuad;
          const cx0 = (q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4;
          const cy0 = (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4;
          const glow = ctx.createRadialGradient(cx0, cy0, 2, cx0, cy0, 42);
          glow.addColorStop(0, "rgba(220, 232, 255, 0.5)");
          glow.addColorStop(1, "rgba(220, 232, 255, 0)");
          ctx.fillStyle = glow;
          ctx.fillRect(cx0 - 42, cy0 - 42, 84, 84);
          quad(ctx, q, "#f2f6ff", "rgba(255,255,255,0.85)");
        }
      }

      if (hz === "ring") drawRingHover(ctx);

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
    let zone: GymZone | null = null;
    if (view3dRef.current && sceneRef.current) {
      zone = pickGymZone(mx, my, sceneRef.current.homeCamera);
      hoveredRef.current = zone;
      setHoveredZone(zone);
      return;
    }
    for (const hb of HITRECTS) {
      const r = hb.rect;
      if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) { zone = hb.zone; break; }
    }
    if (!zone && pointInDiamond(mx, my, RING_SCR_CX, RING_SCR_CY, RING_SCR_HW, RING_SCR_HH)) zone = "ring";
    hoveredRef.current = zone;
    setHoveredZone(zone);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (popup) { setPopup(null); return; }
    const zone = hoveredRef.current;
    if (!zone) return;
    if (zone === "door") { onExit(); return; }
    if (zone === "office") { onOpenPlanner(); return; }
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
    if (zone === "office") return "Office — Fight Planner";
    if (zone === "equipCrate") return equipUnlocked ? "Equipment Crate — Equipment Upgrades" : "Locked";
    // Stat points live on the permanent strip at the bottom of the screen, so the
    // player's hover label stays short.
    if (zone === "player") return `${displayName} — Lv.${fighter.level} · Rank #${playerRank}`;
    return "";
  };

  // Weekly bonus tag pinned over the matching gym object (canvas coords → %)
  // Screen spot (canvas px) for a tag hung over a gym object: the 3D anchor in
  // 3D graphics, the 2D projection otherwise.
  const tagPos = (zone: GymZone, x2d: number, y2d: number, liftPx = 0): { x: number; y: number } => {
    if (!view3d) return { x: x2d, y: y2d };
    const p = projectGymPoint(gymZoneAnchor(zone));
    return { x: p.x, y: p.y - liftPx };
  };
  // In 3D the render loop re-places anchored tags each frame (camera drift).
  const anchorAttrs = (zone: GymZone, liftPx = 0) =>
    view3d ? { "data-gym-anchor": zone, "data-gym-lift": String(liftPx) } : {};
  const bonusZone: GymZone | null = weeklyBonus
    ? weeklyBonus.trainingType === "heavyBag" ? "bag1" : weeklyBonus.trainingType === "weightLifting" ? "weights" : "ring"
    : null;
  const bonusTagPos = weeklyBonus && view3d
    ? tagPos(weeklyBonus.trainingType === "heavyBag" ? "bag1" : weeklyBonus.trainingType === "weightLifting" ? "weights" : "ring", 0, 0, 4)
    : weeklyBonus
    ? weeklyBonus.trainingType === "heavyBag" ? { x: projX(EQ.bag1.cx), y: projY(EQ.bag1.cz, 64) - 14 }
    : weeklyBonus.trainingType === "weightLifting" ? { x: projX(EQ.bench.cx), y: projY(EQ.bench.cz, 34) - 22 }
    : { x: (RING_SCR_CX - RING_SCR_HW / 2 + RING_SCR_CX) / 2 - 95, y: RING_SCR_CY - RING_SCR_HH / 2 - 22 }
    : null;

  const PopupMenu = () => {
    if (!popup) return null;
    const left = Math.max(4, Math.min(popup.x + 8, window.innerWidth - 215));
    const top = Math.max(4, Math.min(popup.y + 8, window.innerHeight - 200));

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
        style={{ left, top }}
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
        {view3d && (
          <canvas
            ref={glCanvasRef}
            className="absolute inset-0 block pointer-events-none"
            style={{ width: "100%", height: "100%" }}
            data-testid="gym-canvas-3d"
          />
        )}
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
              left: `${(tagPos("lockers", projX(EQ.lockers.cx, EQ.lockers.cz), 0).x / CW) * 100}%`,
              top: `${(tagPos("lockers", 0, projY(EQ.lockers.cz, 62, EQ.lockers.cx)).y / CH) * 100}%`,
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
              left: `${(tagPos("trophyB", projX(EQ.trophyB.cx, EQ.trophyB.cz), 0).x / CW) * 100}%`,
              top: `${(tagPos("trophyB", 0, projY(EQ.trophyB.cz, 58, EQ.trophyB.cx)).y / CH) * 100}%`,
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
              left: `${(tagPos("equipCrate", projX(EQ.equipCrate.cx, EQ.equipCrate.cz), 0).x / CW) * 100}%`,
              top: `${(tagPos("equipCrate", 0, projY(EQ.equipCrate.cz, 30, EQ.equipCrate.cx)).y / CH) * 100}%`,
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

      {/* Popup click-away overlay */}
      {popup && <div className="fixed inset-0 z-[65]" onClick={() => setPopup(null)} />}
      <PopupMenu />
    </div>
  );
}
