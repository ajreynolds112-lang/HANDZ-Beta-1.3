import { useRef, useEffect } from "react";
import { GameState, FighterColors, SKIN_COLOR_PRESETS, Archetype } from "@/game/types";
import { createInitialState, startFight, updateGame } from "@/game/engine";
import { renderGame, resetAutoZoom } from "@/game/renderer";
import { soundEngine } from "@/game/sound";
import { ROSTER_DATA } from "@/game/rosterData";

const BASE_W = 800;
const BASE_H = 600;

const ARCHETYPES: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];
const GLOVE_COLORS = ["#1155cc", "#22aa22", "#ddaa00", "#aa22aa", "#ff6600", "#cc2222", "#0aa0aa", "#888888"];
const GLOVE_TAPES = ["#eeeeee", "#cccccc", "#222222"];
const TRUNK_COLORS = ["#222222", "#cc2222", "#22aa22", "#ddaa00", "#aa22aa", "#1155cc", "#ff6600", "#0aa0aa"];
const SHOE_COLORS = ["#1a1a1a", "#2a1a1a", "#222222", "#3a2a1a"];
const SOCK_COLORS = ["#f0f0f0", "#e6e6e6", "#111111", "#cc2222"];

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomColors(): FighterColors {
  return {
    gloves: pick(GLOVE_COLORS),
    gloveTape: pick(GLOVE_TAPES),
    trunks: pick(TRUNK_COLORS),
    shoes: pick(SHOE_COLORS),
    socks: pick(SOCK_COLORS),
    skin: pick(SKIN_COLOR_PRESETS as readonly string[] as string[]),
  };
}

function buildName(entry: { firstName: string; nickname: string; lastName: string }): string {
  return entry.nickname
    ? `${entry.firstName} "${entry.nickname}" ${entry.lastName}`
    : `${entry.firstName} ${entry.lastName}`;
}

function makeFightState(): GameState {
  resetAutoZoom();
  const a = ROSTER_DATA[Math.floor(Math.random() * ROSTER_DATA.length)];
  let b = ROSTER_DATA[Math.floor(Math.random() * ROSTER_DATA.length)];
  while (b.id === a.id) {
    b = ROSTER_DATA[Math.floor(Math.random() * ROSTER_DATA.length)];
  }
  const archA = pick(ARCHETYPES);
  const archB = pick(ARCHETYPES);
  const colorsA = randomColors();
  const colorsB = randomColors();
  const armA = Math.round(58 + Math.random() * 17);
  const armB = Math.round(58 + Math.random() * 17);

  const state = startFight(
    createInitialState(),
    archA,           // player archetype (CPU-controlled)
    50,              // player level
    50,              // enemy level
    buildName(a),    // player name
    colorsA,         // player colors
    true,            // isQuickFight
    "contender",     // ai difficulty
    99,              // totalRounds (effectively unlimited)
    99999,           // round duration (no time limit)
    "normal",        // timer speed
    armA,            // player arm
    armB,            // enemy arm
    archB,           // enemy archetype
    buildName(b),    // enemy name
    undefined,       // training bonuses
    false,           // fatigue
    false,           // towel stoppage
    false,           // practice mode
    false,           // record inputs
    true,            // cpuVsCpu
    colorsB,         // enemy colors
    false,           // sparring
    undefined,       // career stamina tier
    1, 1, 1,         // ai mults
    undefined,       // player skill points
    undefined,       // enemy skill points
    false,           // mercy stoppage (off so KOs end fast and we restart)
    b.id             // enemy roster id
  );

  state.menuBackground = true;
  state.phase = "fighting";
  state.ringCanvasColor = "#BDEDF2";
  state.countdownTimer = 0;
  state.introAnimActive = false;
  state.introAnimTimer = 0;
  state.playerIntroPlaying = false;
  state.enemyIntroPlaying = false;
  return state;
}

export default function MenuBackgroundFight() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState>(makeFightState());
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const restartLockRef = useRef<number>(0);

  useEffect(() => {
    soundEngine.setSilent(true);
    return () => { soundEngine.setSilent(false); };
  }, []);

  useEffect(() => {
    const loop = (timestamp: number) => {
      if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;
      const dt = Math.min(0.05, (timestamp - lastTimeRef.current) / 1000);
      lastTimeRef.current = timestamp;

      let s = stateRef.current;

      // Keep stamina topped off so fighters never tire
      s.player.stamina = s.player.maxStamina;
      s.enemy.stamina = s.enemy.maxStamina;

      // Auto-restart with a fresh fight when this one ends
      if (restartLockRef.current > 0) {
        restartLockRef.current -= dt;
      }
      if (
        restartLockRef.current <= 0 &&
        (s.phase === "fightEnd" || s.phase === "roundEnd" || s.refStoppageActive)
      ) {
        stateRef.current = makeFightState();
        restartLockRef.current = 0.5;
        s = stateRef.current;
      }

      if (s.phase === "fighting" || s.phase === "prefight") {
        stateRef.current = updateGame({ ...s }, dt);
      }

      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) renderGame(ctx, stateRef.current);
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };
    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={BASE_W}
      height={BASE_H}
      data-testid="menu-background-fight"
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ imageRendering: "auto", objectFit: "cover" }}
      aria-hidden="true"
    />
  );
}
