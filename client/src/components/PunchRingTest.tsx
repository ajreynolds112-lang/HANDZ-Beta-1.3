/**
 * Punch Animation → ring test: the player on the keyboard against a stand-still
 * dummy in the fight arena, wearing the editor's live (unsaved) draft for the
 * punch being edited and the saved profiles for the rest.
 *
 * The dummy never attacks, defends or walks (GameState.dummyEnemy); the engine's
 * per-tick turn keeps it facing the player. Practice mode means no knockdowns and
 * no stamina gating, and both stamina bars are topped up every frame. Nothing here
 * touches a save.
 */
import { useEffect, useRef } from "react";
import type { GameState, FighterColors } from "@/game/types";
import { SKIN_COLOR_PRESETS } from "@/game/types";
import { createInitialState, startFight, updateGame, handleKeyDown, handleKeyUp, clearAllKeys } from "@/game/engine";
import { resetAutoZoom } from "@/game/renderer";
import { soundEngine } from "@/game/sound";
import { useFightScene3D } from "@/game/three/useFightScene3D";
import { Button } from "@/components/ui/button";
import { RotateCcw, X } from "lucide-react";

const BASE_W = 800;
const BASE_H = 600;

const PLAYER_COLORS: FighterColors = {
  gloves: "#cc2222", gloveTape: "#eeeeee", trunks: "#cc2222",
  shoes: "#1a1a1a", socks: "#f0f0f0", skin: SKIN_COLOR_PRESETS[1] as string,
};
const DUMMY_COLORS: FighterColors = {
  gloves: "#6b7280", gloveTape: "#d1d5db", trunks: "#4b5563",
  shoes: "#222222", socks: "#e6e6e6", skin: SKIN_COLOR_PRESETS[3] as string,
};

function buildRing(southpaw: boolean): GameState {
  resetAutoZoom();
  const state = startFight(
    createInitialState(),
    "BoxerPuncher",
    1, 1,                 // levels — the editor previews a level-1 fighter
    "You",
    PLAYER_COLORS,
    true,                 // isQuickFight
    "contender",
    99,                   // rounds — effectively unlimited
    99999,                // round duration — no time limit
    "normal",
    65, 65,               // arm lengths
    "BoxerPuncher",
    "Dummy",
    undefined,            // training bonuses
    false,                // fatigue
    false,                // towel stoppage
    true,                 // practice mode — no knockdowns, punches never stamina-gated
    false,                // record inputs
    false,                // cpuVsCpu — the near corner is the keyboard
    DUMMY_COLORS,
    false,                // sparring (arena, not the gym)
    undefined,            // career stamina tier
    1, 1, 1,              // ai mults
    undefined, undefined, // skill points
    false,                // mercy stoppage
    undefined, undefined, undefined, // enemy roster id, refinements
    false, undefined, false, undefined,
    southpaw ? "southpaw" : "orthodox",
    "orthodox",
  );
  state.dummyEnemy = true;
  state.phase = "fighting";
  state.countdownTimer = 0;
  state.introAnimActive = false;
  state.introAnimTimer = 0;
  state.playerIntroPlaying = false;
  state.enemyIntroPlaying = false;
  return state;
}

export default function PunchRingTest({ southpaw, onExit }: { southpaw: boolean; onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState>(buildRing(southpaw));
  const southpawRef = useRef(southpaw);
  southpawRef.current = southpaw;
  const exitRef = useRef(onExit);
  exitRef.current = onExit;
  const view3d = useFightScene3D();

  const restart = () => {
    clearAllKeys();
    stateRef.current = buildRing(southpawRef.current);
  };

  useEffect(() => {
    soundEngine.setSilent(true);
    clearAllKeys();
    return () => { soundEngine.setSilent(false); clearAllKeys(); };
  }, []);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); exitRef.current(); return; }
      if (e.target instanceof HTMLInputElement) return;
      if (e.key === " ") e.preventDefault();
      handleKeyDown(e);
    };
    const up = (e: KeyboardEvent) => handleKeyUp(e);
    const blur = () => clearAllKeys();
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", blur);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", blur);
    };
  }, []);

  useEffect(() => {
    let raf = 0;
    let last = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (last === 0) last = now;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      let s = stateRef.current;
      s.player.stamina = s.player.maxStamina;
      s.enemy.stamina = s.enemy.maxStamina;
      // Nothing should end this bout, but never leave a dead ring if it does.
      if (s.phase === "fightEnd" || s.phase === "roundEnd" || s.refStoppageActive) {
        stateRef.current = buildRing(southpawRef.current);
        s = stateRef.current;
      }
      if (s.phase === "fighting" || s.phase === "prefight") {
        stateRef.current = updateGame({ ...s }, dt);
      }
      view3d.draw(canvasRef.current?.getContext("2d") ?? null, stateRef.current);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black flex items-center justify-center" data-testid="punch-ring-test">
      <div className="relative max-w-full max-h-full" style={{ lineHeight: 0 }}>
        <canvas
          ref={view3d.glCanvasRef}
          className="absolute inset-0 block"
          style={{ width: "100%", height: "100%", pointerEvents: "none", visibility: "hidden" }}
        />
        <canvas
          ref={canvasRef}
          width={BASE_W}
          height={BASE_H}
          className="relative block max-w-full max-h-full"
          style={{ height: "100vh", width: "auto" }}
        />
      </div>
      <div className="absolute top-3 right-3 flex gap-2">
        <Button size="sm" variant="outline" onClick={e => { e.currentTarget.blur(); restart(); }} data-testid="button-ringtest-restart">
          <RotateCcw className="w-4 h-4 mr-1" /> Reset
        </Button>
        <Button size="sm" variant="destructive" onClick={onExit} data-testid="button-ringtest-exit">
          <X className="w-4 h-4 mr-1" /> Exit
        </Button>
      </div>
    </div>
  );
}
