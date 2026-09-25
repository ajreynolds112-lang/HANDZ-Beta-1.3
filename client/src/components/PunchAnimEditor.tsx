import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ChevronDown, ChevronRight, RotateCcw, Save, Undo2, Redo2 } from "lucide-react";
import {
  PunchType,
  PunchAnimParams,
  PunchAnimConfig,
  DEFAULT_PUNCH_ANIM_CONFIG,
  loadPunchAnimConfig,
  savePunchAnimConfig,
  resetPunchAnimConfig,
  hasSavedPunchAnimConfig,
  invalidatePunchAnimCache,
} from "@/lib/punchAnimConfig";
import { renderFighterPunchFrame } from "@/game/renderer";
import { DEFAULT_PLAYER_COLORS } from "@/game/types";

const PUNCH_LABELS: Record<PunchType, string> = {
  jab: "Jab",
  cross: "Cross",
  leftHook: "L. Hook",
  rightHook: "R. Hook",
  leftUppercut: "L. Uppercut",
  rightUppercut: "R. Uppercut",
};

const PUNCH_TYPES: PunchType[] = ["jab", "cross", "leftHook", "rightHook", "leftUppercut", "rightUppercut"];

function punchCategory(p: PunchType): "straight" | "hook" | "uppercut" {
  if (p.includes("Hook")) return "hook";
  if (p.includes("Uppercut")) return "uppercut";
  return "straight";
}

interface SliderRowProps {
  label: string;
  desc?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  defaultVal: number;
  onChange: (v: number) => void;
}

function SliderRow({ label, desc, value, min, max, step, defaultVal, onChange }: SliderRowProps) {
  const isChanged = Math.abs(value - defaultVal) > 1e-9;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between gap-2">
        <span className={`text-xs font-medium ${isChanged ? "text-blue-400" : ""}`}>{label}</span>
        <div className="flex items-center gap-1">
          {isChanged && (
            <button
              className="text-[10px] text-muted-foreground hover:text-blue-400 underline"
              onClick={() => onChange(defaultVal)}
            >
              reset
            </button>
          )}
          <input
            type="number"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={e => {
              const v = parseFloat(e.target.value);
              if (!isNaN(v)) onChange(Math.max(min, Math.min(max, v)));
            }}
            className="w-16 text-xs bg-secondary border border-border rounded px-1 py-0 font-mono text-right h-6"
            data-testid={`input-punch-${label.replace(/\s/g, "-").toLowerCase()}`}
          />
        </div>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={e => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 cursor-pointer accent-blue-500"
        data-testid={`range-punch-${label.replace(/\s/g, "-").toLowerCase()}`}
      />
      {desc && <p className="text-[10px] text-muted-foreground">{desc}</p>}
    </div>
  );
}

function deepClone(cfg: PunchAnimConfig): PunchAnimConfig {
  return JSON.parse(JSON.stringify(cfg));
}

const PREVIEW_W = 280;
const PREVIEW_H = 160;

function PunchPreviewCanvas({ punchType, params }: { punchType: PunchType; params: PunchAnimParams }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const paramsRef = useRef(params);
  const punchTypeRef = useRef(punchType);
  const cycleStartRef = useRef(0);

  useEffect(() => { paramsRef.current = params; }, [params]);

  useEffect(() => {
    punchTypeRef.current = punchType;
    cycleStartRef.current = 0;
  }, [punchType]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const animate = (now: number) => {
      if (!cycleStartRef.current) cycleStartRef.current = now;

      const p = paramsRef.current;
      const { launchDelayMult, armSpeedMult, lingerMult, retractionMult } = p;
      const total = launchDelayMult + armSpeedMult + lingerMult + retractionMult;
      const CYCLE_MS = 950;

      const elapsed = (now - cycleStartRef.current) % CYCLE_MS;
      const t = elapsed / CYCLE_MS;

      const lF = launchDelayMult / total;
      const aF = armSpeedMult / total;
      const liF = lingerMult / total;
      const rF = retractionMult / total;

      let progress: number;
      if (t < lF) {
        progress = 0;
      } else if (t < lF + aF) {
        progress = aF > 0 ? (t - lF) / aF : 1;
      } else if (t < lF + aF + liF) {
        progress = 1;
      } else {
        progress = rF > 0 ? 1 - (t - lF - aF - liF) / rF : 0;
        progress = Math.max(0, Math.min(1, progress));
      }

      renderFighterPunchFrame(
        ctx, PREVIEW_W, PREVIEW_H,
        DEFAULT_PLAYER_COLORS,
        punchTypeRef.current,
        progress,
        now * 0.0025,
        1,
        {
          distanceMult: paramsRef.current.distanceMult ?? 1.0,
          arcAmplitude:  paramsRef.current.arcAmplitude,
          dropDepth:     paramsRef.current.dropDepth,
          riseHeight:    paramsRef.current.riseHeight,
          dropPhase:     paramsRef.current.dropPhase,
        }
      );

      rafRef.current = requestAnimationFrame(animate);
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <div className="flex justify-center rounded overflow-hidden bg-zinc-900">
      <canvas
        ref={canvasRef}
        width={PREVIEW_W}
        height={PREVIEW_H}
        data-testid="canvas-punch-preview"
      />
    </div>
  );
}

function configsEqual(a: PunchAnimConfig, b: PunchAnimConfig): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

interface PunchAnimEditorProps {
  defaultExpanded?: boolean;
}

export default function PunchAnimEditor({ defaultExpanded = false }: PunchAnimEditorProps = {}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [activePunch, setActivePunch] = useState<PunchType>("jab");

  const [history, setHistory] = useState<PunchAnimConfig[]>(() => [loadPunchAnimConfig()]);
  const [cursor, setCursor] = useState(0);
  const config = history[cursor];

  const [savedMsg, setSavedMsg] = useState(false);
  const [isCustom, setIsCustom] = useState(() => hasSavedPunchAnimConfig());
  const savedMsgTimer = useRef<ReturnType<typeof setTimeout>>();

  const canUndo = cursor > 0;
  const canRedo = cursor < history.length - 1;

  const isModifiedFromFile = !configsEqual(config, loadPunchAnimConfig());
  const isDefaultPreset = !isCustom && !isModifiedFromFile;

  const flashSaved = useCallback(() => {
    setSavedMsg(true);
    if (savedMsgTimer.current) clearTimeout(savedMsgTimer.current);
    savedMsgTimer.current = setTimeout(() => setSavedMsg(false), 1200);
  }, []);

  const updateParam = useCallback((punch: PunchType, field: keyof PunchAnimParams, value: number) => {
    setHistory(prev => {
      const cur = prev[cursor] ?? prev[prev.length - 1];
      const newCfg: PunchAnimConfig = {
        ...cur,
        [punch]: { ...cur[punch], [field]: value },
      };
      const trimmed = prev.slice(0, cursor + 1);
      savePunchAnimConfig(newCfg);
      invalidatePunchAnimCache();
      return [...trimmed, newCfg];
    });
    setCursor(c => c + 1);
    setIsCustom(true);
    flashSaved();
  }, [cursor, flashSaved]);

  const undo = useCallback(() => {
    setCursor(c => {
      const next = Math.max(0, c - 1);
      savePunchAnimConfig(history[next]);
      invalidatePunchAnimCache();
      return next;
    });
    flashSaved();
  }, [history, flashSaved]);

  const redo = useCallback(() => {
    setHistory(prev => {
      setCursor(c => {
        const next = Math.min(prev.length - 1, c + 1);
        savePunchAnimConfig(prev[next]);
        invalidatePunchAnimCache();
        return next;
      });
      return prev;
    });
    flashSaved();
  }, [flashSaved]);

  const resetToDefault = useCallback(() => {
    const def = deepClone(DEFAULT_PUNCH_ANIM_CONFIG);
    setHistory(prev => [...prev.slice(0, cursor + 1), def]);
    setCursor(c => c + 1);
    resetPunchAnimConfig();
    invalidatePunchAnimCache();
    setIsCustom(false);
    flashSaved();
  }, [cursor, flashSaved]);

  useEffect(() => {
    if (!expanded) return;
    const handler = (e: KeyboardEvent) => {
      const isUndo =
        ((e.metaKey && !e.ctrlKey && !e.shiftKey) || (e.ctrlKey && !e.metaKey && !e.shiftKey)) &&
        e.key.toLowerCase() === "z";
      const isRedo =
        (e.metaKey && e.ctrlKey && e.key.toLowerCase() === "z") ||
        ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "z") ||
        (e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "y");
      if (isRedo) {
        e.preventDefault();
        redo();
      } else if (isUndo) {
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [expanded, undo, redo]);

  const p = config[activePunch];
  const cat = punchCategory(activePunch);

  return (
    <Card className="w-full p-3 space-y-3">
      <button
        className="flex items-center gap-2 w-full text-left"
        onClick={() => setExpanded(x => !x)}
        data-testid="button-toggle-punch-editor"
      >
        {expanded ? <ChevronDown className="w-4 h-4 text-blue-400" /> : <ChevronRight className="w-4 h-4 text-muted-foreground" />}
        <span className="font-bold text-sm flex-1">Punch Animation Editor</span>
        {isCustom && !isDefaultPreset && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-900 text-blue-300 font-mono">CUSTOM FILE</span>
        )}
        {isDefaultPreset && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-secondary text-muted-foreground font-mono">DEFAULT</span>
        )}
      </button>

      {expanded && (
        <div className="space-y-3">
          <div className="flex items-center gap-2 flex-wrap">
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              disabled={!canUndo}
              onClick={undo}
              title="Undo (Cmd+Z / Ctrl+Z)"
              data-testid="button-punch-undo"
            >
              <Undo2 className="w-3 h-3" /> Undo
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              disabled={!canRedo}
              onClick={redo}
              title="Redo (Cmd+Ctrl+Z / Ctrl+Shift+Z)"
              data-testid="button-punch-redo"
            >
              <Redo2 className="w-3 h-3" /> Redo
            </Button>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="outline"
              className="h-7 gap-1 text-xs"
              onClick={resetToDefault}
              title="Revert all punches to factory defaults"
              data-testid="button-punch-reset-default"
            >
              <RotateCcw className="w-3 h-3" /> Reset to Default
            </Button>
            <span
              className={`flex items-center gap-1 text-xs font-medium transition-opacity ${savedMsg ? "opacity-100 text-green-400" : "opacity-60 text-muted-foreground"}`}
              data-testid="text-punch-autosave-status"
            >
              <Save className="w-3 h-3" />
              {savedMsg ? "Saved" : "Autosaves instantly"}
            </span>
          </div>

          <div className="flex gap-1 flex-wrap">
            {PUNCH_TYPES.map(pt => (
              <button
                key={pt}
                onClick={() => setActivePunch(pt)}
                className={`text-xs px-2 py-1 rounded border transition-colors ${
                  activePunch === pt
                    ? "bg-blue-800 border-blue-500 text-blue-100"
                    : "bg-secondary border-border text-muted-foreground hover:text-foreground"
                }`}
                data-testid={`button-punch-tab-${pt}`}
              >
                {PUNCH_LABELS[pt]}
              </button>
            ))}
          </div>

          <div className="flex gap-3 items-start">
            <div className="flex-1 min-w-0 space-y-4">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-green-400 mb-2">
                  Base Damage
                  <span className="ml-1 font-normal normal-case text-muted-foreground">
                    — raw damage before fighter/archetype/refinement multipliers
                  </span>
                </p>
                <div className="space-y-3">
                  <SliderRow
                    label="Base Damage"
                    desc="Raw damage this punch deals on a clean hit, before any multipliers"
                    value={p.damage}
                    min={0.5} max={30} step={0.01}
                    defaultVal={DEFAULT_PUNCH_ANIM_CONFIG[activePunch].damage}
                    onChange={v => updateParam(activePunch, "damage", v)}
                  />
                </div>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-yellow-400 mb-2">
                  Base Stamina Cost
                  <span className="ml-1 font-normal normal-case text-muted-foreground">
                    — raw stamina spent throwing this punch, before fighter multipliers
                  </span>
                </p>
                <div className="space-y-3">
                  <SliderRow
                    label="Base Stamina Cost"
                    desc="Raw stamina consumed each time this punch is thrown, before any multipliers"
                    value={p.staminaCost}
                    min={0.1} max={20} step={0.01}
                    defaultVal={DEFAULT_PUNCH_ANIM_CONFIG[activePunch].staminaCost}
                    onChange={v => updateParam(activePunch, "staminaCost", v)}
                  />
                </div>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-orange-400 mb-2">Timing</p>
                <div className="space-y-3">
                  <SliderRow
                    label="Launch Delay"
                    desc="Wind-up time before arm extends (×default)"
                    value={p.launchDelayMult}
                    min={0.1} max={4.0} step={0.01}
                    defaultVal={1.0}
                    onChange={v => updateParam(activePunch, "launchDelayMult", v)}
                  />
                  <SliderRow
                    label="Extension Speed"
                    desc="How long the arm extends (×default; higher = slower)"
                    value={p.armSpeedMult}
                    min={0.1} max={4.0} step={0.01}
                    defaultVal={1.0}
                    onChange={v => updateParam(activePunch, "armSpeedMult", v)}
                  />
                  <SliderRow
                    label="Linger Hold"
                    desc="Time arm stays at full extension (×default)"
                    value={p.lingerMult}
                    min={0.1} max={4.0} step={0.01}
                    defaultVal={1.0}
                    onChange={v => updateParam(activePunch, "lingerMult", v)}
                  />
                  <SliderRow
                    label="Retraction"
                    desc="Pull-back speed after linger (×default)"
                    value={p.retractionMult}
                    min={0.1} max={4.0} step={0.01}
                    defaultVal={1.0}
                    onChange={v => updateParam(activePunch, "retractionMult", v)}
                  />
                  <SliderRow
                    label="Lockout (ms)"
                    desc="Input lockout at retraction start — time before next punch can be thrown (at FT 0; scales to 0 at FT 100)"
                    value={p.lockoutMs}
                    min={0} max={600} step={5}
                    defaultVal={200}
                    onChange={v => updateParam(activePunch, "lockoutMs", v)}
                  />
                </div>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-purple-400 mb-2">
                  Trajectory
                  <span className="ml-1 font-normal normal-case text-muted-foreground">
                    — {cat === "straight" ? "Straight punch" : cat === "hook" ? "Hook arc" : "Uppercut arc"}
                  </span>
                </p>
                <div className="space-y-3">
                  {cat === "straight" && (
                    <>
                      <SliderRow
                        label="Angle (Y)"
                        desc="Vertical angle at full extension (negative = upward)"
                        value={p.angle}
                        min={-50} max={20} step={0.5}
                        defaultVal={-13}
                        onChange={v => updateParam(activePunch, "angle", v)}
                      />
                      <SliderRow
                        label="Reach Multiplier"
                        desc="How far the fist extends horizontally (×base range)"
                        value={p.reachMult}
                        min={0.1} max={2.0} step={0.01}
                        defaultVal={1.0}
                        onChange={v => updateParam(activePunch, "reachMult", v)}
                      />
                      <SliderRow
                        label="Distance"
                        desc="Visual landing distance — stretches or shortens the entire punch reach"
                        value={p.distanceMult ?? 1.0}
                        min={0.2} max={2.5} step={0.05}
                        defaultVal={1.0}
                        onChange={v => updateParam(activePunch, "distanceMult", v)}
                      />
                    </>
                  )}
                  {cat === "hook" && (
                    <>
                      <SliderRow
                        label="Arc Height"
                        desc="How high the fist rises at the peak of the hook arc"
                        value={p.arcAmplitude}
                        min={0} max={50} step={0.5}
                        defaultVal={15}
                        onChange={v => updateParam(activePunch, "arcAmplitude", v)}
                      />
                      <SliderRow
                        label="Distance"
                        desc="Visual landing distance — stretches or shortens the hook's forward reach"
                        value={p.distanceMult ?? 1.0}
                        min={0.2} max={2.5} step={0.05}
                        defaultVal={1.0}
                        onChange={v => updateParam(activePunch, "distanceMult", v)}
                      />
                    </>
                  )}
                  {cat === "uppercut" && (
                    <>
                      <SliderRow
                        label="Load Depth"
                        desc="How far the fist sinks during the wind-up before rising"
                        value={p.dropDepth}
                        min={0} max={25} step={0.5}
                        defaultVal={9}
                        onChange={v => updateParam(activePunch, "dropDepth", v)}
                      />
                      <SliderRow
                        label="Load Duration"
                        desc="Fraction of the swing spent loading before the upward sweep begins"
                        value={p.dropPhase}
                        min={0.05} max={0.70} step={0.01}
                        defaultVal={0.32}
                        onChange={v => updateParam(activePunch, "dropPhase", v)}
                      />
                      <SliderRow
                        label="Strike Height"
                        desc="How high the fist rises when striking — the peak of the U-arc"
                        value={p.riseHeight}
                        min={0} max={50} step={0.5}
                        defaultVal={22}
                        onChange={v => updateParam(activePunch, "riseHeight", v)}
                      />
                      <SliderRow
                        label="Distance"
                        desc="Visual landing distance — stretches the parabola's forward reach"
                        value={p.distanceMult ?? 1.0}
                        min={0.2} max={2.5} step={0.05}
                        defaultVal={1.0}
                        onChange={v => updateParam(activePunch, "distanceMult", v)}
                      />
                    </>
                  )}
                </div>
              </div>

              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wider text-red-400 mb-2">
                  Gameplay Hit Range
                  <span className="ml-1 font-normal normal-case text-muted-foreground">
                    — actual reach used for hit detection, not visual
                  </span>
                </p>
                <div className="space-y-3">
                  <SliderRow
                    label="Hit Range (px)"
                    desc="Real distance the punch must be within to actually land — independent of Reach/Distance above, which are visual only"
                    value={p.hitRangePx}
                    min={10} max={150} step={1}
                    defaultVal={DEFAULT_PUNCH_ANIM_CONFIG[activePunch].hitRangePx}
                    onChange={v => updateParam(activePunch, "hitRangePx", v)}
                  />
                </div>
              </div>
            </div>

            <div className="shrink-0 self-start sticky top-4">
              <p className="text-[10px] text-muted-foreground text-center mb-1 font-medium">{PUNCH_LABELS[activePunch]}</p>
              <PunchPreviewCanvas punchType={activePunch} params={config[activePunch]} />
            </div>
          </div>

          <p className="text-[10px] text-muted-foreground">
            Every change saves instantly — no need to hit save. Use <kbd className="bg-secondary px-1 rounded">⌘Z</kbd> / <kbd className="bg-secondary px-1 rounded">Ctrl+Z</kbd> to undo, <kbd className="bg-secondary px-1 rounded">⌘⌃Z</kbd> / <kbd className="bg-secondary px-1 rounded">Ctrl+Shift+Z</kbd> for infinite redo. "Reset to Default" restores factory values for all punches.
          </p>
        </div>
      )}
    </Card>
  );
}
