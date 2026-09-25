import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RotateCcw, ChevronDown, ChevronRight } from "lucide-react";
import { REFINEMENT_LABELS, type RefinementKey } from "@/game/refinementKeys";
import {
  REFINEMENT_TUNING_SPEC,
  getRefinementTuning,
  saveRefinementTuning,
  resetRefinementTuning,
  type RefinementTuning,
} from "@/game/refinementTuning";

const GROUPS: { title: string; keys: RefinementKey[] }[] = [
  { title: "Offense", keys: ["pressureFighter", "precisionStriker", "jabPower", "hookPower", "uppercutPower", "bruiser", "koArtist"] },
  { title: "Defense", keys: ["ironChin", "slippery", "guardMaster", "duckRecovery", "punchRolling"] },
  { title: "Fight IQ", keys: ["fastTwitch", "heartRefinement", "chinHitter", "technician", "lifeDrain"] },
];

/**
 * Every refinement number, editable. Writes straight to storage on each
 * keystroke — no save button, no confirmation.
 */
export function RefinementTuningCard() {
  const [cfg, setCfg] = useState<RefinementTuning>(() => getRefinementTuning());
  const [open, setOpen] = useState<Record<string, boolean>>({});

  const write = (key: RefinementKey, field: string, raw: string) => {
    const val = parseFloat(raw);
    if (isNaN(val)) return;
    const next: RefinementTuning = { ...cfg, [key]: { ...cfg[key], [field]: val } };
    setCfg(next);
    saveRefinementTuning(next);
  };

  const field = (key: RefinementKey, name: string, step: number, testId: string) => (
    <Input
      type="number"
      step={step}
      value={cfg[key][name]}
      onChange={e => write(key, name, e.target.value)}
      className="w-20 h-7 text-xs text-right"
      data-testid={testId}
    />
  );

  return (
    <Card className="p-3 w-full space-y-3" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }}>
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>Refinement Values</p>
          <p className="text-[10px]" style={{ color: "#66aa66" }}>Every number behind the skills. L1 and L100 are the ends of the curve; the rest are flat.</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCfg(resetRefinementTuning())}
          className="text-xs h-7 px-2"
          data-testid="button-reset-refinement-tuning"
          style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}
        >
          <RotateCcw className="w-3 h-3 mr-1" /> Reset
        </Button>
      </div>

      {GROUPS.map(({ title, keys }) => (
        <div key={title} className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide pt-1" style={{ color: "#4d8a4d" }}>{title}</p>
          {keys.map(key => {
            const isOpen = open[key] ?? false;
            return (
              <div key={key} className="rounded" style={{ border: "1px solid #163816" }}>
                <button
                  type="button"
                  onClick={() => setOpen(o => ({ ...o, [key]: !isOpen }))}
                  className="w-full flex items-center gap-1 px-2 py-1 text-xs"
                  style={{ color: "#c8ffaa" }}
                  data-testid={`toggle-reftune-${key}`}
                >
                  {isOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                  {REFINEMENT_LABELS[key]}
                </button>
                {isOpen && (
                  <div className="px-2 pb-2 space-y-1">
                    <div className="flex items-center gap-2 text-[10px]" style={{ color: "#4d8a4d" }}>
                      <span className="flex-1" />
                      <span className="w-20 text-right">L1</span>
                      <span className="w-20 text-right">L100</span>
                    </div>
                    {REFINEMENT_TUNING_SPEC[key].map(row => (
                      <div key={row.field} className="flex items-center gap-2">
                        <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>{row.label}</span>
                        {row.kind === "curve" ? (
                          <>
                            {field(key, `${row.field}L1`, row.step ?? 0.01, `input-reftune-${key}-${row.field}L1`)}
                            {field(key, `${row.field}L100`, row.step ?? 0.01, `input-reftune-${key}-${row.field}L100`)}
                          </>
                        ) : (
                          <>
                            <span className="w-20" />
                            {field(key, row.field, row.step ?? 0.01, `input-reftune-${key}-${row.field}`)}
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}
    </Card>
  );
}
