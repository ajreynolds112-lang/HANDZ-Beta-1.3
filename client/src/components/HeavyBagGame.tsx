import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { isEnterOverlayActive } from "@/hooks/useEnterKey";
import type { Fighter } from "@shared/schema";
import { soundEngine } from "@/game/sound";
import { TrainingScene3D } from "@/game/three/trainingScene3d";
import { trainingColors } from "@/lib/trainingColors";
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

interface PunchState {
  type: PunchType;
  progress: number;
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

  // 3D scene under the HUD canvas; it reads the live values each frame.
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<TrainingScene3D | null>(null);
  const colors = useMemo(() => trainingColors(fighter), [fighter]);
  useEffect(() => {
    const canvas = glCanvasRef.current;
    if (!canvas) return;
    try {
      sceneRef.current = new TrainingScene3D(canvas, "heavyBag");
    } catch (err) {
      console.error("[3D] heavy bag scene unavailable", err);
    }
    return () => { sceneRef.current?.dispose(); sceneRef.current = null; };
  }, []);
  useEffect(() => {
    sceneRef.current?.setInputs({ colors, bobPhase, punch: currentPunch, bagSwing, hitFlash });
  }, [colors, bobPhase, currentPunch, bagSwing, hitFlash]);

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

    // The 3D scene underneath draws the gym, the bag and the boxer.
    ctx.clearRect(0, 0, W, H);


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
  }, [countdown, timeLeft, combos, currentCombo, comboIndex, missFlash, paused, finished, pauseIndex, fighter, finishEarlyConfirm, record]);

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
          ref={glCanvasRef}
          width={720}
          height={620}
          className="absolute inset-0 rounded-md pointer-events-none"
          style={{ width: "100%", height: "100%" }}
        />
        <canvas
          ref={canvasRef}
          width={720}
          height={620}
          className="relative border border-border rounded-md cursor-pointer max-w-full max-h-[90vh]"
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
