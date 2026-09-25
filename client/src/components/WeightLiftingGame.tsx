import { useState, useEffect, useRef, useCallback } from "react";
import { isEnterOverlayActive } from "@/hooks/useEnterKey";
import type { Fighter, GearColors } from "@shared/schema";
import { DEFAULT_GEAR_COLORS } from "@shared/schema";
import { soundEngine } from "@/game/sound";
import { getTrainingMods } from "@/game/itemEffects";
import { withSavedInventory } from "@/lib/itemInventory";
import type { CareerRosterState } from "@shared/schema";

interface WeightLiftingGameProps {
  fighter: Fighter;
  onComplete: (xpGained: number, reps: number) => void;
  onQuit: () => void;
  calcStatPoints?: (reps: number) => number;
  calcXP?: (reps: number) => number;
  isFightPrep?: boolean;
  isIdleWeek?: boolean;
  playerRank?: number;
  hasBeatenChampion?: boolean;
  onLiveXpChange?: (xpGained: number) => void;
  /** Career-best rep count for this activity (0 = no record yet). */
  record?: number;
}

const CHAMP_BEATEN_KEY = "handz_champ_beaten_wl";

function getAutoIntervalMs(rank: number, champBeaten: boolean): number | null {
  if (champBeaten) return 100;
  if (rank >= 2 && rank <= 50) return 125;
  if (rank >= 51 && rank <= 100) return 150;
  if (rank >= 101 && rank <= 150) return 175;
  if (rank >= 151 && rank <= 200) return 200;
  if (rank >= 201 && rank <= 250) return 225;
  if (rank >= 251 && rank <= 400) return 250;
  if (rank >= 401 && rank <= 450) return 275;
  if (rank >= 451 && rank <= 500) return 300;
  if (rank >= 501 && rank <= 550) return 325;
  if (rank >= 551 && rank <= 600) return 350;
  if (rank >= 601 && rank <= 650) return 375;
  return null;
}

const TOTAL_TIME = 20;
const BASE_PRESSES_PER_REP = 12;
const XP_PER_REP = 3.6;
const SINK_PAUSE_THRESHOLD = 0.5;
const DECAY_INTERVAL = 0.3;

export default function WeightLiftingGame({ fighter, onComplete, onQuit, calcStatPoints, calcXP, isFightPrep, isIdleWeek, playerRank, hasBeatenChampion, onLiveXpChange, record }: WeightLiftingGameProps) {
  // Persist champion-beaten status permanently in localStorage
  const champEverBeaten = hasBeatenChampion || localStorage.getItem(CHAMP_BEATEN_KEY) === "1";
  if (hasBeatenChampion && localStorage.getItem(CHAMP_BEATEN_KEY) !== "1") {
    localStorage.setItem(CHAMP_BEATEN_KEY, "1");
  }
  const autoIntervalMs = getAutoIntervalMs(playerRank ?? 999, champEverBeaten);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [countdown, setCountdown] = useState(3);
  const [timeLeft, setTimeLeft] = useState(TOTAL_TIME);
  const [presses, setPresses] = useState(0);
  const [reps, setReps] = useState(0);
  // Compression Sleeves: a completed rep sometimes counts twice.
  const doubleRepChanceRef = useRef(
    getTrainingMods(withSavedInventory(fighter), fighter.careerRosterState as CareerRosterState | null, "weightLifting").doubleRepChance,
  );
  const repGain = useCallback(() => (Math.random() < doubleRepChanceRef.current ? 2 : 1), []);
  const [paused, setPaused] = useState(false);
  const [finished, setFinished] = useState(false);
  const [pauseIndex, setPauseIndex] = useState(0);
  const [bonusFloats, setBonusFloats] = useState<{ id: number; timer: number }[]>([]);
  const animRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const lastPressTimeRef = useRef<number>(performance.now());
  const repStartTimeRef = useRef<number>(performance.now());
  const sinkTimerRef = useRef<number>(0);
  const decayTimerRef = useRef<number>(0);
  const pressesRef = useRef(0);
  const bonusIdRef = useRef(0);
  const countdownRef = useRef(3);
  const repPressCountRef = useRef(0);
  const repsRef = useRef(0);
  const stateRef = useRef({ timeLeft: TOTAL_TIME, paused: false, finished: false });
  const [finishEarlyConfirm, setFinishEarlyConfirm] = useState(false);
  const finishEarlyConfirmRef = useRef(false);
  const isIdleWeekRef = useRef(isIdleWeek ?? false);
  // Auto-press assist refs
  const firstRepDoneRef = useRef(false);
  const autoPressStoppedRef = useRef(false);
  const autoIntervalMsRef = useRef(autoIntervalMs);
  const calcXPRef = useRef(calcXP);
  const onLiveXpChangeRef = useRef(onLiveXpChange);
  useEffect(() => { calcXPRef.current = calcXP; onLiveXpChangeRef.current = onLiveXpChange; }, [calcXP, onLiveXpChange]);

  const gc = (fighter.gearColors as GearColors) || DEFAULT_GEAR_COLORS;
  const skinColor = fighter.skinColor || "#e8c4a0";

  useEffect(() => {
    stateRef.current = { timeLeft, paused, finished };
  }, [timeLeft, paused, finished]);

  useEffect(() => {
    pressesRef.current = presses;
  }, [presses]);

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
          if (next <= 0) {
            lastPressTimeRef.current = performance.now();
            return 0;
          }
          return next;
        });
        animRef.current = requestAnimationFrame(tick);
        return;
      }

      if (!stateRef.current.paused && !stateRef.current.finished) {
        setTimeLeft(prev => {
          const next = prev - dt;
          if (next <= 3 && !autoPressStoppedRef.current) {
            autoPressStoppedRef.current = true;
          }
          if (next <= 0) {
            setFinished(true);
            return 0;
          }
          return next;
        });

        setBonusFloats(prev => {
          const updated = prev.map(f => ({ ...f, timer: f.timer - dt })).filter(f => f.timer > 0);
          return updated.length !== prev.length || updated.some((f, i) => f.timer !== prev[i]?.timer) ? updated : prev;
        });

        const elapsed = (now - lastPressTimeRef.current) / 1000;
        if (elapsed >= SINK_PAUSE_THRESHOLD && pressesRef.current > 0) {
          sinkTimerRef.current += dt;
          decayTimerRef.current += dt;
          if (decayTimerRef.current >= DECAY_INTERVAL) {
            decayTimerRef.current -= DECAY_INTERVAL;
            setPresses(prev => Math.max(0, prev - 1));
          }
        } else {
          sinkTimerRef.current = 0;
          decayTimerRef.current = 0;
        }
      }
      animRef.current = requestAnimationFrame(tick);
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  const handleFinishEarlyConfirm = useCallback(() => {
    const penalizedReps = Math.max(0, repsRef.current - 1);
    repsRef.current = penalizedReps;
    setReps(penalizedReps);
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

    if ((e.key === " " || e.key === "Space") && !e.repeat) {
      e.preventDefault();
      const now = performance.now();
      lastPressTimeRef.current = now;
      sinkTimerRef.current = 0;
      decayTimerRef.current = 0;
      const curRepCount = repPressCountRef.current;
      if (curRepCount === 0) {
        repStartTimeRef.current = now;
      }
      const curReps = repsRef.current;
      const baseNeeded = BASE_PRESSES_PER_REP + (curReps > 8 ? Math.floor((curReps - 8) / 2) : 0);
      const needed = isIdleWeekRef.current ? Math.ceil(baseNeeded * 0.89) : baseNeeded;
      const nextRepCount = curRepCount + 1;
      repPressCountRef.current = nextRepCount;
      const nextPresses = pressesRef.current + 1;
      if (nextRepCount >= needed) {
        soundEngine.trainingDing();
        const repDuration = (now - repStartTimeRef.current) / 1000;
        if (repDuration <= 2.0) {
          setTimeLeft(t => t + 2);
          bonusIdRef.current++;
          setBonusFloats(prev => [...prev, { id: bonusIdRef.current, timer: 1.5 }]);
        }
        const gained = repGain();
        const newReps = curReps + gained;
        repsRef.current = newReps;
        repPressCountRef.current = 0;
        setReps(r => r + gained);
        onLiveXpChangeRef.current?.(calcXPRef.current?.(newReps) ?? newReps * XP_PER_REP);
        // Gate: unlock auto-press after the player completes the first rep manually
        if (!firstRepDoneRef.current && curReps === 0) {
          firstRepDoneRef.current = true;
        }
      }
      setPresses(nextPresses);
    }
  }, [onQuit, onComplete, fighter, handleFinishEarlyConfirm]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  // Auto-press assist interval
  useEffect(() => {
    const ms = autoIntervalMsRef.current;
    if (ms === null) return;
    const id = setInterval(() => {
      if (!firstRepDoneRef.current) return;
      if (autoPressStoppedRef.current) return;
      if (stateRef.current.paused) return;
      if (stateRef.current.finished) return;
      if (countdownRef.current > 0) return;
      // Synthetic space press — mirrors the manual space handler
      const now = performance.now();
      lastPressTimeRef.current = now;
      sinkTimerRef.current = 0;
      decayTimerRef.current = 0;
      const curRepCount = repPressCountRef.current;
      if (curRepCount === 0) repStartTimeRef.current = now;
      const curReps = repsRef.current;
      const baseNeeded = BASE_PRESSES_PER_REP + (curReps > 8 ? Math.floor((curReps - 8) / 2) : 0);
      const needed = isIdleWeekRef.current ? Math.ceil(baseNeeded * 0.89) : baseNeeded;
      const nextRepCount = curRepCount + 1;
      repPressCountRef.current = nextRepCount;
      const nextPresses = pressesRef.current + 1;
      pressesRef.current = nextPresses;
      if (nextRepCount >= needed) {
        soundEngine.trainingDing();
        const repDuration = (now - repStartTimeRef.current) / 1000;
        if (repDuration <= 2.0) {
          setTimeLeft(t => t + 2);
          bonusIdRef.current++;
          setBonusFloats(prev => [...prev, { id: bonusIdRef.current, timer: 1.5 }]);
        }
        const gained = repGain();
        const newReps = curReps + gained;
        repsRef.current = newReps;
        repPressCountRef.current = 0;
        setReps(r => r + gained);
        onLiveXpChangeRef.current?.(calcXPRef.current?.(newReps) ?? newReps * XP_PER_REP);
      }
      setPresses(nextPresses);
    }, ms);
    return () => clearInterval(id);
  }, []);

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

  const baseCurrentNeeded = BASE_PRESSES_PER_REP + (reps > 8 ? Math.floor((reps - 8) / 2) : 0);
  const currentNeeded = isIdleWeek ? Math.ceil(baseCurrentNeeded * 0.89) : baseCurrentNeeded;
  const pressProgress = repPressCountRef.current;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    const gymWall = ctx.createLinearGradient(0, 0, 0, H);
    gymWall.addColorStop(0, "#2a2a3a");
    gymWall.addColorStop(0.6, "#222233");
    gymWall.addColorStop(1, "#1a1a28");
    ctx.fillStyle = gymWall;
    ctx.fillRect(0, 0, W, H);

    ctx.strokeStyle = "#333348";
    ctx.lineWidth = 1;
    for (let bx = 0; bx < W; bx += 40) {
      ctx.beginPath();
      ctx.moveTo(bx, 0);
      ctx.lineTo(bx, H * 0.65);
      ctx.stroke();
    }
    for (let by = 0; by < H * 0.65; by += 25) {
      ctx.beginPath();
      ctx.moveTo(0, by);
      ctx.lineTo(W, by);
      ctx.stroke();
    }

    const floorY = H * 0.65;
    const floor = ctx.createLinearGradient(0, floorY, 0, H);
    floor.addColorStop(0, "#6B4226");
    floor.addColorStop(0.3, "#5C3A22");
    floor.addColorStop(1, "#4A2E1A");
    ctx.fillStyle = floor;
    ctx.fillRect(0, floorY, W, H - floorY);

    ctx.strokeStyle = "#7a5030";
    ctx.lineWidth = 0.5;
    for (let px = 0; px < W; px += 60) {
      ctx.beginPath();
      ctx.moveTo(px, floorY);
      ctx.lineTo(px, H);
      ctx.stroke();
    }

    ctx.fillStyle = "#444460";
    ctx.fillRect(0, floorY - 4, W, 4);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 26px monospace";
    ctx.textAlign = "center";
    ctx.fillText("WEIGHT LIFTING", W / 2, 36);

    ctx.font = "16px monospace";
    ctx.fillStyle = "#aaaacc";
    ctx.fillText(`${fighter.firstName || fighter.name}`, W / 2, 60);

    ctx.font = "bold 36px monospace";
    ctx.fillStyle = timeLeft <= 10 ? "#ff4444" : "#ffffff";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.ceil(timeLeft)}s`, W - 30, 44);
    ctx.textAlign = "center";

    // Personal best: the live counter turns gold the moment the record falls,
    // and the rep that would break it is called out first.
    const bestRecord = Math.max(0, Math.floor(record ?? 0));
    const recordBroken = bestRecord > 0 && reps > bestRecord;
    const oneAwayFromRecord = bestRecord > 0 && reps === bestRecord;

    ctx.font = "bold 48px monospace";
    if (recordBroken) {
      ctx.save();
      ctx.shadowColor = "rgba(255, 190, 0, 0.9)";
      ctx.shadowBlur = 16;
      ctx.fillStyle = "#ffd700";
      ctx.fillText(`${reps}`, W / 2, 110);
      ctx.restore();
    } else {
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`${reps}`, W / 2, 110);
    }
    ctx.font = "18px monospace";
    ctx.fillStyle = "#aaaacc";
    ctx.fillText("REPS", W / 2, 134);

    if (bestRecord > 0) {
      ctx.textAlign = "left";
      ctx.font = "bold 15px monospace";
      ctx.fillStyle = recordBroken ? "#ffd700" : "#8f8fbb";
      ctx.fillText(`BEST ${bestRecord}`, 30, 104);
      if (oneAwayFromRecord) {
        ctx.save();
        ctx.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(Date.now() / 220));
        ctx.fillStyle = "#ffd700";
        ctx.fillText("BREAK YOUR RECORD!", 30, 126);
        ctx.restore();
      }
      ctx.textAlign = "center";
    }

    const barW = W - 120;
    const barH = 24;
    const barX = 60;
    const barY = 150;
    ctx.fillStyle = "#1a1a2e";
    ctx.fillRect(barX, barY, barW, barH);
    ctx.strokeStyle = "#444466";
    ctx.lineWidth = 2;
    ctx.strokeRect(barX, barY, barW, barH);

    const progress = pressProgress / currentNeeded;
    const fillW = barW * progress;
    const grad = ctx.createLinearGradient(barX, barY, barX + barW, barY);
    grad.addColorStop(0, "#4444ff");
    grad.addColorStop(1, "#44ff44");
    ctx.fillStyle = grad;
    ctx.fillRect(barX, barY, fillW, barH);


    const liftProgress = progress;
    const figX = W / 2;
    const figBaseY = floorY - 8;

    const headR = 20;
    const bodyTop = figBaseY - 160;
    const bodyBot = figBaseY - 58;
    const headY = bodyTop - headR - 3;

    ctx.fillStyle = skinColor;
    ctx.beginPath();
    ctx.arc(figX, headY, headR, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#00000033";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.fillStyle = "#222222";
    ctx.beginPath();
    ctx.arc(figX, headY - 4, headR + 1, Math.PI * 1.15, Math.PI * 1.85);
    ctx.fill();

    ctx.fillStyle = "#111111";
    const eyeY = headY - 1;
    ctx.beginPath(); ctx.arc(figX - 7, eyeY, 2, 0, Math.PI * 2); ctx.fill();
    ctx.beginPath(); ctx.arc(figX + 7, eyeY, 2, 0, Math.PI * 2); ctx.fill();

    ctx.fillStyle = gc.trunks;
    ctx.fillRect(figX - 20, bodyBot - 14, 40, 44);

    ctx.fillStyle = skinColor;
    ctx.fillRect(figX - 17, bodyTop, 34, bodyBot - bodyTop - 14);

    ctx.fillStyle = skinColor;
    const legSpread = 15;
    ctx.fillRect(figX - legSpread - 7, bodyBot + 30, 14, 58);
    ctx.fillRect(figX + legSpread - 7, bodyBot + 30, 14, 58);

    ctx.fillStyle = gc.shoes;
    ctx.fillRect(figX - legSpread - 9, figBaseY - 12, 18, 12);
    ctx.fillRect(figX + legSpread - 9, figBaseY - 12, 18, 12);

    const armAngle = liftProgress * Math.PI * 0.45;
    const shoulderY = bodyTop + 7;
    const armLen = 50;

    const barbellY = shoulderY - 10 - Math.sin(armAngle) * armLen;

    for (const side of [-1, 1]) {
      const sx = figX + side * 20;
      const elbowAngle = Math.PI * 0.5 - armAngle * 0.8;
      const elbowX = sx + side * Math.cos(elbowAngle) * 26;
      const elbowY = shoulderY + Math.sin(elbowAngle) * 26 - liftProgress * 14;

      ctx.strokeStyle = skinColor;
      ctx.lineWidth = 10;
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(sx, shoulderY);
      ctx.lineTo(elbowX, elbowY);
      ctx.stroke();

      const handX = figX + side * 28;
      const handY = barbellY;
      ctx.beginPath();
      ctx.moveTo(elbowX, elbowY);
      ctx.lineTo(handX, handY);
      ctx.stroke();

      ctx.fillStyle = skinColor;
      ctx.beginPath();
      ctx.arc(handX, handY, 7, 0, Math.PI * 2);
      ctx.fill();
    }

    const barbellLen = 130;
    ctx.strokeStyle = "#aaaaaa";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(figX - barbellLen / 2, barbellY);
    ctx.lineTo(figX + barbellLen / 2, barbellY);
    ctx.stroke();

    ctx.fillStyle = "#555555";
    ctx.fillRect(figX - barbellLen / 2 - 16, barbellY - 16, 18, 32);
    ctx.fillRect(figX + barbellLen / 2 - 2, barbellY - 16, 18, 32);
    ctx.fillStyle = "#444444";
    ctx.fillRect(figX - barbellLen / 2 - 28, barbellY - 10, 14, 20);
    ctx.fillRect(figX + barbellLen / 2 + 14, barbellY - 10, 14, 20);

    bonusFloats.forEach(f => {
      const alpha = Math.min(1, f.timer / 0.5);
      const yOff = (1.5 - f.timer) * 50;
      ctx.fillStyle = `rgba(68, 255, 68, ${alpha})`;
      ctx.font = "bold 26px monospace";
      ctx.textAlign = "center";
      ctx.fillText("+2s", W / 2 + 80, 110 - yOff);
    });

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

    if (!finished && countdown <= 0) {
      ctx.fillStyle = "#aaaacc";
      ctx.font = "16px monospace";
      ctx.textAlign = "center";
      ctx.fillText("MASH [SPACE] to lift!", W / 2, H - 40);
      ctx.fillStyle = "#777799";
      ctx.font = "13px monospace";
      ctx.fillText("[ESC] Pause", W / 2, H - 18);
    }

    if (paused && !finished) {
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(0, 0, W, H);
      ctx.font = "bold 24px monospace";
      ctx.textAlign = "center";
      if (finishEarlyConfirm) {
        ctx.fillStyle = "#ffcc00";
        ctx.fillText("Finish Early?", W / 2, H / 2 - 60);
      } else {
        ctx.fillStyle = "#ffffff";
        ctx.fillText("PAUSED", W / 2, H / 2 - 60);
      }

      if (!finishEarlyConfirm) {
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
      ctx.fillText("TIME'S UP!", W / 2, H / 2 - 80);

      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 26px monospace";
      ctx.fillText(`${reps} Reps`, W / 2, H / 2 - 35);

      const xp = calcXP ? Math.ceil(calcXP(reps)) : Math.floor(reps * XP_PER_REP);
      ctx.fillStyle = "#44ff44";
      ctx.font = "22px monospace";
      ctx.fillText(`+${xp} XP`, W / 2, H / 2 + 5);

      if (calcStatPoints) {
        const actualPts = calcStatPoints(reps);
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
      } else if (reps > 30) {
        const bonusSP = Math.floor((reps - 30) / 2);
        ctx.fillStyle = "#ffaa00";
        ctx.font = "bold 18px monospace";
        ctx.fillText(`+${bonusSP} Bonus Skill Point${bonusSP !== 1 ? "s" : ""}!`, W / 2, H / 2 + 35);
      }

      const statLineY = calcStatPoints && isFightPrep ? H / 2 + 72 : H / 2 + 65;
      ctx.fillStyle = "#aaaacc";
      ctx.font = "16px monospace";
      ctx.fillText("+Power +Defense bonus", W / 2, statLineY);

      ctx.fillStyle = "#888888";
      ctx.font = "15px monospace";
      ctx.fillText("Press [ENTER] or Click to continue", W / 2, statLineY + 35);
    }
  }, [countdown, timeLeft, presses, reps, paused, finished, pressProgress, currentNeeded, pauseIndex, fighter, skinColor, gc, bonusFloats, finishEarlyConfirm, record]);

  useEffect(() => {
    if (!finished) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        // A popup layered over the recap answers Enter itself.
        if (isEnterOverlayActive()) return;
        onComplete(Math.floor(reps * XP_PER_REP), reps);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finished, reps, onComplete]);

  const handleFinishedClick = useCallback(() => {
    if (finished) {
      onComplete(Math.floor(reps * XP_PER_REP), reps);
    }
  }, [finished, reps, onComplete]);

  return (
    <div className="flex items-center justify-center min-h-screen bg-background">
      <div className="relative" style={{ width: "min(100vw, 720px)", height: "min(85vh, 620px)" }}>
        <canvas
          ref={canvasRef}
          width={720}
          height={620}
          className="border border-border rounded-md cursor-pointer max-w-full max-h-[90vh]"
          style={{ width: "100%", height: "100%" }}
          data-testid="canvas-weight-lifting"
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
