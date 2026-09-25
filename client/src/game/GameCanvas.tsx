import { useRef, useEffect, useCallback, type MutableRefObject } from "react";
import { GameState, PauseAction } from "./types";
import { renderGame, isPauseButtonClick, getPauseMenuClickIndex, getPauseItems, getSoundSliderClick, getControlsBackClick, getTutorialContinueClick } from "./renderer";
import { soundEngine, musicEngine, DYNAMIC_MUSIC_LEVELS } from "./sound";
import { updateGame, handleKeyDown, handleKeyUp, clearAllKeys, advanceTutorialContinue } from "./engine";

const BASE_W = 800;
const BASE_H = 600;

// Map the live round state to a dynamic-music intensity. player* fields are the
// human's offense (good); enemyKDsThisRound counts times the PLAYER was dropped
// (bad), so the player's KD credit is playerKDsThisRound.
function computeDynamicMusicTarget(rs: GameState["roundStats"]): number {
  const player = rs.playerDamageThisRound + rs.playerKDsThisRound * 30 + rs.playerLandedThisRound * 1.5;
  const enemy = rs.enemyDamageThisRound + rs.enemyKDsThisRound * 30 + rs.enemyLandedThisRound * 1.5;
  const diff = player - enemy;
  const kdLead = rs.playerKDsThisRound - rs.enemyKDsThisRound;
  if (diff <= -35 || kdLead <= -1) return DYNAMIC_MUSIC_LEVELS.losingBadly;
  if (diff >= 35 || kdLead >= 1) return DYNAMIC_MUSIC_LEVELS.dominating;
  if (diff <= -12) return DYNAMIC_MUSIC_LEVELS.losing;
  if (diff >= 12) return DYNAMIC_MUSIC_LEVELS.winning;
  return DYNAMIC_MUSIC_LEVELS.even;
}

/**
 * The live fight state changes 60x a second, but only a handful of its fields
 * are read by React. Everything else (health, stamina, timers, positions) is
 * painted straight onto the canvas from the live object, so pushing a new React
 * state object every frame just re-rendered the whole page for nothing.
 *
 * These are the fields a React render actually depends on: whenever one of them
 * changes the state is pushed immediately, otherwise the push is throttled.
 */
function uiSignature(s: GameState): string {
  return `${s.phase}|${s.isPaused ? 1 : 0}|${s.pauseAction ?? ""}|${s.pauseSoundTab ? 1 : 0}|${s.pauseControlsTab ? 1 : 0}|${s.pauseBoutDetailsTab ? 1 : 0}|${s.pauseSelectedIndex}|${s.currentRound}|${s.knockdownActive ? 1 : 0}|${s.fightWinner ?? ""}|${s.fightResult ?? ""}|${s.nightmareKillCount}|${s.doghouseOpponentsDefeated}|${s.midFightLevelUps}|${s.playerLevel}|${s.showExpBar ? 1 : 0}|${s.tutorialPrompt}|${s.tutorialShowContinueButton ? 1 : 0}`;
}

/** Safety net: even with no UI-visible change, resync React at this cadence. */
const THROTTLED_PUSH_MS = 250;

interface GameCanvasProps {
  state: GameState;
  onStateChange: (state: GameState) => void;
  careerDynamicMusic?: boolean;
  /**
   * Shared handle on the live (mutated) fight state. The parent uses it so that
   * patches applied between throttled pushes build on the live object instead of
   * on a stale React snapshot, which would rewind the fight.
   */
  liveStateRef?: MutableRefObject<GameState>;
}

export default function GameCanvas({ state, onStateChange, careerDynamicMusic = false, liveStateRef }: GameCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null);
  const internalStateRef = useRef<GameState>(state);
  const stateRef = liveStateRef ?? internalStateRef;
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const dynamicMusicRef = useRef<boolean>(careerDynamicMusic);
  const prevCritRef = useRef<number>(0);
  const prevStunRef = useRef<number>(0);
  // The last state object handed to (or received from) React. A prop that is not
  // this object is a genuinely new state from outside the loop (fight start,
  // restart, quit) and replaces the live one; the throttled pushes must not.
  const lastPropRef = useRef<GameState | null>(null);
  const lastSigRef = useRef<string>("");
  const lastPushRef = useRef<number>(0);

  if (state !== lastPropRef.current) {
    lastPropRef.current = state;
    stateRef.current = state;
    lastSigRef.current = uiSignature(state);
  }
  dynamicMusicRef.current = careerDynamicMusic;

  /** Snapshot the live state into React, keeping the ref bookkeeping in sync. */
  const pushState = useCallback((next: GameState) => {
    stateRef.current = next;
    lastPropRef.current = next;
    lastSigRef.current = uiSignature(next);
    lastPushRef.current = typeof performance !== "undefined" ? performance.now() : Date.now();
    onStateChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onStateChange]);

  const gameLoop = useCallback((timestamp: number) => {
    if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;
    const dt = Math.min(0.05, (timestamp - lastTimeRef.current) / 1000);
    lastTimeRef.current = timestamp;

    const currentState = stateRef.current;
    if (currentState.phase === "fighting" || currentState.phase === "prefight") {
      // updateGame mutates and returns the same object; the loop drives it in
      // place and only hands React a snapshot when a visible field changes.
      const newState = updateGame(currentState, dt);
      stateRef.current = newState;

      const sig = uiSignature(newState);
      if (sig !== lastSigRef.current || timestamp - lastPushRef.current >= THROTTLED_PUSH_MS) {
        pushState({ ...newState });
      }

      // Dynamic career fight-round music: only during live official career rounds.
      if (dynamicMusicRef.current && newState.careerFightMode && !newState.sparringMode && newState.phase === "fighting" && !newState.isPaused) {
        musicEngine.setDynamicTarget(computeDynamicMusicTarget(newState.roundStats));
        const p = newState.player;
        // Rising edge of the player's crit/stun timers => a fresh stun/crit hit.
        if (p.critHitTimer > prevCritRef.current + 1e-4 || p.stunPunchDisableTimer > prevStunRef.current + 1e-4) {
          musicEngine.triggerDuck();
        }
        prevCritRef.current = p.critHitTimer;
        prevStunRef.current = p.stunPunchDisableTimer;
        musicEngine.updateDynamic(dt);
      } else {
        prevCritRef.current = newState.player.critHitTimer;
        prevStunRef.current = newState.player.stunPunchDisableTimer;
      }
    }

    const canvas = canvasRef.current;
    if (canvas) {
      // getContext() is not free — hold on to the 2D context instead of
      // re-acquiring it on every single frame.
      let ctx = ctxRef.current;
      if (!ctx || ctx.canvas !== canvas) {
        ctx = canvas.getContext("2d");
        ctxRef.current = ctx;
      }
      if (ctx) {
        renderGame(ctx, stateRef.current);
      }
    }

    animFrameRef.current = requestAnimationFrame(gameLoop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushState]);

  useEffect(() => {
    animFrameRef.current = requestAnimationFrame(gameLoop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, [gameLoop]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (["arrowleft", "arrowright", "arrowup", "arrowdown", "escape", " ", "w", "e", "q", "r", "s", "d", "f", "a", "z", "x", "c", "v", "shift", "tab", "enter"].includes(key)) {
        e.preventDefault();
      }
      handleKeyDown(e);
    };
    const onKeyUp = (e: KeyboardEvent) => handleKeyUp(e);

    const onBlur = () => clearAllKeys();
    const onVisChange = () => {
      if (document.hidden) clearAllKeys();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisChange);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisChange);
    };
  }, []);

  const getCanvasCoords = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const scaleX = BASE_W / rect.width;
    const scaleY = BASE_H / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }, []);

  const handleClick = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasCoords(e);
    const s = stateRef.current;

    if (s.tutorialMode && s.tutorialShowContinueButton && getTutorialContinueClick(x, y)) {
      soundEngine.uiClick();
      const newState = { ...s };
      advanceTutorialContinue(newState);
      pushState(newState);
      return;
    }

    if (s.isPaused) {
      if (s.pauseBoutDetailsTab) {
        return;
      }

      if (s.pauseControlsTab) {
        if (getControlsBackClick(x, y)) {
          soundEngine.uiBack();
          const newState = { ...s };
          newState.pauseControlsTab = false;
          pushState(newState);
        }
        return;
      }

      if (s.pauseSoundTab) {
        const slider = getSoundSliderClick(x, y);
        if (slider) {
          const newState = { ...s };
          if (slider.value === -1) {
            soundEngine.uiClick();
            soundEngine.toggleMute();
            musicEngine.refreshVolume();
          } else if (slider.value === -2) {
            soundEngine.uiBack();
            newState.pauseSoundTab = false;
          } else {
            soundEngine.updateSetting(slider.key, slider.value);
            if (slider.key === "master" || slider.key === "music") musicEngine.refreshVolume();
          }
          pushState(newState);
        }
        return;
      }

      if (s.tutorialMode) {
        const idx = getPauseMenuClickIndex(x, y, false, s);
        if (idx >= 0) {
          soundEngine.uiClick();
          const newState = { ...s };
          newState.pauseSelectedIndex = idx;
          if (idx === 0) {
            newState.isPaused = false;
            newState.pauseAction = null;
          } else if (idx === 1) {
            newState.pauseAction = "restart";
          } else if (idx === 2) {
            newState.pauseAction = "quit";
          }
          pushState(newState);
        }
        return;
      }

      const isCareerPause = s.sparringMode || s.careerFightMode;
      const idx = getPauseMenuClickIndex(x, y, isCareerPause, s);
      if (idx >= 0) {
        soundEngine.uiClick();
        const newState = { ...s };
        newState.pauseSelectedIndex = idx;
        if (s.practiceMode) {
          if (idx === 0) {
            newState.isPaused = false;
            newState.pauseAction = null;
          } else if (idx === 1) {
            newState.cpuAttacksEnabled = !s.cpuAttacksEnabled;
          } else if (idx === 2) {
            newState.cpuDefenseEnabled = !s.cpuDefenseEnabled;
          } else if (idx === 3) {
            newState.pauseControlsTab = true;
          } else if (idx === 4) {
            newState.pauseSoundTab = true;
          } else if (idx === 5) {
            newState.pauseAction = "restart";
          } else if (idx === 6) {
            newState.pauseAction = "quit";
          }
        } else {
          const items = getPauseItems(isCareerPause, s);
          const label = items[idx] ?? "";
          if (idx === 0) {
            newState.isPaused = false;
            newState.pauseAction = null;
            newState.pauseBoutDetailsTab = false;
            if (!newState.practiceMode) soundEngine.resumeCrowdAmbient();
          } else if (label === "Finish Early") {
            newState.phase = "fightEnd";
            newState.fightResult = "Decision";
            newState.fightWinner = "player";
            newState.isPaused = false;
            newState.pauseAction = null;
            newState.pauseBoutDetailsTab = false;
            soundEngine.stopCrowdAmbient();
          } else if (label === "Bout Details") {
            newState.pauseBoutDetailsTab = true;
          } else if (label === "Controls") {
            newState.pauseControlsTab = true;
          } else if (label === "Sound") {
            newState.pauseSoundTab = true;
          } else if (label === "Restart") {
            newState.pauseAction = "restart";
          } else if (label === "Quit") {
            newState.pauseAction = "quit";
          }
        }
        pushState(newState);
      }
      return;
    }

    if ((s.phase === "fighting" || s.phase === "prefight") && isPauseButtonClick(x, y)) {
      soundEngine.uiClick();
      const newState = { ...s };
      newState.isPaused = true;
      newState.pauseSelectedIndex = 0;
      newState.pauseAction = null;
      newState.pauseSoundTab = false;
      newState.pauseControlsTab = false;
      if (!newState.practiceMode) soundEngine.pauseCrowdAmbient();
      pushState(newState);
    }
  }, [getCanvasCoords, pushState]);

  return (
    <canvas
      ref={canvasRef}
      width={BASE_W}
      height={BASE_H}
      data-testid="game-canvas"
      className="cursor-pointer block"
      style={{ imageRendering: "auto", height: "100vh", width: "auto", maxWidth: "100vw" }}
      tabIndex={0}
      onClick={handleClick}
    />
  );
}
