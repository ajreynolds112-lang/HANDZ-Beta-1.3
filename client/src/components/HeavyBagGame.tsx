import { useState, useEffect, useRef, useCallback } from "react";
import { isEnterOverlayActive } from "@/hooks/useEnterKey";
import type { Fighter, GearColors } from "@shared/schema";
import { DEFAULT_GEAR_COLORS } from "@shared/schema";
import { soundEngine } from "@/game/sound";
import { drawBoxingGlove, drawBoxingShoe, drawSock, drawLimb, defaultWaistStripeColor } from "@/game/renderer";
import { getTrainingMods } from "@/game/itemEffects";
import { withSavedInventory } from "@/lib/itemInventory";
import type { CareerRosterState } from "@shared/schema";

interface HeavyBagGameProps {
  fighter: Fighter;
  onComplete: (xpGained: number, combos: number) => void;
  onQuit: () => void;
  calcStatPoints?: (combos: number) => number;
  calcXP?: (combos: number) => number;
  isFightPrep?: boolean;
  isIdleWeek?: boolean;
  onLiveXpChange?: (xpGained: number) => void;
  /** Career-best combo count for this activity (0 = no record yet). */
  record?: number;
}

const TOTAL_TIME = 60;
const PUNCH_KEYS = ["Q", "W", "E", "R", "S", "D"];
const XP_PER_COMBO = 2.04;

type PunchType = "jab" | "cross" | "leftHook" | "rightHook" | "leftUppercut" | "rightUppercut";

const KEY_TO_PUNCH: Record<string, PunchType> = {
  Q: "leftHook",
  W: "jab",
  E: "cross",
  R: "rightHook",
  S: "leftUppercut",
  D: "rightUppercut",
};

const PUNCH_IS_LEFT: Record<PunchType, boolean> = {
  jab: true, cross: false, leftHook: true, rightHook: false, leftUppercut: true, rightUppercut: false,
};

/** `lenReduce` is the Heavy Bag of Greatness shortening every combo string. */
function generateCombo(minLen: number, maxLen: number, idleMode?: boolean, lenReduce = 0): string[] {
  const weights = idleMode
    ? [2, 2, 2, 2, 2, 3, 3, 3, 3, 4, 5, 5, 5, 5]
    : [2, 2, 2, 2, 2, 3, 3, 3, 4, 5, 5, 5, 5];
  const len = weights[Math.floor(Math.random() * weights.length)];
  // A one-punch combo is still a combo; never shorten below that.
  const clamped = Math.max(1, Math.max(minLen, Math.min(maxLen, len)) - Math.max(0, lenReduce));
  const combo: string[] = [];
  for (let i = 0; i < clamped; i++) {
    combo.push(PUNCH_KEYS[Math.floor(Math.random() * PUNCH_KEYS.length)]);
  }
  return combo;
}

const FS = 2.08;
const BODY_H = 28 * FS;
const HEAD_R = 6.28 * FS;
const UPPER_ARM_L = 14 * FS;
const FOREARM_L = 12 * FS;
const UPPER_LEG_L = 14 * FS;
const LOWER_LEG_L = 12 * FS;
const GLOVE_R = 5 * FS;
const SHOE_H = 4 * FS;
const TORSO_W = 11.6 * FS;

function shadeColor(color: string, percent: number): string {
  const num = parseInt(color.replace("#", ""), 16);
  if (isNaN(num)) return color;
  const r = Math.min(255, Math.max(0, (num >> 16) + percent));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + percent));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + percent));
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

interface PunchState {
  type: PunchType;
  progress: number;
}

function drawFightFighter(
  ctx: CanvasRenderingContext2D,
  sx: number, baseY: number,
  skinColor: string, gc: GearColors,
  bobPhase: number,
  punch: PunchState | null,
  bagCX: number, bagCY: number,
) {
  const punchDirX = 1;
  const punchDirY = 0;
  const sideView = 1.0;
  const frontView = 0;
  const bodyWidthMult = Math.abs(sideView) * 0.35 + Math.abs(frontView) * 1.0;

  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.beginPath();
  ctx.ellipse(sx, baseY + 2, 18 * FS * 0.6 * bodyWidthMult, 8 * FS * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();

  const bob = Math.sin(bobPhase) * 1.5 * FS;
  const hipY = baseY - LOWER_LEG_L - UPPER_LEG_L + bob;
  const depthShift = frontView * 3;

  const bodyHeight = BODY_H;
  const shoulderY = hipY - bodyHeight;
  const headY = shoulderY - HEAD_R * 1.025;
  const bodyX = sx + depthShift;

  const tW = TORSO_W * 0.5 * bodyWidthMult;
  const shoulderW = tW * 1.12;
  // The torso base is pulled in 15% for a narrower waist; the trunks and the
  // waist stripe keep the original hip width, so they are sized off hipWFull.
  const hipWFull = tW * 0.78;
  const hipW = hipWFull * 0.85;
  const trunkW = hipWFull * 1.16;

  const dp = 0;
  const spreadAngleDeg = 30 + dp * 18;
  const spreadAngleRad = (spreadAngleDeg * Math.PI) / 180;
  const upperLegDx = Math.sin(spreadAngleRad) * UPPER_LEG_L * bodyWidthMult;
  const upperLegDy = Math.cos(spreadAngleRad) * UPPER_LEG_L;

  const rhythmBob = Math.sin(bobPhase) * 2.5 * FS;

  for (let side = -1; side <= 1; side += 2) {
    const isFrontLeg = (punchDirX > 0 && side === 1) || (punchDirX <= 0 && side === -1);
    const hipX = sx + side * upperLegDx * 0.5;

    const perspShift = isFrontLeg ? frontView * 2 * FS : -frontView * 2 * FS;
    const fwdShift = punchDirX * UPPER_LEG_L * 0.15;

    const kneeX = hipX + side * upperLegDx * 0.5 + fwdShift + perspShift;
    const kneeY = hipY + upperLegDy;

    const kneeBendFwd = isFrontLeg
      ? punchDirX * 2 * FS + rhythmBob * 0.2
      : -punchDirX * 6 * FS + rhythmBob * 0.4;

    const footX = kneeX + kneeBendFwd;
    const footY = baseY + bob + Math.abs(rhythmBob) * 0.3;

    const legScale = isFrontLeg ? 1.05 : 0.95;
    const u = FS * legScale;
    const thighTopW = 4.5 * u;
    const thighMidW = 4.7 * u;
    const thighKneeW = 3.3 * u;
    const shinTopW = 3.2 * u;
    const calfW = 3.5 * u;
    const ankleW = 2.2 * u;

    drawLimb(ctx, hipX, hipY, kneeX, kneeY, thighTopW, thighMidW, thighKneeW, skinColor, false, 0.38);

    const trunkLegT = 0.62;
    const trunkEndX = hipX + (kneeX - hipX) * trunkLegT;
    const trunkEndY = hipY + (kneeY - hipY) * trunkLegT;
    const trunkHemW = thighMidW * 0.95 + 1.6 * u;
    drawLimb(ctx, hipX, hipY, trunkEndX, trunkEndY, thighTopW + 2.8 * u, thighMidW + 2.1 * u, trunkHemW, gc.trunks, false, 0.34);

    ctx.strokeStyle = shadeColor(gc.trunks, 30);
    ctx.lineWidth = 1.5 * FS;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(trunkEndX - trunkHemW * 0.5, trunkEndY);
    ctx.lineTo(trunkEndX + trunkHemW * 0.5, trunkEndY);
    ctx.stroke();

    // Shin stops at the ankle so it never pokes out below the shoe.
    const shoeUnit = FS * legScale * 0.92;
    const legT = Math.max(0, 1 - (2.4 * shoeUnit) / Math.max(1, Math.hypot(footX - kneeX, footY - kneeY)));
    const ankleX = kneeX + (footX - kneeX) * legT;
    const ankleY = kneeY + (footY - kneeY) * legT;
    drawLimb(ctx, kneeX, kneeY, ankleX, ankleY, shinTopW, calfW, ankleW, skinColor, false, 0.28);

    const kneeSize = 2.3 * FS * legScale;
    ctx.fillStyle = shadeColor(skinColor, -20);
    ctx.beginPath();
    ctx.arc(kneeX, kneeY, kneeSize, 0, Math.PI * 2);
    ctx.fill();

    drawSock(ctx, footX, footY - 3.2 * shoeUnit, kneeX, kneeY, ankleW * 1.35, gc.socks || "#f0f0f0", false);
    drawBoxingShoe(ctx, footX, footY, shoeUnit, punchDirX >= 0 ? 1 : -1, gc.shoes, false, 0, false, gc.laces, gc.soles);
  }

  const capR = Math.min(shoulderW * 0.42, 3.2 * FS);
  const capDrop = capR * 0.85;
  const latT = 0.42;
  const latY = shoulderY + (hipY - shoulderY) * latT;
  const latMidX = bodyX + (sx - bodyX) * latT;
  const latHalf = shoulderW + (hipW - shoulderW) * latT + tW * 0.1;
  ctx.fillStyle = skinColor;
  ctx.beginPath();
  ctx.moveTo(bodyX - shoulderW, shoulderY + capDrop);
  ctx.quadraticCurveTo(bodyX - shoulderW, shoulderY, bodyX - shoulderW + capR, shoulderY);
  ctx.lineTo(bodyX + shoulderW - capR, shoulderY);
  ctx.quadraticCurveTo(bodyX + shoulderW, shoulderY, bodyX + shoulderW, shoulderY + capDrop);
  ctx.quadraticCurveTo(latMidX + latHalf, latY, sx + hipW, hipY);
  ctx.lineTo(sx - hipW, hipY);
  ctx.quadraticCurveTo(latMidX - latHalf, latY, bodyX - shoulderW, shoulderY + capDrop);
  ctx.closePath();
  ctx.fill();

  const trunkTopFrac = 0.35;
  const trunkTopX = sx + (bodyX - sx) * (1 - trunkTopFrac);
  const trunkTop = hipY - bodyHeight * trunkTopFrac;
  ctx.fillStyle = gc.trunks;
  ctx.beginPath();
  ctx.moveTo(trunkTopX - trunkW * 0.94, trunkTop);
  ctx.lineTo(trunkTopX + trunkW * 0.94, trunkTop);
  ctx.lineTo(sx + trunkW, hipY);
  ctx.lineTo(sx - trunkW, hipY);
  ctx.closePath();
  ctx.fill();

  // Waist stripe on top of the trunks (mirrors the in-ring renderer).
  const stripeCol = gc.waistStripe || defaultWaistStripeColor(gc.trunks);
  const stripeX = trunkTopX - trunkW * 0.94;
  const stripeW = trunkW * 1.88;
  const stripeH = 3.6 * FS;
  ctx.fillStyle = stripeCol;
  ctx.fillRect(stripeX, trunkTop, stripeW, stripeH);
  ctx.fillStyle = shadeColor(stripeCol, -40);
  ctx.globalAlpha = 0.5;
  ctx.fillRect(stripeX, trunkTop + stripeH - 0.8 * FS, stripeW, 0.8 * FS);
  ctx.globalAlpha = 1;

  const fwdOff = punchDirX * 5 * FS;
  const headShift = frontView * 2 + fwdOff;
  // Neck first, then the head caps it.
  drawLimb(
    ctx, bodyX + headShift * 0.3, shoulderY + HEAD_R * 0.15,
    bodyX + headShift, headY + HEAD_R * 0.5,
    HEAD_R * 0.74, HEAD_R * 0.66, HEAD_R * 0.6,
    shadeColor(skinColor, -12), false, 0.5,
  );
  ctx.fillStyle = skinColor;
  ctx.beginPath();
  ctx.arc(bodyX + headShift, headY, HEAD_R, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#1a1a1a";
  const eyeSpread = HEAD_R * 0.36 * bodyWidthMult;
  const eyeOff = frontView * HEAD_R * 0.3;
  const eyeX1 = bodyX + headShift + eyeOff - eyeSpread;
  const eyeX2 = bodyX + headShift + eyeOff + eyeSpread;
  const eyeYPos = headY - HEAD_R * 0.15;
  ctx.beginPath(); ctx.arc(eyeX1, eyeYPos, HEAD_R * 0.17, 0, Math.PI * 2); ctx.fill();
  ctx.beginPath(); ctx.arc(eyeX2, eyeYPos, HEAD_R * 0.17, 0, Math.PI * 2); ctx.fill();

  const shoulderSpread = 9.8 * FS * bodyWidthMult;
  const fullArmReach = (UPPER_ARM_L + FOREARM_L) * 2.0;
  const fwdOffX = punchDirX * 4 * FS;
  const fwdOffY = punchDirY * 2 * FS;

  for (let side = -1; side <= 1; side += 2) {
    const isLeft = side === -1;
    const shoulderX = bodyX + side * shoulderSpread * 0.5;
    const sY = shoulderY + 3 * FS;

    let elbowX: number, elbowY: number;
    let gloveX: number, gloveY: number;

    const isPunchingSide = punch && (
      (isLeft && PUNCH_IS_LEFT[punch.type]) ||
      (!isLeft && !PUNCH_IS_LEFT[punch.type])
    );

    if (isPunchingSide && punch) {
      const progress = punch.progress;
      const isHook = punch.type.includes("Hook");
      const isUppercut = punch.type.includes("Uppercut");

      const hookReachMult = 0.8;
      const uppercutReachMult = 0.6;
      const reachMult = isHook ? hookReachMult : isUppercut ? uppercutReachMult : 1.0;
      const toBagDist = Math.max(1, Math.sqrt((bagCX - sx) ** 2 + (bagCY - shoulderY) ** 2));
      const targetReach = Math.min(fullArmReach * reachMult, toBagDist * 0.95);
      const reachAtProgress = targetReach * progress;

      if (isHook) {
        const arcT = Math.sin(progress * Math.PI);
        const upwardArc = -arcT * 12 * FS / 65;
        const perpX = -punchDirY;
        gloveX = shoulderX + punchDirX * reachAtProgress + perpX * arcT * side * 8 * FS / 65;
        gloveY = sY + upwardArc + bob;
        elbowX = shoulderX + (gloveX - shoulderX) * 0.45 + perpX * side * 4 * FS / 65;
        elbowY = sY + (gloveY - sY) * 0.5 + 2 * FS + bob;
      } else if (isUppercut) {
        const arcT = Math.sin(progress * Math.PI);
        const downDip = arcT * (1 - progress) * 10 * FS / 65;
        const upRise = progress * progress * 20 * FS / 65;
        gloveX = shoulderX + punchDirX * reachAtProgress * 0.7;
        gloveY = sY + downDip - upRise + bob;
        elbowX = shoulderX + (gloveX - shoulderX) * 0.5;
        elbowY = sY + (gloveY - sY) * 0.4 + 4 * FS + bob;
      } else {
        gloveX = shoulderX + punchDirX * reachAtProgress;
        gloveY = sY + punchDirY * reachAtProgress * 0.4 - 5 * FS + bob;
        elbowX = shoulderX + punchDirX * reachAtProgress * 0.5;
        elbowY = sY + punchDirY * reachAtProgress * 0.3 + 4 * FS + bob;
      }
    } else {
      const downElbowX = shoulderX + side * 5 * FS * bodyWidthMult + fwdOffX * 0.4;
      const downElbowY = sY + UPPER_ARM_L * 0.7 + bob + fwdOffY * 0.3;
      const downGloveX = shoulderX + side * 2 * bodyWidthMult + fwdOffX;
      const downGloveY = sY + UPPER_ARM_L * 0.3 + bob + fwdOffY;

      const upElbowX = shoulderX + side * 4 * FS * bodyWidthMult + fwdOffX * 0.7;
      const upElbowY = sY + 6 * FS + bob + fwdOffY * 0.5;
      const upGloveX = shoulderX + fwdOffX * 1.8 + side * 2 * FS * bodyWidthMult;
      const guardLift = 2 * FS * 1.05 + 15;
      const upGloveY = sY - guardLift + bob + fwdOffY;

      const gb = 0.7;
      elbowX = downElbowX + (upElbowX - downElbowX) * gb;
      elbowY = downElbowY + (upElbowY - downElbowY) * gb;
      gloveX = downGloveX + (upGloveX - downGloveX) * gb;
      gloveY = downGloveY + (upGloveY - downGloveY) * gb;
    }

    const wristT = Math.max(0, 1 - (GLOVE_R * 0.55) / Math.max(1, Math.hypot(gloveX - elbowX, gloveY - elbowY)));
    const wristX = elbowX + (gloveX - elbowX) * wristT;
    const wristY = elbowY + (gloveY - elbowY) * wristT;
    drawLimb(ctx, shoulderX, sY, elbowX, elbowY, 3.6 * FS, 3.9 * FS, 2.7 * FS, skinColor, false, 0.36);
    drawLimb(ctx, elbowX, elbowY, wristX, wristY, 2.9 * FS, 3.1 * FS, 2.2 * FS, skinColor, false, 0.3);

    ctx.fillStyle = shadeColor(skinColor, -10);
    ctx.beginPath();
    ctx.arc(shoulderX, sY, 2.5 * FS, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shadeColor(skinColor, -20);
    ctx.beginPath();
    ctx.arc(elbowX, elbowY, 1.9 * FS, 0, Math.PI * 2);
    ctx.fill();

    drawBoxingGlove(
      ctx, gloveX, gloveY, GLOVE_R,
      gloveX - elbowX, gloveY - elbowY,
      gc.gloves, gc.gloveTape || "#eeeeee",
      1, false,
    );
  }
}

// Gym-style leather heavy bag art — ported from GymView's drawHeavyBag
function drawHeavyBagArt(
  ctx: CanvasRenderingContext2D,
  anchorX: number,   // chain ceiling anchor (no swing)
  cx: number,        // bag center X (includes swing)
  bagTopY: number,   // top of bag body
  halfW: number,     // horizontal half-width (pixels)
  totalH: number,    // total height of bag body (pixels)
  hitFlash: number   // 0–1 flash intensity
): void {
  const bagCenterY = bagTopY + totalH / 2;
  const bagBottomY = bagTopY + totalH;

  // Chain from ceiling anchor to bag top
  ctx.strokeStyle = "#777777"; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.moveTo(anchorX, bagTopY - 50); ctx.lineTo(cx, bagTopY); ctx.stroke();

  // Chain links
  ctx.strokeStyle = "#888"; ctx.lineWidth = 1.5;
  for (let i = 0; i < 5; i++) {
    const t = (i + 0.5) / 5;
    const lx = anchorX + (cx - anchorX) * t;
    const ly = bagTopY - 50 + 50 * t;
    ctx.beginPath(); ctx.ellipse(lx, ly, 3, 5, 0, 0, Math.PI * 2); ctx.stroke();
  }

  // Mount bracket at top of bag
  ctx.fillStyle = "#4a4a4a"; ctx.fillRect(cx - 11, bagTopY - 9, 22, 9);

  // Bag body — leather gradient with rounded rect
  const bg = ctx.createLinearGradient(cx - halfW, bagTopY, cx + halfW, bagTopY);
  bg.addColorStop(0, "#4a1515"); bg.addColorStop(0.3, "#8b3a3a");
  bg.addColorStop(0.7, "#8b3a3a"); bg.addColorStop(1, "#3a1010");
  ctx.fillStyle = bg;
  const r = 8;
  ctx.beginPath();
  ctx.moveTo(cx - halfW + r, bagTopY);
  ctx.lineTo(cx + halfW - r, bagTopY);
  ctx.arcTo(cx + halfW, bagTopY, cx + halfW, bagTopY + r, r);
  ctx.lineTo(cx + halfW, bagBottomY - r);
  ctx.arcTo(cx + halfW, bagBottomY, cx + halfW - r, bagBottomY, r);
  ctx.lineTo(cx - halfW + r, bagBottomY);
  ctx.arcTo(cx - halfW, bagBottomY, cx - halfW, bagBottomY - r, r);
  ctx.lineTo(cx - halfW, bagTopY + r);
  ctx.arcTo(cx - halfW, bagTopY, cx - halfW + r, bagTopY, r);
  ctx.closePath();
  ctx.fill();

  // Highlight stripe
  ctx.fillStyle = "rgba(255,130,100,0.10)";
  ctx.fillRect(cx - halfW * 0.5, bagTopY + 5, halfW * 0.7, totalH - 10);

  // Seam lines
  ctx.strokeStyle = "#ccc"; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.28;
  ctx.beginPath(); ctx.moveTo(cx - halfW + 2, bagCenterY - totalH * 0.18); ctx.lineTo(cx + halfW - 2, bagCenterY - totalH * 0.18); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(cx - halfW + 2, bagCenterY + totalH * 0.13); ctx.lineTo(cx + halfW - 2, bagCenterY + totalH * 0.13); ctx.stroke();
  ctx.globalAlpha = 1;

  // Bottom cap ellipse
  ctx.fillStyle = "#3a1010";
  ctx.beginPath(); ctx.ellipse(cx, bagBottomY, halfW * 0.9, halfW * 0.28, 0, 0, Math.PI * 2); ctx.fill();

  // Hit flash
  if (hitFlash > 0) {
    ctx.fillStyle = `rgba(255,255,100,${hitFlash * 0.6})`;
    ctx.beginPath(); ctx.arc(cx - halfW / 2 + 5, bagCenterY, 12, 0, Math.PI * 2); ctx.fill();
  }
}

export default function HeavyBagGame({ fighter, onComplete, onQuit, calcStatPoints, calcXP, isFightPrep, isIdleWeek, onLiveXpChange, record }: HeavyBagGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [countdown, setCountdown] = useState(3);
  const [timeLeft, setTimeLeft] = useState(TOTAL_TIME);
  const [combos, setCombos] = useState(0);
  // Heavy Bag of Greatness shortens every combo string for this session.
  const comboLenReduceRef = useRef(
    getTrainingMods(withSavedInventory(fighter), fighter.careerRosterState as CareerRosterState | null, "heavyBag").comboLenReduce,
  );
  const [currentCombo, setCurrentCombo] = useState<string[]>(() => generateCombo(2, 4, isIdleWeek, comboLenReduceRef.current));
  const [comboIndex, setComboIndex] = useState(0);
  const [missFlash, setMissFlash] = useState(0);
  const [hitFlash, setHitFlash] = useState(0);
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);
  const [pauseIndex, setPauseIndex] = useState(0);
  const [bagSwing, setBagSwing] = useState(0);
  const [currentPunch, setCurrentPunch] = useState<PunchState | null>(null);
  const [bobPhase, setBobPhase] = useState(0);
  const animRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const countdownRef = useRef(3);
  const stateRef = useRef({ timeLeft: TOTAL_TIME, paused: false, finished: false });
  const comboRef = useRef(currentCombo);
  const comboIndexRef = useRef(0);
  const timeLeftRef = useRef(TOTAL_TIME);
  const clutchRepsRef = useRef(0);
  const combosRef = useRef(0);
  const [finishEarlyConfirm, setFinishEarlyConfirm] = useState(false);
  const finishEarlyConfirmRef = useRef(false);
  const calcXPRef = useRef(calcXP);
  const onLiveXpChangeRef = useRef(onLiveXpChange);
  useEffect(() => { calcXPRef.current = calcXP; onLiveXpChangeRef.current = onLiveXpChange; }, [calcXP, onLiveXpChange]);

  const gc = (fighter.gearColors as GearColors) || DEFAULT_GEAR_COLORS;
  const skinColor = fighter.skinColor || "#e8c4a0";

  useEffect(() => {
    stateRef.current = { timeLeft, paused, finished };
    timeLeftRef.current = timeLeft;
  }, [timeLeft, paused, finished]);

  useEffect(() => {
    countdownRef.current = countdown;
  }, [countdown]);

  useEffect(() => {
    finishEarlyConfirmRef.current = finishEarlyConfirm;
  }, [finishEarlyConfirm]);

  useEffect(() => {
    const tick = (now: number) => {
      if (!lastTimeRef.current) lastTimeRef.current = now;
      const dt = (now - lastTimeRef.current) / 1000;
      lastTimeRef.current = now;

      if (countdownRef.current > 0) {
        setCountdown(prev => {
          const next = prev - dt;
          if (next <= 0) return 0;
          return next;
        });
        animRef.current = requestAnimationFrame(tick);
        return;
      }

      if (!stateRef.current.paused && !stateRef.current.finished) {
        setTimeLeft(prev => {
          const next = prev - dt;
          if (next <= 0) {
            setFinished(true);
            return 0;
          }
          return next;
        });
        setBobPhase(prev => prev + dt * 3.5);
      }

      setMissFlash(prev => Math.max(0, prev - dt * 4));
      setHitFlash(prev => Math.max(0, prev - dt * 4));
      setBagSwing(prev => prev * 0.95);
      setCurrentPunch(prev => {
        if (!prev) return null;
        const next = prev.progress + dt * 5;
        if (next >= 1) return null;
        return { ...prev, progress: next };
      });

      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  const handleFinishEarlyConfirm = useCallback(() => {
    const penalizedCombos = Math.max(0, combosRef.current - 1);
    combosRef.current = penalizedCombos;
    setCombos(penalizedCombos);
    setFinishEarlyConfirm(false);
    finishEarlyConfirmRef.current = false;
    setPaused(false);
    setFinished(true);
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (countdownRef.current > 0) return;
    if (stateRef.current.finished) return;

    if (e.key === "Escape") {
      e.preventDefault();
      if (finishEarlyConfirmRef.current) {
        setFinishEarlyConfirm(false);
        finishEarlyConfirmRef.current = false;
      } else {
        setPaused(p => !p);
      }
      return;
    }

    if (stateRef.current.paused) {
      if (finishEarlyConfirmRef.current) {
        if (e.key === "Enter") {
          e.preventDefault();
          handleFinishEarlyConfirm();
        }
        return;
      }
      if (e.key === "ArrowUp") { e.preventDefault(); setPauseIndex(prev => (prev + 2) % 3); }
      if (e.key === "ArrowDown") { e.preventDefault(); setPauseIndex(prev => (prev + 1) % 3); }
      if (e.key === "Enter") {
        e.preventDefault();
        setPauseIndex(prev => {
          if (prev === 0) setPaused(false);
          else if (prev === 1) onQuit();
          else if (prev === 2) {
            setFinishEarlyConfirm(true);
            finishEarlyConfirmRef.current = true;
          }
          return prev;
        });
      }
      return;
    }

    const key = e.key.toUpperCase();
    if (!PUNCH_KEYS.includes(key)) return;
    e.preventDefault();

    const punchType = KEY_TO_PUNCH[key];
    if (punchType) {
      setCurrentPunch({ type: punchType, progress: 0 });
    }
    soundEngine.trainingPunchHit();

    const combo = comboRef.current;
    const idx = comboIndexRef.current;
    if (key === combo[idx]) {
      setHitFlash(1);
      setBagSwing(prev => prev + 5);
      const nextIdx = idx + 1;
      if (nextIdx >= combo.length) {
        combosRef.current += 1;
        setCombos(combosRef.current);
        onLiveXpChangeRef.current?.(calcXPRef.current?.(combosRef.current) ?? combosRef.current * XP_PER_COMBO);
        soundEngine.trainingDing();
        const tl = timeLeftRef.current;
        if (tl <= 10 && tl > 0 && TOTAL_TIME > 10) {
          clutchRepsRef.current++;
          if (clutchRepsRef.current >= 2) {
            clutchRepsRef.current = 0;
            setTimeLeft(t => t + 2);
          }
        }
        const elapsed = TOTAL_TIME - tl;
        const newCombo = generateCombo(2, elapsed < 15 ? 4 : 5, isIdleWeek, comboLenReduceRef.current);
        setCurrentCombo(newCombo);
        comboRef.current = newCombo;
        comboIndexRef.current = 0;
        setComboIndex(0);
      } else {
        comboIndexRef.current = nextIdx;
        setComboIndex(nextIdx);
      }
    } else {
      setMissFlash(1);
      soundEngine.trainingBuzz();
      comboIndexRef.current = 0;
      setComboIndex(0);
    }
  }, [onQuit, onComplete, fighter, handleFinishEarlyConfirm]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const handleCanvasClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!paused || finished) return;
    if (finishEarlyConfirm) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const cx = x * scaleX;
    const cy = y * scaleY;

    const W = canvas.width;
    const H = canvas.height;
    const menuItems = ["Resume", "Quit", "Finish Early"];
    menuItems.forEach((_, i) => {
      const iy = H / 2 - 10 + i * 35;
      if (cx > W / 2 - 80 && cx < W / 2 + 80 && cy > iy - 15 && cy < iy + 10) {
        if (i === 0) setPaused(false);
        else if (i === 1) onQuit();
        else if (i === 2) {
          setFinishEarlyConfirm(true);
          finishEarlyConfirmRef.current = true;
        }
      }
    });
  }, [paused, finished, onQuit, finishEarlyConfirm]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    const wallGrad = ctx.createLinearGradient(0, 0, 0, H);
    wallGrad.addColorStop(0, "#2a2a3a");
    wallGrad.addColorStop(0.5, "#252535");
    wallGrad.addColorStop(1, "#1e1e2e");
    ctx.fillStyle = wallGrad;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "#333348";
    ctx.lineWidth = 0.5;
    for (let bx = 0; bx < W; bx += 40) {
      ctx.beginPath(); ctx.moveTo(bx, 0); ctx.lineTo(bx, H * 0.62); ctx.stroke();
    }
    for (let by = 0; by < H * 0.62; by += 25) {
      ctx.beginPath(); ctx.moveTo(0, by); ctx.lineTo(W, by); ctx.stroke();
    }

    const floorY = H * 0.62;
    const floorGrad = ctx.createLinearGradient(0, floorY, 0, H);
    floorGrad.addColorStop(0, "#7B5230");
    floorGrad.addColorStop(0.2, "#6B4226");
    floorGrad.addColorStop(1, "#4A2E1A");
    ctx.fillStyle = floorGrad;
    ctx.fillRect(0, floorY, W, H - floorY);
    ctx.strokeStyle = "#8a6040";
    ctx.lineWidth = 0.5;
    for (let px = 0; px < W; px += 50) {
      ctx.beginPath(); ctx.moveTo(px, floorY); ctx.lineTo(px, H); ctx.stroke();
    }
    ctx.fillStyle = "#444460";
    ctx.fillRect(0, floorY - 3, W, 3);

    ctx.strokeStyle = "#444466";
    ctx.lineWidth = 3;
    const ringLeft = 10;
    const ropeY1 = floorY - 60;
    const ropeY2 = floorY - 35;
    const ropeY3 = floorY - 10;
    ctx.fillStyle = "#3a3a4a";
    ctx.fillRect(ringLeft, ropeY1 - 5, 6, floorY - ropeY1 + 5);
    ctx.fillRect(ringLeft + 50, ropeY1 - 5, 6, floorY - ropeY1 + 5);
    ctx.strokeStyle = "#dd3333";
    ctx.lineWidth = 2;
    [ropeY1, ropeY2, ropeY3].forEach(ry => {
      ctx.beginPath(); ctx.moveTo(ringLeft + 3, ry); ctx.lineTo(ringLeft + 53, ry); ctx.stroke();
    });

    ctx.fillStyle = "#cc8800";
    ctx.fillRect(W - 55, floorY - 50, 20, 50);
    ctx.fillRect(W - 55, floorY - 50, 20, 8);
    ctx.fillStyle = "#ffcc00";
    ctx.beginPath();
    ctx.moveTo(W - 45, floorY - 58);
    ctx.lineTo(W - 50, floorY - 50);
    ctx.lineTo(W - 40, floorY - 50);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#aa7700";
    ctx.fillRect(W - 30, floorY - 40, 15, 40);

    const framePositions = [
      { x: 30, y: 50, w: 30, h: 22 },
      { x: 80, y: 40, w: 25, h: 30 },
      { x: W - 90, y: 45, w: 28, h: 22 },
      { x: W - 130, y: 55, w: 24, h: 20 },
      { x: 140, y: 35, w: 22, h: 28 },
      { x: W - 50, y: 60, w: 20, h: 16 },
    ];
    framePositions.forEach(f => {
      ctx.fillStyle = "#5a4020";
      ctx.fillRect(f.x - 2, f.y - 2, f.w + 4, f.h + 4);
      ctx.fillStyle = "#3a3a4a";
      ctx.fillRect(f.x, f.y, f.w, f.h);
      ctx.fillStyle = "#cc4444";
      const bx = f.x + f.w * 0.3;
      const by = f.y + f.h * 0.4;
      ctx.beginPath(); ctx.arc(bx, by, Math.min(f.w, f.h) * 0.2, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#ddccaa";
      ctx.beginPath(); ctx.arc(bx + f.w * 0.25, by + 2, 2, 0, Math.PI * 2); ctx.fill();
    });

    const smallBagX = W - 70;
    const smallBagY = 110;
    ctx.strokeStyle = "#666666";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(smallBagX, smallBagY - 20); ctx.lineTo(smallBagX, smallBagY - 5); ctx.stroke();
    ctx.fillStyle = "#8B4513";
    ctx.beginPath(); ctx.ellipse(smallBagX, smallBagY, 8, 12, 0, 0, Math.PI * 2); ctx.fill();

    const bgBagX = 60;
    const bgBagTopY = 95;
    ctx.strokeStyle = "#555555";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(bgBagX, bgBagTopY - 30); ctx.lineTo(bgBagX, bgBagTopY); ctx.stroke();
    ctx.fillStyle = "#6a3510";
    ctx.beginPath(); ctx.ellipse(bgBagX, bgBagTopY + 25, 14, 28, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#4a2508";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(bgBagX, bgBagTopY + 25, 14, 28, 0, 0, Math.PI * 2); ctx.stroke();

    const bagAnchorX = W / 2 + 100;
    const bagCX = bagAnchorX + bagSwing;
    const bagTopY = floorY - 220;
    const bagW = 60;
    const bagH = 114;

    drawHeavyBagArt(ctx, bagAnchorX, bagCX, bagTopY, bagW / 2, bagH, hitFlash);

    const figX = W / 2 - 30;
    const figBaseY = floorY - 5;
    drawFightFighter(ctx, figX, figBaseY, skinColor, gc, bobPhase, currentPunch, bagCX, bagTopY + bagH / 2);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 24px monospace";
    ctx.textAlign = "center";
    ctx.fillText("HEAVY BAG", W / 2, 32);

    ctx.font = "15px monospace";
    ctx.fillStyle = "#aaaacc";
    ctx.fillText(`${fighter.firstName || fighter.name}`, W / 2, 54);

    ctx.font = "bold 32px monospace";
    ctx.fillStyle = timeLeft <= 10 ? "#ff4444" : "#ffffff";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.ceil(timeLeft)}s`, W - 25, 38);
    ctx.textAlign = "center";

    // Personal best: the live counter turns gold the moment the record falls,
    // and the combo that would break it is called out first.
    const bestRecord = Math.max(0, Math.floor(record ?? 0));
    const recordBroken = bestRecord > 0 && combos > bestRecord;
    const oneAwayFromRecord = bestRecord > 0 && combos === bestRecord;

    ctx.font = "bold 42px monospace";
    ctx.textAlign = "left";
    if (recordBroken) {
      ctx.save();
      ctx.shadowColor = "rgba(255, 190, 0, 0.9)";
      ctx.shadowBlur = 16;
      ctx.fillStyle = "#ffd700";
      ctx.fillText(`${combos}`, 25, 100);
      ctx.restore();
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`${combos}`, 25, 100);
    }
    ctx.font = "15px monospace";
    ctx.fillStyle = "#aaaacc";
    ctx.fillText("COMBOS", 25, 118);

    if (bestRecord > 0) {
      ctx.font = "bold 14px monospace";
      ctx.fillStyle = recordBroken ? "#ffd700" : "#8f8fbb";
      ctx.fillText(`BEST ${bestRecord}`, 25, 140);
      if (oneAwayFromRecord) {
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(Date.now() / 220));
        ctx.fillStyle = "#ffd700";
        ctx.fillText("BREAK YOUR RECORD!", 25, 160);
        ctx.restore();
      }
    }
    ctx.textAlign = "center";

    if (timeLeft <= 10 && timeLeft > 0 && countdown <= 0 && !finished) {
      ctx.fillStyle = "#44ff44";
      ctx.font = "bold 13px monospace";
      ctx.textAlign = "center";
      ctx.fillText("+2s every 2 combos!", W / 2, 140);
    }

    const comboY = H - 75;
    const letterW = 44;
    const totalComboW = currentCombo.length * letterW;
    const startX = (W - totalComboW) / 2;

    ctx.save();
    ctx.globalAlpha = countdown <= 0 ? 1 : 0;
    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(startX - 14, comboY - 28, totalComboW + 28, 48);

    const punchLabels: Record<string, string> = {
      Q: "L.HK", W: "JAB", E: "CRS", R: "R.HK", S: "L.UP", D: "R.UP",
    };

    currentCombo.forEach((letter, i) => {
      const x = startX + i * letterW + letterW / 2;
      if (i < comboIndex) {
        ctx.fillStyle = "#44ff44";
        ctx.font = "bold 28px monospace";
      } else if (i === comboIndex) {
        ctx.fillStyle = "#ffffff";
        ctx.font = "bold 34px monospace";
      } else {
        ctx.fillStyle = "#555577";
        ctx.font = "24px monospace";
      }
      ctx.fillText(letter, x, comboY - 2);

      ctx.font = "9px monospace";
      ctx.fillStyle = i < comboIndex ? "#33cc33" : i === comboIndex ? "#aaaacc" : "#444466";
      ctx.fillText(punchLabels[letter] || letter, x, comboY + 14);

      if (i === comboIndex) {
        ctx.strokeStyle = "#ffffff";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x - 14, comboY + 20);
        ctx.lineTo(x + 14, comboY + 20);
        ctx.stroke();
      }
    });
    ctx.restore();

    if (!finished && countdown <= 0) {
      ctx.fillStyle = "#777799";
      ctx.font = "13px monospace";
      ctx.fillText("[ESC] Pause", W / 2, H - 10);
    }

    if (missFlash > 0) {
      ctx.fillStyle = `rgba(255,30,30,${missFlash * 0.12})`;
      ctx.fillRect(0, 0, W, H);
    }

    if (countdown > 0) {
      ctx.fillStyle = "rgba(0,0,0,0.5)";
      ctx.fillRect(0, 0, W, H);
      const count = Math.ceil(countdown);
      const frac = countdown - Math.floor(countdown);
      const scale = 1 + frac * 0.5;
      ctx.save();
      ctx.translate(W / 2, H / 2 - 30);
      ctx.scale(scale, scale);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 72px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.globalAlpha = 0.5 + frac * 0.5;
      ctx.fillText(count.toString(), 0, 0);
      ctx.restore();
      ctx.fillStyle = "#aaaacc";
      ctx.font = "14px monospace";
      ctx.textAlign = "center";
      ctx.fillText("Get ready...", W / 2, H / 2 + 30);
    }

    if (paused && !finished) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 24px monospace";
      ctx.textAlign = "center";
      ctx.fillText("PAUSED", W / 2, H / 2 - 60);

      if (finishEarlyConfirm) {
        ctx.fillStyle = "#ffcc00";
        ctx.font = "bold 20px monospace";
        ctx.fillText("Finish early?", W / 2, H / 2);
      } else {
        const menuItems = ["Resume", "Quit", "Finish Early"];
        menuItems.forEach((item, i) => {
          const y = H / 2 - 10 + i * 35;
          const isSelected = i === pauseIndex;
          ctx.fillStyle = isSelected ? "#ffcc00" : "#888888";
          ctx.font = isSelected ? "bold 18px monospace" : "16px monospace";
          ctx.fillText(`${isSelected ? "> " : "  "}${item}`, W / 2, y);
        });
      }
    }

    if (finished) {
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#ffcc00";
      ctx.font = "bold 34px monospace";
      ctx.textAlign = "center";
      ctx.fillText("TIME'S UP!", W / 2, H / 2 - 80);

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px monospace";
      ctx.fillText(`${combos} Combos`, W / 2, H / 2 - 35);

      const xp = calcXP ? Math.ceil(calcXP(combos)) : Math.floor(combos * XP_PER_COMBO);
      ctx.fillStyle = "#44ff44";
      ctx.font = "22px monospace";
      ctx.fillText(`+${xp} XP`, W / 2, H / 2 + 5);

      if (calcStatPoints) {
        const actualPts = calcStatPoints(combos);
        if (actualPts > 0) {
          ctx.fillStyle = "#ffaa00";
          ctx.font = "bold 18px monospace";
          ctx.fillText(`+${actualPts} Stat Point${actualPts !== 1 ? "s" : ""}`, W / 2, H / 2 + 35);
        }
        if (isFightPrep) {
          ctx.fillStyle = "#ffd700";
          ctx.font = "bold 13px monospace";
          ctx.fillText("FIGHT PREP BONUS", W / 2, H / 2 + 55);
        }
      } else if (combos > 30) {
        const bonusSP = Math.floor((combos - 30) / 2);
        ctx.fillStyle = "#ffaa00";
        ctx.font = "bold 18px monospace";
        ctx.fillText(`+${bonusSP} Bonus Skill Point${bonusSP !== 1 ? "s" : ""}!`, W / 2, H / 2 + 35);
      }

      const statLineY = calcStatPoints && isFightPrep ? H / 2 + 72 : H / 2 + 65;
      ctx.fillStyle = "#aaaacc";
      ctx.font = "16px monospace";
      ctx.fillText("+Speed +Power bonus", W / 2, statLineY);

      ctx.fillStyle = "#888888";
      ctx.font = "15px monospace";
      ctx.fillText("Press [ENTER] or Click to continue", W / 2, statLineY + 35);
    }
  }, [countdown, timeLeft, combos, currentCombo, comboIndex, missFlash, hitFlash, paused, finished, pauseIndex, bagSwing, fighter, skinColor, gc, currentPunch, bobPhase, finishEarlyConfirm, record]);

  useEffect(() => {
    if (!finished) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        // A popup layered over the recap answers Enter itself.
        if (isEnterOverlayActive()) return;
        onComplete(Math.floor(combos * XP_PER_COMBO), combos);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finished, combos, onComplete]);

  const handleFinishedClick = useCallback(() => {
    if (finished) {
      onComplete(Math.floor(combos * XP_PER_COMBO), combos);
    }
  }, [finished, combos, onComplete]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="relative" style={{ width: "min(100vw, 720px)", height: "min(85vh, 620px)" }}>
        <canvas
          ref={canvasRef}
          width={720}
          height={620}
          className="border border-border rounded-md cursor-pointer max-w-full max-h-[90vh]"
          style={{ width: "100%", height: "100%" }}
          data-testid="canvas-heavy-bag"
          onClick={(e) => {
            if (finished) handleFinishedClick();
            else handleCanvasClick(e);
          }}
        />
        {finishEarlyConfirm && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
            <div className="flex gap-4 pointer-events-auto">
              <button
                data-testid="button-finish-early-confirm"
                className="px-6 py-2 bg-yellow-500 hover:bg-yellow-400 text-black font-bold rounded text-sm"
                onClick={handleFinishEarlyConfirm}
              >
                Confirm
              </button>
              <button
                data-testid="button-finish-early-cancel"
                className="px-6 py-2 bg-gray-600 hover:bg-gray-500 text-white font-bold rounded text-sm"
                onClick={() => { setFinishEarlyConfirm(false); finishEarlyConfirmRef.current = false; }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
