import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { isEnterOverlayActive } from "@/hooks/useEnterKey";
import type { Fighter } from "@shared/schema";
import { soundEngine } from "@/game/sound";
import { TrainingScene3D, type BagPunch, type BagDefense } from "@/game/three/trainingScene3d";
import { trainingColors } from "@/lib/trainingColors";
import { getTrainingMods } from "@/game/itemEffects";
import { withSavedInventory } from "@/lib/itemInventory";
import type { CareerRosterState } from "@shared/schema";
import { softCapPunchTiming } from "@/game/engine";
import { bagPunchLabel, getTopBagCombos, type BagSessionPunch } from "@/game/freeBagSession";

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
  /** Free mode: selectable 1–3 minute practice; no XP/stat rewards.
   *  onComplete still fires at the end (with zeros). */
  freeMode?: boolean;
  /** Every punch input, in order (free mode feeds Drilled Actions with it). */
  onPunch?: (punch: PunchType, aimsHead: boolean) => void;
  /** Free mode: fires when the session starts, with the chosen length in minutes. */
  onSessionStart?: (minutes: number) => void;
  /** Free mode: fires only when the clock runs out (never on quit or finish early). */
  onSessionTimeUp?: () => void;
  /** Free mode: punches per minute of session that earn the Punch Endurance cut (0 = no target). */
  freeTargetPerMinute?: number;
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

/** `hit`: the punch was the right key (combo mode); `landed`: it has reached the bag. */
type PunchState = BagPunch & { hit: boolean; landed: boolean; head: boolean };

export default function HeavyBagGame({ fighter, onComplete, onQuit, calcStatPoints, calcXP, isFightPrep, isIdleWeek, onLiveXpChange, record, freeMode = false, onPunch, onSessionStart, onSessionTimeUp, freeTargetPerMinute = 0 }: HeavyBagGameProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [countdown, setCountdown] = useState(freeMode ? 0 : 3);
  const [timeLeft, setTimeLeft] = useState(TOTAL_TIME);
  const [sessionStarted, setSessionStarted] = useState(!freeMode);
  const [selectedDuration, setSelectedDuration] = useState(1);
  // Free mode: punches thrown this session, and whether the clock ran all the way out.
  const [freePunchCount, setFreePunchCount] = useState(0);
  const [freeTimeUp, setFreeTimeUp] = useState(false);
  const [combos, setCombos] = useState(0);
  const [topBagCombos, setTopBagCombos] = useState<{ label: string; count: number }[]>([]);
  const [liveHitText, setLiveHitText] = useState<{ type: PunchType; head: boolean; at: number } | null>(null);
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
  // Punches are thrown in order at a 220-Speed fighter's pace. Combo mode
  // queues every press; free mode only takes a press once the punch in flight
  // is halfway back (earlier presses are dropped), and holds at most one.
  const punchQueueRef = useRef<{ type: PunchType; hit: boolean; head: boolean }[]>([]);
  const currentPunchRef = useRef<PunchState | null>(null);
  const punchTimingRef = useRef<Partial<Record<PunchType, ReturnType<typeof softCapPunchTiming>>>>({});
  const timingOf = (t: PunchType) => (punchTimingRef.current[t] ??= softCapPunchTiming(t));
  /** Fraction of the punch's life where the glove reaches the bag. */
  const contactAt = (t: PunchType) => timingOf(t).fractions?.contact[0] ?? 0.5;
  /** Fraction where the retraction is half done. */
  const halfRetractedAt = (t: PunchType) => {
    const r = timingOf(t).fractions?.retraction;
    return r ? r[0] + 0.5 * (r[1] - r[0]) : 0.75;
  };
  // No windup on the bag: each punch goes straight into the arm motion.
  const startPunch = (q: { type: PunchType; hit: boolean; head: boolean }): PunchState => ({ type: q.type, progress: 0, hit: q.hit, landed: false, head: q.head });
  const lastTimeRef = useRef<number>(0);
  const freeModeRef = useRef(freeMode);
  freeModeRef.current = freeMode;
  const onSessionTimeUpRef = useRef(onSessionTimeUp);
  onSessionTimeUpRef.current = onSessionTimeUp;
  // Free mode defence: Shift ducks, C slips (arrows aim). The scene reads this
  // object live every frame; the key handlers below mutate it.
  const defenseRef = useRef<BagDefense>({ duck: false, slip: false, aim: null });
  const defenseKeysRef = useRef({ shift: false, left: false, right: false, up: false, down: false });
  const countdownRef = useRef(freeMode ? 0 : 3);
  const sessionStartedRef = useRef(!freeMode);
  const completionReportedRef = useRef(false);
  const acceptedPunchesRef = useRef<BagSessionPunch[]>([]);
  const liveHitTextRef = useRef<{ type: PunchType; head: boolean; at: number } | null>(null);
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
    sceneRef.current?.setInputs({ colors, bobPhase, punch: currentPunch, bagSwing, hitFlash, defense: freeMode ? defenseRef.current : undefined });
  }, [colors, bobPhase, currentPunch, bagSwing, hitFlash, freeMode]);

  useEffect(() => {
    if (!freeMode) return;
    const d = defenseRef.current;
    const k = defenseKeysRef.current;
    const sync = () => {
      d.aim = k.left ? "left" : k.right ? "right" : k.up ? "forward" : k.down ? "back" : null;
      // As in a bout: ducking can start any time, but coming up waits until
      // the punch in flight is halfway back.
      const cur = currentPunchRef.current;
      if (k.shift || !cur || cur.progress >= halfRetractedAt(cur.type)) d.duck = k.shift;
    };
    const set = (e: KeyboardEvent, down: boolean) => {
      if (down && (!sessionStartedRef.current || countdownRef.current > 0 || stateRef.current.paused || stateRef.current.finished)) return;
      if (stateRef.current.paused || stateRef.current.finished) { if (down) return; }
      switch (e.key) {
        case "Shift": k.shift = down; break;
        case "c": case "C": d.slip = down; break;
        case "ArrowLeft": k.left = down; break;
        case "ArrowRight": k.right = down; break;
        case "ArrowUp": k.up = down; break;
        case "ArrowDown": k.down = down; break;
        default: return;
      }
      if (down && e.key.startsWith("Arrow")) e.preventDefault();
      sync();
    };
    const onDown = (e: KeyboardEvent) => set(e, true);
    const onUp = (e: KeyboardEvent) => set(e, false);
    const onBlur = () => { Object.assign(k, { shift: false, left: false, right: false, up: false, down: false }); d.slip = false; sync(); };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", onBlur);
    };
  }, [freeMode]);

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

      if (freeModeRef.current && !sessionStartedRef.current) {
        animRef.current = requestAnimationFrame(tick);
        return;
      }

      if (countdownRef.current > 0) {
        setCountdown(prev => {
          const next = prev - dt;
          const safeNext = Math.max(0, next);
          countdownRef.current = safeNext;
          return safeNext;
        });
        animRef.current = requestAnimationFrame(tick);
        return;
      }

      const active = !stateRef.current.paused && !stateRef.current.finished;
      if (active) {
        const nextTime = timeLeftRef.current - dt;
        if (nextTime <= 0) {
          timeLeftRef.current = 0;
          stateRef.current = { ...stateRef.current, timeLeft: 0, finished: true };
          if (freeModeRef.current) { onSessionTimeUpRef.current?.(); setFreeTimeUp(true); }
          punchQueueRef.current = [];
          currentPunchRef.current = null;
          if (freeModeRef.current) setTopBagCombos(getTopBagCombos(acceptedPunchesRef.current));
          setCurrentPunch(null);
          setTimeLeft(0);
          setFinished(true);
        } else {
          timeLeftRef.current = nextTime;
          setTimeLeft(nextTime);
          setBobPhase(prev => prev + dt * 3.5);
        }

      }
      if (active || !freeModeRef.current) {
        setMissFlash(prev => Math.max(0, prev - dt * 4));
        setHitFlash(prev => Math.max(0, prev - dt * 4));
        setBagSwing(prev => prev * 0.95);
        if (liveHitTextRef.current) {
          if (now - liveHitTextRef.current.at >= 900) {
            liveHitTextRef.current = null;
            setLiveHitText(null);
          }
        }
      }

      const animatePunches = !stateRef.current.finished && (active || !freeModeRef.current);
      if (animatePunches) {
        const nextQueued = () => {
          const queued = punchQueueRef.current.shift();
          return queued ? startPunch(queued) : null;
        };
        const prev = currentPunchRef.current;
        let cur: PunchState | null;
        if (!prev) cur = nextQueued();
        else {
          const next = prev.progress + dt / Math.max(0.02, timingOf(prev.type).punch);
          cur = next >= 1 ? nextQueued() : { ...prev, progress: next };
        }
        // The hit registers when the glove reaches the bag, not on the key press.
        if (cur && !cur.landed && cur.progress >= contactAt(cur.type)) {
          cur = { ...cur, landed: true };
          soundEngine.trainingPunchHit();
          if (cur.hit) {
            setHitFlash(1);
            setBagSwing(s => s + 5);
            if (freeModeRef.current) {
              const hitText = { type: cur.type, head: cur.head, at: now };
              liveHitTextRef.current = hitText;
              setLiveHitText(hitText);
            }
          }
        }
        currentPunchRef.current = cur;
        setCurrentPunch(cur);
        // A duck released mid-punch comes up once the punch is halfway back.
        if (freeModeRef.current && (!cur || cur.progress >= halfRetractedAt(cur.type))) {
          defenseRef.current.duck = defenseKeysRef.current.shift;
        }
      }

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
    if (freeMode) setTopBagCombos(getTopBagCombos(acceptedPunchesRef.current));
    setFinished(true);
  }, [freeMode]);

  const beginFreeSession = useCallback(() => {
    const duration = selectedDuration * 60;
    timeLeftRef.current = duration;
    stateRef.current = { ...stateRef.current, timeLeft: duration, paused: false, finished: false };
    lastTimeRef.current = performance.now();
    countdownRef.current = 3;
    sessionStartedRef.current = true;
    setTimeLeft(duration);
    setCountdown(3);
    setPaused(false);
    setSessionStarted(true);
    acceptedPunchesRef.current = [];
    setFreePunchCount(0);
    setFreeTimeUp(false);
    onSessionStart?.(selectedDuration);
  }, [selectedDuration, onSessionStart]);

  const heldPunchKeysRef = useRef<Set<string>>(new Set());
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Punches fire on the key's RELEASE, once per press: auto-repeat while the
    // key is held never throws again. Every other key acts on keydown.
    const isUp = e.type === "keyup";
    const upperKey = e.key.toUpperCase();
    if (PUNCH_KEYS.includes(upperKey)) {
      if (!isUp) {
        e.preventDefault();
        if (!e.repeat) heldPunchKeysRef.current.add(upperKey);
        return;
      }
      // A release with no matching press here (key held in from another screen) is ignored.
      if (!heldPunchKeysRef.current.delete(upperKey)) return;
    } else if (isUp) {
      return;
    }
    if (freeMode && !sessionStartedRef.current) return;
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
    if (!punchType) return;

    if (freeMode) {
      // Not registered at all until the punch in flight is halfway back.
      const cur = currentPunchRef.current;
      const ready = punchQueueRef.current.length === 0
        && (!cur || cur.progress >= halfRetractedAt(cur.type));
      if (!ready) return;
      const head = !defenseRef.current.duck;
      punchQueueRef.current.push({ type: punchType, hit: true, head });
      const accepted = { type: punchType, head };
      acceptedPunchesRef.current.push(accepted);
      setFreePunchCount(acceptedPunchesRef.current.length);
      // A ducked punch goes to the body, as in a bout.
      onPunch?.(punchType, head);
      return;
    }

    const combo = comboRef.current;
    const idx = comboIndexRef.current;
    const correct = key === combo[idx];
    punchQueueRef.current.push({ type: punchType, hit: correct, head: true });
    onPunch?.(punchType, true);
    if (correct) {
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
  }, [onQuit, onComplete, fighter, handleFinishEarlyConfirm, freeMode, onPunch]);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyDown);
    };
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
      const iy = H / 2 + (freeMode ? 55 : -10) + i * 35;
      if (cx > W / 2 - 80 && cx < W / 2 + 80 && cy > iy - 15 && cy < iy + 10) {
        if (i === 0) setPaused(false);
        else if (i === 1) onQuit();
        else if (i === 2) {
          setFinishEarlyConfirm(true);
          finishEarlyConfirmRef.current = true;
        }
      }
    });
  }, [paused, finished, onQuit, finishEarlyConfirm, freeMode]);

  const completeSession = useCallback(() => {
    if (!finished || completionReportedRef.current) return;
    completionReportedRef.current = true;
    onComplete(freeMode ? 0 : Math.floor(combos * XP_PER_COMBO), freeMode ? 0 : combos);
  }, [finished, onComplete, freeMode, combos]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const W = canvas.width;
    const H = canvas.height;

    // The 3D scene underneath draws the gym, the bag and the boxer.
    ctx.clearRect(0, 0, W, H);


    if (!freeMode) {
      ctx.fillStyle = "#ffffff";
      ctx.font = "bold 24px monospace";
      ctx.textAlign = "center";
      ctx.fillText("HEAVY BAG", W / 2, 32);
      ctx.font = "15px monospace";
      ctx.fillStyle = "#aaaacc";
      ctx.fillText(`${fighter.firstName || fighter.name}`, W / 2, 54);
    }

    ctx.font = "bold 32px monospace";
    ctx.fillStyle = timeLeft <= 10 ? "#ff4444" : "#ffffff";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.ceil(timeLeft)}s`, W - 25, 38);
    ctx.textAlign = "center";

    // Personal best: the live counter turns gold the moment the record falls,
    // and the combo that would break it is called out first.
    const bestRecord = freeMode ? 0 : Math.max(0, Math.floor(record ?? 0));
    const recordBroken = bestRecord > 0 && combos > bestRecord;
    const oneAwayFromRecord = bestRecord > 0 && combos === bestRecord;

    ctx.font = "bold 42px monospace";
    ctx.textAlign = "left";
    if (freeMode) {
      // Free mode shows no live counter; the total comes up on the end screen.
    } else if (recordBroken) {
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
    if (!freeMode) {
      ctx.font = "15px monospace";
      ctx.fillStyle = "#aaaacc";
      ctx.fillText("COMBOS", 25, 118);
    }

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

    if (!freeMode && timeLeft <= 10 && timeLeft > 0 && countdown <= 0 && !finished) {
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
    ctx.globalAlpha = countdown <= 0 && !freeMode ? 1 : 0;
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

    if (!finished && countdown <= 0 && sessionStarted) {
      ctx.fillStyle = "#777799";
      ctx.font = "13px monospace";
      ctx.fillText("[ESC] Pause", W / 2, H - 10);
    }

    if (liveHitText && freeMode && !finished) {
      const age = Math.max(0, performance.now() - liveHitText.at);
      if (age < 900) {
        ctx.save();
        ctx.globalAlpha = Math.min(1, age / 90) * (1 - age / 900);
        ctx.font = "bold 16px 'Oxanium', sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = liveHitText.head ? "#ffd36b" : "#76d6ff";
        ctx.fillText(`${bagPunchLabel({ type: liveHitText.type, head: liveHitText.head })} · ${liveHitText.head ? "HEAD" : "BODY"}`, W / 2, H / 2 - 105 - (age / 900) * 34);
        ctx.restore();
      }
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
      ctx.fillText("PAUSED", W / 2, freeMode ? 88 : H / 2 - 60);

      if (finishEarlyConfirm) {
        ctx.fillStyle = "#ffcc00";
        ctx.font = "bold 20px monospace";
        ctx.fillText("Finish early?", W / 2, H / 2);
      } else {
        if (freeMode) {
          ctx.fillStyle = "#aaaacc";
          ctx.font = "bold 15px monospace";
          ctx.textAlign = "center";
          ctx.fillText("CONTROLS", W / 2, 127);
          ctx.font = "13px monospace";
          ctx.fillStyle = "#ffffff";
          ctx.fillText("Punches   Q  W  E  R  S  D", W / 2, 153);
          ctx.fillText("Duck      Shift", W / 2, 176);
          ctx.fillText("Slip      C", W / 2, 199);
          ctx.fillText("Aim       Arrow keys", W / 2, 222);
        }
        const menuItems = ["Resume", "Quit", "Finish Early"];
        menuItems.forEach((item, i) => {
          const y = H / 2 + (freeMode ? 55 : -10) + i * 35;
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
      if (freeMode) {
        ctx.fillStyle = "#ffcc00";
        ctx.font = "bold 30px monospace";
        ctx.textAlign = "center";
        ctx.fillText("Free Mode Completed", W / 2, H / 2 - 118);
        ctx.font = "bold 18px monospace";
        ctx.fillStyle = "#ffffff";
        ctx.fillText(`Total punches: ${freePunchCount}`, W / 2, H / 2 - 84);
        ctx.fillStyle = "#aaaacc";
        ctx.font = "bold 15px monospace";
        ctx.fillText("TOP PUNCH STRINGS", W / 2, H / 2 - 48);
        if (topBagCombos.length === 0) {
          ctx.font = "14px monospace";
          ctx.fillStyle = "#888888";
          ctx.fillText("No three-punch strings recorded", W / 2, H / 2 - 18);
        } else {
          topBagCombos.slice(0, 3).forEach((combo, i) => {
            const rowY = H / 2 - 18 + i * 27;
            ctx.font = "bold 15px monospace";
            ctx.textAlign = "left";
            ctx.fillStyle = "#ffffff";
            ctx.fillText(combo.label, 60, rowY, W - 190);
            ctx.textAlign = "right";
            ctx.fillStyle = "#ffcc00";
            ctx.fillText(`×${combo.count}`, W - 90, rowY);
          });
          ctx.textAlign = "center";
        }
        ctx.fillStyle = "#888888";
        ctx.font = "13px monospace";
        ctx.fillText("Press [ENTER] or Click to continue", W / 2, H / 2 + 108);
        return;
      }

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
  }, [countdown, timeLeft, combos, currentCombo, comboIndex, missFlash, paused, finished, pauseIndex, fighter, finishEarlyConfirm, record, freeMode, sessionStarted, liveHitText, topBagCombos, freePunchCount, freeTimeUp, selectedDuration, freeTargetPerMinute]);

  useEffect(() => {
    if (!finished) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        // A popup layered over the recap answers Enter itself.
        if (isEnterOverlayActive()) return;
        completeSession();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [finished, completeSession]);

  const handleFinishedClick = useCallback(() => {
    if (finished) {
      completeSession();
    }
  }, [finished, completeSession]);

  return (
    <div className="fixed inset-0 z-40 bg-black overflow-hidden flex items-center justify-center">
      {/* Sized like the gym view: full viewport height, width from the aspect. */}
      <div className="relative" style={{ height: "100vh", width: "auto", display: "flex" }}>
        <canvas
          ref={glCanvasRef}
          width={720}
          height={620}
          className="absolute inset-0 block pointer-events-none"
          style={{ width: "100%", height: "100%" }}
        />
        {freeMode && !sessionStarted && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-[rgba(5,8,13,0.88)] px-5">
            <section
              aria-labelledby="free-bag-duration-title"
              aria-describedby="free-bag-duration-description"
              className="w-full max-w-[390px] border border-amber-200/25 bg-[#10151d]/95 px-7 py-8 text-center text-white shadow-2xl"
              role="dialog"
              aria-modal="true"
            >
              <p className="mb-2 font-mono text-xs tracking-[0.28em] text-amber-200/75">HANDZ · FREE BAG</p>
              <h1 id="free-bag-duration-title" className="font-mono text-2xl font-bold tracking-wide">Set your round</h1>
              <p id="free-bag-duration-description" className="mt-2 font-mono text-sm text-slate-300">
                Choose a duration before the countdown.
              </p>
              <div className="mt-7 grid grid-cols-3 gap-2" role="group" aria-label="Round duration">
                {[1, 2, 3].map(minutes => (
                  <button
                    key={minutes}
                    type="button"
                    aria-pressed={selectedDuration === minutes}
                    onClick={() => {
                      setSelectedDuration(minutes);
                      timeLeftRef.current = minutes * 60;
                      setTimeLeft(minutes * 60);
                    }}
                    className={`min-h-12 border px-3 font-mono text-sm font-bold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-300 ${
                      selectedDuration === minutes
                        ? "border-amber-200 bg-amber-200 text-slate-950"
                        : "border-slate-500/60 bg-slate-800/60 text-slate-100 hover:border-amber-200/70"
                    }`}
                  >
                    {minutes} {minutes === 1 ? "minute" : "minutes"}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={beginFreeSession}
                className="mt-6 min-h-12 w-full bg-amber-300 px-5 font-mono text-sm font-bold uppercase tracking-[0.16em] text-slate-950 hover:bg-amber-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-3 focus-visible:outline-amber-100"
              >
                Start countdown
              </button>
            </section>
          </div>
        )}
        <canvas
          ref={canvasRef}
          width={720}
          height={620}
          className="block relative cursor-pointer"
          style={{ height: "100vh", width: "auto" }}
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
