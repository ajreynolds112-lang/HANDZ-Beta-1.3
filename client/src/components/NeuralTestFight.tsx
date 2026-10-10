/**
 * Neural Network test ring — a throwaway bout you can rebuild from scratch
 * without leaving the tuning screen.
 *
 * Deliberately not wired to a save: every corner is described by the config
 * below, and Apply throws the fight away and builds a new one. Nothing here
 * writes to a career, and the bout restarts itself forever so a run can be left
 * going while numbers are watched.
 */
import { useRef, useEffect, useState, useCallback } from "react";
import type { GameState, Archetype, FighterColors } from "@/game/types";
import { SKIN_COLOR_PRESETS } from "@/game/types";
import {
  createInitialState, startFight, updateGame, handleKeyDown, handleKeyUp,
  clearAllKeys, applyFightEquipment, MAX_ACTIVE_REFINEMENTS, REFINEMENT_LEVEL_CAP,
} from "@/game/engine";
import { resetAutoZoom } from "@/game/renderer";
import { soundEngine } from "@/game/sound";
import { useFightScene3D } from "@/game/three/useFightScene3D";
import { REFINEMENT_KEYS, REFINEMENT_LABELS, type RefinementKey } from "@/game/refinementKeys";
import { EQUIPMENT_SLOTS, emptyEquipmentLevels, type EquipmentLevels } from "@/game/equipmentConfig";
import { REFINEMENT_SLOT_RANK_UNLOCKS } from "@shared/schema";
import { Button } from "@/components/ui/button";
import { X, Play, Users, RotateCcw } from "lucide-react";

const BASE_W = 800;
const BASE_H = 600;

const ARCHETYPES: Archetype[] = ["BoxerPuncher", "OutBoxer", "Brawler", "Swarmer"];

interface CornerConfig {
  name: string;
  level: number;
  archetype: Archetype;
  /** Which refinements are switched on. The engine caps this at five. */
  active: RefinementKey[];
  /** Level per refinement, read only for the ones switched on. */
  levels: Record<string, number>;
  equipment: EquipmentLevels;
}

interface TestConfig {
  /** Off is CPU vs CPU; on hands the near corner to the keyboard. */
  playerControlled: boolean;
  /** How hard fatigue bites, 1 being the shipped rate. */
  fatigueStrength: number;
  infiniteStamina: boolean;
  player: CornerConfig;
  enemy: CornerConfig;
}

function defaultCorner(name: string, archetype: Archetype): CornerConfig {
  const levels: Record<string, number> = {};
  for (const k of REFINEMENT_KEYS) levels[k] = 50;
  return { name, level: 50, archetype, active: [], levels, equipment: emptyEquipmentLevels() };
}

function defaultConfig(): TestConfig {
  return {
    playerControlled: false,
    fatigueStrength: 1,
    infiniteStamina: false,
    player: defaultCorner("Test Red", "BoxerPuncher"),
    enemy: defaultCorner("Test Blue", "Swarmer"),
  };
}

const COLORS_A: FighterColors = {
  gloves: "#cc2222", gloveTape: "#eeeeee", trunks: "#cc2222",
  shoes: "#1a1a1a", socks: "#f0f0f0", skin: SKIN_COLOR_PRESETS[1] as string,
};
const COLORS_B: FighterColors = {
  gloves: "#1155cc", gloveTape: "#cccccc", trunks: "#1155cc",
  shoes: "#222222", socks: "#e6e6e6", skin: SKIN_COLOR_PRESETS[3] as string,
};

/**
 * The refinement map a corner hands to startFight. Only the switched-on keys
 * carry a number; the three category flags are always open because this ring has
 * no career progression to gate them behind.
 */
function refinementMapOf(c: CornerConfig): Record<string, unknown> {
  const map: Record<string, unknown> = {
    offenseUnlocked: true, defenseUnlocked: true, fightIqUnlocked: true,
    activeRefinements: [...c.active],
    // A career earns its slots past the base five by climbing the ranks, and
    // anything short of every rung gets its list quietly trimmed on the way into
    // the ring. A test corner has no rank to climb, so it declares every rung
    // already earned and carries the full eight.
    activeSlotsUnlocked: REFINEMENT_SLOT_RANK_UNLOCKS.length,
  };
  for (const k of c.active) map[k] = Math.max(1, Math.round(c.levels[k] ?? 1));
  return map;
}

function buildFight(cfg: TestConfig): GameState {
  resetAutoZoom();
  const state = startFight(
    createInitialState(),
    cfg.player.archetype,
    cfg.player.level,
    cfg.enemy.level,
    cfg.player.name,
    COLORS_A,
    true,                 // isQuickFight
    "contender",
    99,                   // rounds — effectively unlimited
    99999,                // round duration — no time limit
    "normal",
    65, 65,               // arm lengths
    cfg.enemy.archetype,
    cfg.enemy.name,
    undefined,            // training bonuses
    false,                // fatigue (the stamina-drain kind, not Energy)
    false,                // towel stoppage
    false,                // practice mode
    false,                // record inputs
    !cfg.playerControlled,
    COLORS_B,
    false,                // sparring
    undefined,            // career stamina tier
    1, 1, 1,              // ai mults
    undefined, undefined, // skill points
    false,                // mercy stoppage
    undefined,            // enemy roster id
    refinementMapOf(cfg.player),
    refinementMapOf(cfg.enemy),
  );

  applyFightEquipment(state, { player: cfg.player.equipment, opponent: cfg.enemy.equipment });
  state.player.fatigue.strengthMult = cfg.fatigueStrength;
  state.enemy.fatigue.strengthMult = cfg.fatigueStrength;

  state.phase = "fighting";
  state.countdownTimer = 0;
  state.introAnimActive = false;
  state.introAnimTimer = 0;
  state.playerIntroPlaying = false;
  state.enemyIntroPlaying = false;
  return state;
}

// ------------------------------------------------------------------ controls

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-32 shrink-0 text-white/60">{label}</span>
      {children}
    </div>
  );
}

function NumberField({ value, onChange, min, max }: {
  value: number; onChange: (v: number) => void; min: number; max: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={e => {
        const n = Number(e.target.value);
        onChange(Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : min);
      }}
      className="w-20 rounded bg-black/50 border border-white/20 px-2 py-1 text-white text-xs"
    />
  );
}

function CornerEditor({ title, corner, onChange }: {
  title: string; corner: CornerConfig; onChange: (c: CornerConfig) => void;
}) {
  const atCap = corner.active.length >= MAX_ACTIVE_REFINEMENTS;
  const toggle = (k: RefinementKey) => {
    const on = corner.active.includes(k);
    if (!on && atCap) return;
    onChange({
      ...corner,
      active: on ? corner.active.filter(x => x !== k) : [...corner.active, k],
    });
  };

  return (
    <div className="flex-1 min-w-0 rounded border border-white/15 bg-black/30 p-3 space-y-2">
      <div className="text-sm font-semibold text-white">{title}</div>

      <Row label="Name">
        <input
          value={corner.name}
          onChange={e => onChange({ ...corner, name: e.target.value })}
          className="flex-1 rounded bg-black/50 border border-white/20 px-2 py-1 text-white text-xs"
        />
      </Row>
      <Row label="Level">
        <NumberField value={corner.level} min={1} max={1000}
          onChange={v => onChange({ ...corner, level: v })} />
      </Row>
      <Row label="Archetype">
        <select
          value={corner.archetype}
          onChange={e => onChange({ ...corner, archetype: e.target.value as Archetype })}
          className="rounded bg-black/50 border border-white/20 px-2 py-1 text-white text-xs"
        >
          {ARCHETYPES.map(a => <option key={a} value={a}>{a}</option>)}
        </select>
      </Row>

      <div className="pt-1 text-xs text-white/60">
        Equipment levels
      </div>
      <div className="grid grid-cols-2 gap-1">
        {EQUIPMENT_SLOTS.map(slot => (
          <Row key={slot} label={slot}>
            <NumberField
              value={corner.equipment[slot]} min={0} max={1000}
              onChange={v => onChange({ ...corner, equipment: { ...corner.equipment, [slot]: v } })}
            />
          </Row>
        ))}
      </div>

      <div className="pt-1 text-xs text-white/60">
        Refinements — {corner.active.length}/{MAX_ACTIVE_REFINEMENTS} active
      </div>
      <div className="max-h-56 overflow-y-auto pr-1 space-y-1">
        {REFINEMENT_KEYS.map(k => {
          const on = corner.active.includes(k);
          return (
            <div key={k} className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={on}
                disabled={!on && atCap}
                onChange={() => toggle(k)}
                className="accent-yellow-500"
                data-testid={`checkbox-refinement-${k}`}
              />
              <span className={`flex-1 truncate ${on ? "text-white" : "text-white/40"}`}>
                {REFINEMENT_LABELS[k]}
              </span>
              <NumberField
                value={corner.levels[k] ?? 1} min={1} max={REFINEMENT_LEVEL_CAP}
                onChange={v => onChange({ ...corner, levels: { ...corner.levels, [k]: v } })}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

// -------------------------------------------------------------------- screen

export default function NeuralTestFight({ onExit }: { onExit: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const configRef = useRef<TestConfig>(defaultConfig());
  const stateRef = useRef<GameState>(buildFight(configRef.current));
  const animRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  const restartLockRef = useRef<number>(0);
  const pausedRef = useRef<boolean>(false);
  const view3d = useFightScene3D();

  const [paused, setPaused] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<TestConfig>(configRef.current);

  pausedRef.current = paused;

  const rebuild = useCallback((cfg: TestConfig) => {
    configRef.current = cfg;
    clearAllKeys();
    stateRef.current = buildFight(cfg);
    restartLockRef.current = 0.4;
  }, []);

  // Silent so a test run makes no sound, and the module-level key
  // state is cleared on the way out so a held key does not leak into the game.
  useEffect(() => {
    soundEngine.setSilent(true);
    return () => { soundEngine.setSilent(false); clearAllKeys(); };
  }, []);

  // Escape is ours, not the engine's — the pause UI here is React, so the
  // engine never learns the fight is paused and never draws its own menu.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setPaused(p => {
          if (p) return false;
          setDraft(configRef.current);
          return true;
        });
        setEditing(false);
        clearAllKeys();
        return;
      }
      if (pausedRef.current || !configRef.current.playerControlled) return;
      handleKeyDown(e);
    };
    const up = (e: KeyboardEvent) => {
      if (pausedRef.current || !configRef.current.playerControlled) return;
      handleKeyUp(e);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  useEffect(() => {
    const loop = (timestamp: number) => {
      if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;
      const dt = Math.min(0.05, (timestamp - lastTimeRef.current) / 1000);
      lastTimeRef.current = timestamp;

      let s = stateRef.current;
      const cfg = configRef.current;

      if (!pausedRef.current) {
        if (cfg.infiniteStamina) {
          s.player.stamina = s.player.maxStamina;
          s.enemy.stamina = s.enemy.maxStamina;
        }

        // The ring runs until it is exited, so a finished bout just starts
        // another one on the same config.
        if (restartLockRef.current > 0) restartLockRef.current -= dt;
        if (restartLockRef.current <= 0 &&
            (s.phase === "fightEnd" || s.phase === "roundEnd" || s.refStoppageActive)) {
          stateRef.current = buildFight(cfg);
          restartLockRef.current = 0.5;
          s = stateRef.current;
        }

        if (s.phase === "fighting" || s.phase === "prefight") {
          stateRef.current = updateGame({ ...s }, dt);
        }
      }

      const ctx = canvasRef.current?.getContext("2d") ?? null;
      view3d.draw(ctx, stateRef.current);

      animRef.current = requestAnimationFrame(loop);
    };
    animRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animRef.current);
  }, []);

  return (
    <div className="fixed inset-0 z-50 bg-black flex items-center justify-center" data-testid="neural-test-fight">
      {/* The WebGL canvas fills the 2D canvas's box underneath it (see GameCanvas). */}
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

      {!paused && (
        <div className="absolute top-3 left-3 text-xs text-white/50 pointer-events-none">
          Esc — pause
        </div>
      )}

      {paused && !editing && (
        <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
          <div className="w-64 space-y-2 rounded border border-white/15 bg-[#0a0a0f] p-4">
            <div className="pb-1 text-center text-sm font-semibold text-white">Paused</div>
            <Button className="w-full gap-2" onClick={() => setPaused(false)} data-testid="button-test-resume">
              <Play className="w-4 h-4" /> Resume
            </Button>
            <Button variant="outline" className="w-full gap-2" onClick={() => setEditing(true)} data-testid="button-test-edit-fighters">
              <Users className="w-4 h-4" /> Edit Fighters
            </Button>
            <Button variant="outline" className="w-full gap-2" onClick={() => rebuild(configRef.current)} data-testid="button-test-restart">
              <RotateCcw className="w-4 h-4" /> Restart Bout
            </Button>
            <Button variant="destructive" className="w-full gap-2" onClick={onExit} data-testid="button-test-exit">
              <X className="w-4 h-4" /> Exit
            </Button>
          </div>
        </div>
      )}

      {paused && editing && (
        <div className="absolute inset-0 overflow-y-auto bg-black/85 p-4">
          <div className="mx-auto w-full max-w-4xl space-y-3">
            <div className="text-base font-semibold text-white">Edit Fighters</div>

            <div className="rounded border border-white/15 bg-black/30 p-3 space-y-2">
              <Row label="Mode">
                <button
                  onClick={() => setDraft({ ...draft, playerControlled: !draft.playerControlled })}
                  className="rounded border border-white/20 bg-black/50 px-3 py-1 text-xs text-white"
                  data-testid="button-test-mode"
                >
                  {draft.playerControlled ? "Player vs CPU" : "CPU vs CPU"}
                </button>
              </Row>
              <Row label="Fatigue strength">
                <input
                  type="range" min={0.1} max={10} step={0.1}
                  value={draft.fatigueStrength}
                  onChange={e => setDraft({ ...draft, fatigueStrength: Number(e.target.value) })}
                  className="flex-1 accent-yellow-500"
                  data-testid="slider-test-fatigue"
                />
                <span className="w-12 text-right text-white">{draft.fatigueStrength.toFixed(1)}x</span>
              </Row>
              <Row label="Infinite stamina">
                <input
                  type="checkbox"
                  checked={draft.infiniteStamina}
                  onChange={e => setDraft({ ...draft, infiniteStamina: e.target.checked })}
                  className="accent-yellow-500"
                  data-testid="checkbox-test-infinite-stamina"
                />
              </Row>
            </div>

            <div className="flex flex-col gap-3 md:flex-row">
              <CornerEditor title="Near corner (red)" corner={draft.player}
                onChange={c => setDraft({ ...draft, player: c })} />
              <CornerEditor title="Far corner (blue)" corner={draft.enemy}
                onChange={c => setDraft({ ...draft, enemy: c })} />
            </div>

            <div className="flex gap-2 pb-4">
              <Button
                className="flex-1"
                onClick={() => { rebuild(draft); setEditing(false); setPaused(false); }}
                data-testid="button-test-apply"
              >
                Apply &amp; Restart
              </Button>
              <Button variant="outline" className="flex-1" onClick={() => setEditing(false)}>
                Back
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
