/**
 * Neural Network → Sparring Rewards: the accuracy-upgrade threshold and the
 * per-tier reward table for ordinary sparring. Stored under
 * SPARRING_REWARD_CONFIG_KEY, which the parameter file / shipped defaults carry.
 */
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { RotateCcw } from "lucide-react";
import {
  getSparringRewardConfig, saveSparringRewardConfig, resetSparringRewardConfig,
  SPARRING_REWARD_TIERS, SPARRING_TIER_LABELS, SPARRING_FIELD_RANGES,
  type SparringRewardConfig, type SparringTierRewards,
} from "@/game/sparringRewards";

const FIELDS: { key: keyof SparringTierRewards; label: string; step: string }[] = [
  { key: "xpMult", label: "XP ×", step: "0.05" },
  { key: "winPoints", label: "Win pts", step: "1" },
  { key: "pointCap", label: "Pt cap", step: "1" },
];

export default function SparringRewardsCard() {
  const [cfg, setCfg] = useState<SparringRewardConfig>(() => getSparringRewardConfig());
  const commit = (next: SparringRewardConfig) => setCfg(saveSparringRewardConfig(next));

  const setTierField = (tier: keyof SparringRewardConfig["tiers"], key: keyof SparringTierRewards, raw: string) => {
    const v = Number(raw);
    if (raw === "" || !Number.isFinite(v)) return;
    commit({ ...cfg, tiers: { ...cfg.tiers, [tier]: { ...cfg.tiers[tier], [key]: v } } });
  };

  return (
    <Card className="p-3 w-full space-y-3" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }} data-testid="card-sparring-rewards">
      <div className="flex items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>Sparring Rewards</p>
          <p className="text-[10px]" style={{ color: "#66aa66" }}>Journeyman–Champion sparring. An accurate win pays the next tier's row.</p>
        </div>
        <Button
          size="sm" variant="outline" className="text-xs h-7 px-2"
          style={{ borderColor: "#1a7a1a", color: "#c8ffaa" }}
          onClick={() => { resetSparringRewardConfig(); setCfg(getSparringRewardConfig()); }}
          data-testid="button-reset-sparring-rewards"
        >
          <RotateCcw className="w-3 h-3 mr-1" /> Reset
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <span className="text-xs flex-1" style={{ color: "#c8ffaa" }}>Upgrade accuracy (%) — 101 turns it off</span>
        <Input
          type="number" step="1" min={0} max={101}
          value={cfg.upgradeAccuracyPct}
          onChange={e => { const v = Number(e.target.value); if (e.target.value !== "" && Number.isFinite(v)) commit({ ...cfg, upgradeAccuracyPct: v }); }}
          className="w-24 h-7 text-xs text-right"
          data-testid="input-sparring-upgrade-accuracy"
        />
      </div>
      <label className="flex items-center gap-2 text-xs cursor-pointer" style={{ color: "#c8ffaa" }}>
        <input
          type="checkbox"
          checked={cfg.upgradeItemFloor}
          onChange={e => commit({ ...cfg, upgradeItemFloor: e.target.checked })}
          data-testid="toggle-sparring-item-floor"
        />
        Upgraded win's item is at least the upgraded grade
      </label>

      <div className="grid grid-cols-[1fr_repeat(3,5rem)] gap-x-2 gap-y-1 items-center">
        <span />
        {FIELDS.map(f => <span key={f.key} className="text-[10px] text-right" style={{ color: "#8fdc6a" }}>{f.label}</span>)}
        {SPARRING_REWARD_TIERS.map(tier => (
          <div key={tier} className="contents">
            <span className="text-xs" style={{ color: "#c8ffaa" }}>{SPARRING_TIER_LABELS[tier]}{tier === "undisputed" ? " (reward only)" : ""}</span>
            {FIELDS.map(f => (
              <Input
                key={f.key}
                type="number" step={f.step}
                min={SPARRING_FIELD_RANGES[f.key][0]} max={SPARRING_FIELD_RANGES[f.key][1]}
                value={cfg.tiers[tier][f.key]}
                onChange={e => setTierField(tier, f.key, e.target.value)}
                className="h-7 text-xs text-right"
                data-testid={`input-sparring-${tier}-${f.key}`}
              />
            ))}
          </div>
        ))}
      </div>
      <p className="text-[10px]" style={{ color: "#66aa66" }}>
        Win pts are the starting points before bonuses; the cap is the per-session ceiling (halved after 4 idle weeks). Edits apply to the next session.
      </p>
    </Card>
  );
}
