/**
 * Equipment Upgrades — the full-screen page behind the gym crate.
 *
 * Five pieces of gear, one level bought at a time with a compounding Force
 * price. Every tenth level of a piece hands over a chest, which is granted by
 * the purchase itself and only displayed here.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Lock } from "lucide-react";
import type { Fighter } from "@shared/schema";
import type { FighterColors } from "@/game/types";
import { cssColorOf } from "@/game/spacialColor";
import CrateRevealView from "@/components/CrateRevealView";
import { type CrateId } from "@/game/cratesConfig";
import {
  EQUIPMENT,
  EQUIPMENT_PER_LEVEL,
  EQUIPMENT_POOL_BONUS_CAP_SHARE,
  mouthguardBigShotNegate,
  EQUIPMENT_SLOTS,
  formatEquipmentCost,
  quoteEquipmentUpgrade,
  type EquipmentSlot,
} from "@/game/equipmentConfig";
import {
  buyEquipmentLevel,
  equipmentCareerWins,
  getEquipmentLevels,
  markEquipmentSlotsSeen,
} from "@/lib/equipmentUpgrades";

interface EquipmentUpgradesViewProps {
  fighter: Fighter;
  /** The player's own gear colours — what the outlined icons are tinted with. */
  playerColors: FighterColors;
  onBack: () => void;
  /** Fires after every purchase so the career hub picks up the new save. */
  onFighterChanged?: (f: Fighter) => void;
}

// ---------------------------------------------------------------- icons

const ICON_PATHS: Record<EquipmentSlot, string[]> = {
  gloves: [
    "M7 19h7v2H7z",
    "M7 19c-2 0-3.6-1.7-3.6-3.8V9.4C3.4 7 5.3 5 7.7 5h4.8C15.7 5 18 7.4 18 10.5v1.7c0 2.6-1.7 4.8-4.1 5.5",
    "M18 10h1.3c1 0 1.9 1 1.9 2.1s-.9 2.1-1.9 2.1H18",
  ],
  shoes: [
    "M3.2 12h3.1l3 2h4.9c3 0 5.6 1.4 5.6 3.3V18a1 1 0 0 1-1 1H4.2a1 1 0 0 1-1-1z",
    "M6.3 12V9",
    "M9.3 14l2.2-2.1",
  ],
  trunks: [
    "M5.3 6h13.4v2.2H5.3z",
    "M5.6 8.2 4.5 18h4.9L12 12.4 14.6 18h4.9L18.4 8.2z",
  ],
  mouthguard: [
    "M4 9.3C4 7.5 7.6 6.1 12 6.1s8 1.4 8 3.2c0 4.5-3.1 8.2-8 8.2s-8-3.7-8-8.2z",
    "M6.6 10c1.7-1 9.1-1 10.8 0",
  ],
  wraps: [
    "M7 19h8.4c2.3 0 4-1.9 4-4.2v-3.6c0-2.3-1.7-4.2-4-4.2H9.2C6.3 7 4 9.4 4 12.3V15c0 2.2 1.3 4 3 4z",
    "M4.3 10.6h15",
    "M4 13.7h15.4",
    "M5.2 16.8h14",
  ],
};

function EquipmentIcon({ slot, color, dim }: { slot: EquipmentSlot; color: string; dim: boolean }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className="w-12 h-12 shrink-0"
      style={{ opacity: dim ? 0.35 : 1 }}
      aria-hidden="true"
    >
      {ICON_PATHS[slot].map((d, i) => (
        <path
          key={i}
          d={d}
          fill={i === 0 || slot === "mouthguard" || slot === "trunks" ? color : "none"}
          fillOpacity={0.16}
          stroke={color}
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

// ---------------------------------------------------------------- effects text

const pct = (v: number, digits = 2) => `${(v * 100).toFixed(digits)}%`;

/** What a piece is worth right now, in the same order as its effect blurbs. */
function slotTotals(slot: EquipmentSlot, level: number): string[] {
  const P = EQUIPMENT_PER_LEVEL;
  switch (slot) {
    case "gloves":
      return [`+${pct(level * P.glovesPowerPct)} punch power`, `+${pct(level * P.glovesAutoGuardPct)} auto-guard duration`];
    case "shoes":
      return [`+${pct(level * P.shoesMoveSpeedPct)} movement speed`];
    case "trunks":
      return [`+${(level * P.trunksStartMaxStamina).toLocaleString()} max stamina at the bell, up to +${pct(EQUIPMENT_POOL_BONUS_CAP_SHARE, 0)} of your own tank`];
    case "mouthguard":
      return [
        `+${pct(Math.min(1, level * P.mouthguardNegateChance), 3)} to shrug off a max-stamina loss`,
        `+${pct(Math.min(1, level * P.mouthguardCritDamageResistPct))} crit damage resistance`,
        `${pct(mouthguardBigShotNegate(level), 1)} to shrug off a Big Shot`,
      ];
    case "wraps":
      return [
        `+${pct(level * P.wrapsBlockPct)} blocking effectiveness`,
        `+${pct(level * P.wrapsPerfectBlockHoldPct)} perfect block hold time`,
        `+${pct(level * P.wrapsCritPct)} crit chance`,
        `+${pct(level * P.wrapsStunPct)} stun chance`,
      ];
  }
}

// ---------------------------------------------------------------- page

export default function EquipmentUpgradesView({ fighter, playerColors, onBack, onFighterChanged }: EquipmentUpgradesViewProps) {
  const [save, setSave] = useState<Fighter>(fighter);
  const [reveal, setReveal] = useState<{ crateId: CrateId; itemIds: string[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const onChangedRef = useRef(onFighterChanged);
  onChangedRef.current = onFighterChanged;

  // Opening the page is what clears the hub milestone and the crate's red dot.
  useEffect(() => {
    const seen = markEquipmentSlotsSeen(fighter.id);
    if (seen) { setSave(seen); onChangedRef.current?.(seen); }
  }, [fighter.id]);

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 2200);
    return () => window.clearTimeout(t);
  }, [notice]);

  const levels = useMemo(() => getEquipmentLevels(save), [save]);
  const wins = equipmentCareerWins(save);
  const force = save.force ?? 0;
  const diamonds = save.diamonds ?? 0;

  const tintOf = (tint: "gloves" | "shoes" | "trunks" | "neutral"): string =>
    tint === "neutral" ? "#e8e8e8" : cssColorOf(playerColors[tint]);

  const buy = (slot: EquipmentSlot) => {
    const res = buyEquipmentLevel(save.id, slot);
    if (!res.ok || !res.fighter) { setNotice(res.message ?? "Purchase failed"); return; }
    setSave(res.fighter);
    onChangedRef.current?.(res.fighter);
    if (res.crate) setReveal(res.crate);
  };

  return (
    <div className="min-h-screen bg-gradient-to-b from-[#0d0d0f] to-[#161418] text-white p-4 md:p-8">
      <div className="max-w-5xl mx-auto">
        <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
          <button
            onClick={onBack}
            className="flex items-center gap-2 px-3 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 border border-white/10 text-sm"
            data-testid="button-equipment-back"
          >
            <ArrowLeft className="w-4 h-4" /> Back to Gym
          </button>
          <div className="flex items-center gap-4 text-sm">
            <span className="text-yellow-400 font-bold" data-testid="text-equipment-force">⚡ {Math.floor(force).toLocaleString()}</span>
            <span className="text-cyan-300 font-bold" data-testid="text-equipment-diamonds">💎 {diamonds.toLocaleString()}</span>
            <span className="text-white/50">{wins} career {wins === 1 ? "win" : "wins"}</span>
          </div>
        </div>

        <div className="mb-6">
          <h1 className="text-3xl font-black tracking-tight">Equipment Upgrades</h1>
        </div>

        {notice && (
          <div className="mb-4 px-4 py-2 rounded-lg bg-red-950/70 border border-red-500/40 text-red-200 text-sm" data-testid="text-equipment-notice">
            {notice}
          </div>
        )}

        <div className="grid gap-4 md:grid-cols-2">
          {EQUIPMENT_SLOTS.map(slot => {
            const def = EQUIPMENT[slot];
            const level = levels[slot];
            const unlocked = wins >= def.unlockWins;
            const quote = quoteEquipmentUpgrade(slot, level, { force, diamonds });
            const color = tintOf(def.tint);
            const canBuy = unlocked && !quote.maxed && quote.affordable;

            return (
              <div
                key={slot}
                className={`rounded-xl border p-4 flex gap-4 ${unlocked ? "bg-zinc-900/80 border-white/10" : "bg-zinc-900/40 border-white/5"}`}
                data-testid={`card-equipment-${slot}`}
              >
                <EquipmentIcon slot={slot} color={color} dim={!unlocked} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className={`font-bold ${unlocked ? "text-white" : "text-white/40"}`}>{def.name}</span>
                    <span className="text-xs text-white/60" data-testid={`text-equipment-level-${slot}`}>
                      {unlocked ? `Lv ${level}` : ""}
                    </span>
                  </div>

                  {unlocked ? (
                    <>
                      <div className="mt-1 space-y-0.5">
                        {slotTotals(slot, level).map((line, i) => (
                          <div key={i} className="text-[11px] text-emerald-300/90">{line}</div>
                        ))}
                        {def.effects.map((line, i) => (
                          <div key={`p${i}`} className="text-[11px] text-white/40">{line}</div>
                        ))}
                      </div>

                      <div className="mt-3 flex items-center justify-between gap-3 flex-wrap">
                        <div className="text-xs">
                          {quote.maxed ? (
                            <span className="text-white/40">Fully upgraded</span>
                          ) : (
                            <>
                              <span className={force >= quote.force ? "text-yellow-400" : "text-red-400"}>
                                ⚡ {formatEquipmentCost(quote.force)}
                              </span>
                              {quote.diamonds > 0 && (
                                <span className={`ml-2 ${diamonds >= quote.diamonds ? "text-cyan-300" : "text-red-400"}`}>
                                  💎 {quote.diamonds}
                                </span>
                              )}
                            </>
                          )}
                        </div>
                        <button
                          onClick={() => buy(slot)}
                          disabled={!canBuy}
                          className={`px-4 py-1.5 rounded-lg text-sm font-bold border transition-colors ${
                            canBuy
                              ? "bg-yellow-500 hover:bg-yellow-400 text-black border-yellow-300"
                              : "bg-zinc-800 text-white/30 border-white/10 cursor-not-allowed"
                          }`}
                          data-testid={`button-equipment-buy-${slot}`}
                        >
                          {quote.maxed ? "Maxed" : `Upgrade to Lv ${quote.targetLevel}`}
                        </button>
                      </div>

                    </>
                  ) : (
                    <div className="mt-2 flex items-center gap-2 text-xs text-white/40" data-testid={`text-equipment-locked-${slot}`}>
                      <Lock className="w-3.5 h-3.5" />
                      Unlocks at {def.unlockWins} career {def.unlockWins === 1 ? "win" : "wins"}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {reveal && (
        <CrateRevealView
          crateId={reveal.crateId}
          itemIds={reveal.itemIds}
          onClose={() => setReveal(null)}
        />
      )}
    </div>
  );
}
