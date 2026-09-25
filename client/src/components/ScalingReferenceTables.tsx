import { useState, useRef, useEffect, useCallback } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { RotateCcw, ChevronDown, ChevronRight, AlertTriangle } from "lucide-react";
import {
  LEVEL_RAMP_DEFS, POINT_COEF_DEFS, LEVEL_GAP_DEFS, getScaling, setRampField, setRampMaxLevel,
  setPointCoef, setCap, setGapField, resetScaling, levelScale, clampGapMult,
  type RampGroup, type PointStat, type ScalingCaps,
} from "@/lib/scalingConfig";

const RAMP_GROUPS: RampGroup[] = ["Stamina", "Offense", "Defense", "Movement", "Telegraph", "AI"];
const POINT_STATS: PointStat[] = ["Power", "Speed", "Defense", "Stamina", "Focus"];

const PANEL_BG = "#0d1a2e";
const PANEL_BORDER = "1px solid #2a4a7a";
const LABEL = "#c8ffaa";
const MUTED = "#7fa8d4";

/** Trims trailing zeros so a table of multipliers stays readable. */
function fmt(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  const dp = abs >= 100 ? 0 : abs >= 10 ? 1 : abs >= 1 ? 2 : 3;
  return v.toFixed(dp).replace(/\.?0+$/, "") || "0";
}

/**
 * Writes through on every keystroke while keeping its own text state, so the
 * value is saved the instant it is typed without the caret jumping when the
 * surrounding table re-renders.
 */
function NumCell({ value, onCommit, testId, width = "w-20" }: {
  value: number; onCommit: (v: number) => void; testId: string; width?: string;
}) {
  const [txt, setTxt] = useState(() => String(value));
  const seen = useRef(value);
  useEffect(() => {
    if (seen.current !== value) { seen.current = value; setTxt(String(value)); }
  }, [value]);
  return (
    <input
      type="number"
      step="any"
      value={txt}
      onChange={e => {
        const raw = e.target.value;
        setTxt(raw);
        const n = parseFloat(raw);
        if (Number.isFinite(n)) { seen.current = n; onCommit(n); }
      }}
      className={`${width} h-7 px-1.5 text-xs text-right rounded bg-black/40 border border-[#2a4a7a] text-white focus:outline-none focus:border-[#4a8ada]`}
      data-testid={testId}
    />
  );
}

export default function ScalingReferenceTables() {
  const [open, setOpen] = useState(false);
  // Bumped after every write so the derived columns recompute immediately.
  const [, setRev] = useState(0);
  const bump = useCallback(() => setRev(r => r + 1), []);
  const cfg = getScaling();
  const topLevel = cfg.rampMaxLevel;
  const capped = topLevel < 1000;
  const gapAhead = (id: string) => cfg.gaps[id]?.ahead ?? 0;

  const resetAll = () => {
    if (!confirm("Reset every level-gap effect, level ramp, stat-point coefficient and cap back to the original values?")) return;
    resetScaling();
    bump();
  };

  if (!open) {
    return (
      <Card className="p-2 w-full" style={{ background: PANEL_BG, border: PANEL_BORDER }}>
        <button
          className="flex items-center gap-2 w-full text-left"
          onClick={() => setOpen(true)}
          data-testid="button-open-scaling"
        >
          <ChevronRight className="w-4 h-4" style={{ color: LABEL }} />
          <span className="text-sm font-semibold" style={{ color: LABEL }}>Level &amp; Stat Scaling</span>
          {capped && (
            <span className="ml-auto flex items-center gap-1 text-[10px]" style={{ color: "#ffb84d" }}>
              <AlertTriangle className="w-3 h-3" />
              ramps stop at level {topLevel}
            </span>
          )}
        </button>
      </Card>
    );
  }

  return (
    <Card className="p-3 w-full space-y-3" style={{ background: PANEL_BG, border: PANEL_BORDER }}>
      <div className="flex items-center gap-2">
        <button className="flex items-center gap-2 flex-1 text-left" onClick={() => setOpen(false)} data-testid="button-close-scaling">
          <ChevronDown className="w-4 h-4" style={{ color: LABEL }} />
          <span className="text-sm font-semibold" style={{ color: LABEL }}>Level &amp; Stat Scaling</span>
        </button>
        <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={resetAll} data-testid="button-reset-scaling">
          <RotateCcw className="w-3 h-3" /> Reset
        </Button>
      </div>

      <p className="text-[10px] leading-relaxed" style={{ color: MUTED }}>
        Saves the moment you type. Kept outside your career, so it survives deleting a save and travels
        inside exported save files. Changes apply to the next fight you start.
      </p>

      {/* ---- the knob that decides whether levels past 100 mean anything ---- */}
      <div className="rounded-md p-2 space-y-1.5" style={{ background: "#0a1424", border: PANEL_BORDER }}>
        <div className="flex items-center gap-2">
          <span className="text-xs flex-1" style={{ color: LABEL }}>Ramps reach full value at level</span>
          <NumCell
            value={topLevel}
            onCommit={v => { setRampMaxLevel(Math.max(2, Math.min(1000, Math.round(v)))); bump(); }}
            testId="input-ramp-max-level"
          />
        </div>
        {capped ? (
          <p className="text-[10px] flex items-start gap-1" style={{ color: "#ffb84d" }}>
            <AlertTriangle className="w-3 h-3 mt-px shrink-0" />
            <span>
              Every stat below is maxed at level {topLevel}. Levels {topLevel + 1}–1000 currently grant
              nothing. Set this to 1000 to spread the same growth linearly across the full range.
            </span>
          </p>
        ) : (
          <p className="text-[10px]" style={{ color: "#7fdd7f" }}>
            Growth is spread linearly all the way to level 1000.
          </p>
        )}
      </div>

      {/* ---- level gap: fighter vs fighter, one row per effect ---- */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs font-semibold flex-1" style={{ color: LABEL }}>Level gap (fighter vs fighter)</span>
          <span className="text-[10px] w-20 text-right" style={{ color: MUTED }}>Ahead</span>
          <span className="text-[10px] w-20 text-right" style={{ color: MUTED }}>Behind</span>
          <span className="text-[10px] w-8" />
        </div>
        <p className="text-[10px] leading-relaxed px-1" style={{ color: MUTED }}>
          Per level of <em>difference</em> between the two fighters, on top of their own level growth.
          <span style={{ color: "#dce9f7" }}> Ahead</span> is what the higher-level fighter gains,
          <span style={{ color: "#dce9f7" }}> Behind</span> what the lower-level one gives up. Both sides of every
          row are editable; the rows sitting at 0 in Behind are switched off on that side until you raise them.
          Zero both columns to remove an effect from the game entirely.
        </p>
        {LEVEL_GAP_DEFS.map(d => {
          const g = cfg.gaps[d.id];
          if (!g) return null;
          return (
            <div key={d.id} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-white/5">
              <span className="text-xs flex-1 truncate" style={{ color: "#dce9f7" }} title={d.note ? `${d.label} — ${d.note}` : d.label}>
                {d.label}
                {d.note && <span className="text-[9px] ml-1" style={{ color: MUTED }}>({d.note})</span>}
              </span>
              <NumCell value={g.ahead} onCommit={v => { setGapField(d.id, "ahead", v); bump(); }} testId={`input-gap-${d.id}-ahead`} />
              <NumCell value={g.behind} onCommit={v => { setGapField(d.id, "behind", v); bump(); }} testId={`input-gap-${d.id}-behind`} />
              <span className="text-[10px] w-8" style={{ color: MUTED }}>{d.unit}</span>
            </div>
          );
        })}
        <div className="rounded-md p-2 mt-1" style={{ background: "#0a1424", border: PANEL_BORDER }}>
          <p className="text-[10px] mb-1" style={{ color: MUTED }}>What the higher-level fighter walks in with, at a few gaps</p>
          <div className="flex gap-3 flex-wrap">
            {[10, 50, 200].map(gap => (
              <span key={gap} className="text-[11px] tabular-nums" style={{ color: "#dce9f7" }}>
                <span style={{ color: MUTED }}>+{gap} lv</span>{" "}
                {fmt(clampGapMult(1 + gapAhead("gapMoveSpeed") * gap))}x speed, {fmt(clampGapMult(1 + gapAhead("gapDamage") * gap))}x power
              </span>
            ))}
          </div>
        </div>
      </div>

      {/* ---- level ramps ---- */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs font-semibold flex-1" style={{ color: LABEL }}>Level-driven stats</span>
          <span className="text-[10px] w-20 text-right" style={{ color: MUTED }}>Level 1</span>
          <span className="text-[10px] w-20 text-right" style={{ color: MUTED }}>Level 1000</span>
          <span className="text-[10px] w-8" />
        </div>
        {RAMP_GROUPS.map(group => {
          const rows = LEVEL_RAMP_DEFS.filter(d => d.group === group);
          if (rows.length === 0) return null;
          return (
            <div key={group} className="space-y-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide px-1 pt-1" style={{ color: MUTED }}>{group}</p>
              {rows.map(d => {
                const r = cfg.ramps[d.id];
                return (
                  <div key={d.id} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-white/5">
                    <span className="text-xs flex-1 truncate" style={{ color: "#dce9f7" }} title={d.note ? `${d.label} — ${d.note}` : d.label}>
                      {d.label}
                      {d.note && <span className="text-[9px] ml-1" style={{ color: MUTED }}>({d.note})</span>}
                    </span>
                    <NumCell value={r.min} onCommit={v => { setRampField(d.id, "min", v); bump(); }} testId={`input-ramp-${d.id}-min`} />
                    <NumCell value={r.max} onCommit={v => { setRampField(d.id, "max", v); bump(); }} testId={`input-ramp-${d.id}-max`} />
                    <span className="text-[10px] w-8" style={{ color: MUTED }}>{d.unit}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* ---- stat-point coefficients ---- */}
      <div className="space-y-2 pt-1">
        <div className="flex items-center gap-2 px-1">
          <span className="text-xs font-semibold flex-1" style={{ color: LABEL }}>Stat-point effects</span>
          <span className="text-[10px] w-20 text-right" style={{ color: MUTED }}>Coefficient</span>
          <span className="text-[10px] w-16 text-right" style={{ color: MUTED }}>@ 0 pts</span>
          <span className="text-[10px] w-16 text-right" style={{ color: MUTED }}>@ 1000</span>
          <span className="text-[10px] w-8" />
        </div>
        {POINT_STATS.map(stat => {
          const rows = POINT_COEF_DEFS.filter(d => d.stat === stat);
          if (rows.length === 0) return null;
          return (
            <div key={stat} className="space-y-0.5">
              <p className="text-[10px] font-semibold uppercase tracking-wide px-1 pt-1" style={{ color: MUTED }}>{stat}</p>
              {rows.map(d => {
                const coef = cfg.points[d.id];
                let lo = NaN, hi = NaN;
                try {
                  lo = d.atPoints(coef, 0, cfg.caps);
                  hi = d.atPoints(coef, 1000, cfg.caps);
                } catch {}
                return (
                  <div key={d.id} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-white/5">
                    <span className="text-xs flex-1 truncate" style={{ color: "#dce9f7" }} title={d.note ? `${d.label} — ${d.note}` : d.label}>
                      {d.label}
                      {d.note && <span className="text-[9px] ml-1" style={{ color: MUTED }}>({d.note})</span>}
                    </span>
                    <NumCell value={coef} onCommit={v => { setPointCoef(d.id, v); bump(); }} testId={`input-point-${d.id}`} />
                    <span className="text-[11px] w-16 text-right tabular-nums" style={{ color: MUTED }}>{fmt(lo)}</span>
                    <span className="text-[11px] w-16 text-right tabular-nums font-semibold" style={{ color: "#dce9f7" }}>{fmt(hi)}</span>
                    <span className="text-[10px] w-8" style={{ color: MUTED }}>{d.unit}</span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {/* ---- caps: why some stats stop paying long before 1000 points ---- */}
      <div className="space-y-1 pt-1">
        <p className="text-xs font-semibold px-1" style={{ color: LABEL }}>Stat-point caps</p>
        {([
          ["maxSp", "Points for full effect (power / defense / focus / pool)"],
          ["speedSoftCap", "Speed soft cap — points past this stop helping"],
          ["speedDivisor", "Speed divisor"],
          ["speedHandicapStrength", "Speed handicap strength — 0 turns it off"],
          ["staminaRegenCap", "Stamina regen cap — points past this stop helping"],
          ["staminaRegenDivisor", "Stamina regen divisor"],
        ] as [keyof ScalingCaps, string][]).map(([key, label]) => (
          <div key={key} className="flex items-center gap-2 px-1 py-0.5 rounded hover:bg-white/5">
            <span className="text-xs flex-1 truncate" style={{ color: "#dce9f7" }}>{label}</span>
            <NumCell value={cfg.caps[key]} onCommit={v => { setCap(key, v); bump(); }} testId={`input-cap-${key}`} />
          </div>
        ))}
        <p className="text-[10px] leading-relaxed px-1 pt-1" style={{ color: MUTED }}>
          Speed points past the soft cap stop making a fighter faster and instead <em>slow their opponent</em> in
          proportion to the gap between the two speed stats — so a much slower fighter is punished rather than the
          fast one running away with it. This is a speed-stat discrepancy, not a level one, which is why it lives
          here and not in the level-gap table. Handicap strength scales only that slow-down: 1 is the original
          behaviour, 0 leaves the soft cap in place but stops it punishing the slower fighter.
        </p>
      </div>

      {/* ---- a worked example so the ramp change is legible at a glance ---- */}
      <div className="rounded-md p-2" style={{ background: "#0a1424", border: PANEL_BORDER }}>
        <p className="text-[10px] mb-1" style={{ color: MUTED }}>Punching power at a few levels, using the curve above</p>
        <div className="flex gap-3 flex-wrap">
          {[1, 100, 250, 500, 1000].map(lv => (
            <span key={lv} className="text-[11px] tabular-nums" style={{ color: "#dce9f7" }}>
              <span style={{ color: MUTED }}>L{lv}</span> {fmt(levelScale(lv, 1, 3.5, "damageMult"))}x
            </span>
          ))}
        </div>
      </div>
    </Card>
  );
}
