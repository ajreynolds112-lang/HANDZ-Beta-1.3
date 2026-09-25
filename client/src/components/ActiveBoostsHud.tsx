/**
 * Active boost HUD — one square icon per live item effect, with a hover
 * tooltip spelling out exactly what the boost is doing right now.
 *
 * Two grouping rules shape what the player sees:
 * - Tiers of a synergy family share one pool, so they share one icon with a
 *   combined ×N rather than sitting side by side pretending to be separate
 *   effects. That icon wears the highest rarity currently contributing.
 * - Keepsakes sort to the end, so they wrap into the bottom rows, and wear
 *   their gold outline instead of a rarity colour.
 *
 * Mounted anywhere a fighter's current buffs matter (career hub, gym).
 */
import { useEffect, useMemo, useState } from "react";
import type { CareerRosterState, Fighter } from "@shared/schema";
import { withSavedInventory } from "@/lib/itemInventory";
import {
  ITEM_RARITIES, RARITY_COLORS, loadItemsConfig, rarityBorderClass, rarityTextClass, rarityTextStyle,
  type ItemDefinition, type ItemRarity,
} from "@/game/itemsConfig";
import { describeActiveBoost, getActiveBoosts, type ActiveBoost } from "@/game/itemEffects";
import { getItemFamily } from "@/game/itemFamily";
import { ItemIcon } from "@/components/LockerView";

/** Gold used for keepsake outlines — matches the Locker's keepsake treatment. */
const KEEPSAKE_GOLD = "#fbbf24";

interface ActiveBoostsHudProps {
  fighter: Fighter | null | undefined;
  /**
   * Pre-resolved boosts, used instead of reading `fighter`'s locker. This is
   * how an AI opponent's Item Distribution kit — which has no save behind it —
   * renders through the same grouping and tooltips as the player's.
   */
  boosts?: ActiveBoost[];
  roster?: CareerRosterState | null;
  /** Extra classes for positioning inside the host screen. */
  className?: string;
  /** Icon edge length in px. */
  size?: number;
  /**
   * Where tooltips grow from. Use "left"/"right" when the HUD is pinned to that
   * edge of the screen — a centered tooltip would run off it.
   */
  tooltipAlign?: "center" | "left" | "right";
  /** Which way tooltips open. Use "bottom" when the row is pinned to the top of the screen. */
  tooltipSide?: "top" | "bottom";
  /**
   * Most icons on one line before the rest drop to a new line underneath. The
   * mid-fight HUD sits either side of the XP bar, so a long kit has to grow
   * downwards instead of running across the middle of the screen.
   */
  perRow?: number;
}

/** One icon in the HUD: a lone item, or a whole synergy family pooled together. */
interface BoostGroup {
  key: string;
  /** Family base name when pooled, otherwise the item's own name. */
  label: string;
  /** The member whose artwork and rarity the icon shows. */
  display: ItemDefinition;
  rarity: ItemRarity;
  keepsake: boolean;
  /** Combined stacks across every member. */
  stacks: number;
  members: ActiveBoost[];
}

const rarityRank = (r: ItemRarity): number => ITEM_RARITIES.indexOf(r);

/**
 * Pool synergy families into one entry each and push keepsakes to the end.
 *
 * Only families that both carry synergy and span more than one tier merge —
 * everything else keeps its own icon, so a single item never disappears into
 * a group of one with a different name on it.
 */
function groupBoosts(boosts: ActiveBoost[]): BoostGroup[] {
  const defs = loadItemsConfig();
  const byKey = new Map<string, BoostGroup>();
  const order: BoostGroup[] = [];

  for (const b of boosts) {
    const family = getItemFamily(b.def, defs);
    const pooled = family.synergy && family.tiered;
    const key = pooled ? family.key : `#${b.def.id}`;
    const existing = byKey.get(key);
    if (!existing) {
      const group: BoostGroup = {
        key,
        label: pooled ? family.baseName : b.def.name,
        display: b.def,
        rarity: b.def.rarity,
        keepsake: b.def.isKeepsake,
        stacks: b.stacks,
        members: [b],
      };
      byKey.set(key, group);
      order.push(group);
      continue;
    }
    existing.stacks += b.stacks;
    existing.members.push(b);
    existing.keepsake = existing.keepsake || b.def.isKeepsake;
    if (rarityRank(b.def.rarity) > rarityRank(existing.rarity)) {
      existing.display = b.def;
      existing.rarity = b.def.rarity;
    }
  }

  // Keepsakes last so the flex wrap drops them into the bottom rows.
  return [...order.filter(g => !g.keepsake), ...order.filter(g => g.keepsake)];
}

export default function ActiveBoostsHud({ fighter, roster, boosts: boostsOverride, className = "", size = 34, tooltipAlign = "center", tooltipSide = "top", perRow = 10 }: ActiveBoostsHudProps) {
  // AC boosts count down in real time, so re-resolve once a minute.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);
  const [hovered, setHovered] = useState<string | null>(null);

  // Armed boosts live in the save, not in the caller's snapshot: the Locker
  // arms straight into storage, and abandoning a session (pause-menu quit,
  // escrow restore, walking out of a workout) leaves them armed there without
  // touching the fighter object this screen was handed. Reading the snapshot
  // makes a boost the player still owns look spent until some unrelated write
  // refreshes the fighter. Re-resolving on mount shows it the instant the hub
  // appears; the `nowMs` tick doubles as a cheap self-heal for anything that
  // writes the save while the hub is already up.
  const live = useMemo(() => withSavedInventory(fighter), [fighter, nowMs]);

  const boosts: ActiveBoost[] = boostsOverride ?? getActiveBoosts(live, roster, nowMs);
  if (boosts.length === 0) return null;
  const groups = groupBoosts(boosts);
  // Split into lines of at most `perRow` so the row can never stretch into the
  // XP bar; the extras stack underneath it instead.
  const rows: BoostGroup[][] = [];
  const lineSize = Math.max(1, Math.round(perRow));
  for (let i = 0; i < groups.length; i += lineSize) rows.push(groups.slice(i, i + lineSize));
  const rowJustify = tooltipAlign === "right" ? "justify-end" : "justify-start";

  return (
    <div className={`flex flex-col gap-1.5 ${tooltipAlign === "right" ? "items-end" : "items-start"} ${className}`} data-testid="active-boosts">
      {rows.map((row, rowIdx) => (
        <div key={`row-${rowIdx}`} className={`flex flex-wrap items-center gap-1.5 ${rowJustify}`}>
          {row.map(g => {
        const outline = g.keepsake ? KEEPSAKE_GOLD : RARITY_COLORS[g.rarity];
        // GOAT's frame is an animated class, so it can't take an inline border.
        const goatFrame = !g.keepsake && g.rarity === "GOAT";
        return (
          <div key={g.key} className="relative">
            <div
              className={`rounded bg-black/60 flex items-center justify-center cursor-help ${goatFrame ? `border-2 ${rarityBorderClass(g.rarity)}` : ""}`}
              style={{
                width: size,
                height: size,
                ...(goatFrame ? {} : {
                  border: `${g.keepsake ? 2 : 1}px solid ${outline}`,
                  boxShadow: `0 0 ${g.keepsake ? 8 : 6}px ${outline}${g.keepsake ? "88" : "55"}`,
                }),
              }}
              onMouseEnter={() => setHovered(g.key)}
              onMouseLeave={() => setHovered(h => (h === g.key ? null : h))}
              data-testid={`active-boost-${g.display.id}`}
            >
              <ItemIcon def={g.display} size={Math.round(size * 0.8)} />
              {g.stacks > 1 && (
                <span className="absolute -bottom-1 -right-1 text-[9px] font-mono font-bold text-black bg-white/90 rounded px-0.5 leading-tight">
                  ×{g.stacks}
                </span>
              )}
            </div>
            {hovered === g.key && (
              <div
                className={`absolute z-[120] ${tooltipSide === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5"} w-56 bg-[#101016] border border-white/25 rounded px-2 py-1.5 shadow-xl pointer-events-none ${
                  tooltipAlign === "right" ? "right-0" : tooltipAlign === "left" ? "left-0" : "left-1/2 -translate-x-1/2"
                }`}
                data-testid={`active-boost-tip-${g.display.id}`}
              >
                <div
                  className={`text-[11px] font-bold ${g.keepsake ? "" : rarityTextClass(g.rarity)}`}
                  style={g.keepsake ? { color: outline } : rarityTextStyle(g.rarity)}
                >
                  {g.label}{g.stacks > 1 ? ` ×${g.stacks}` : ""}
                  {g.keepsake && <span className="text-amber-300"> · Keepsake</span>}
                </div>
                {g.members.length === 1 ? (
                  <div className="text-white/80 text-[10px] leading-snug mt-0.5">{describeActiveBoost(g.members[0], nowMs)}</div>
                ) : (
                  // Tiers of a family carry different values, so each one states its own.
                  g.members.map(m => (
                    <div key={m.def.id} className="text-white/80 text-[10px] leading-snug mt-0.5">
                      <span className={`font-bold ${rarityTextClass(m.def.rarity)}`} style={rarityTextStyle(m.def.rarity)}>{m.def.name}</span>
                      {m.stacks > 1 ? ` ×${m.stacks}` : ""} — {describeActiveBoost(m, nowMs)}
                    </div>
                  ))
                )}
              </div>
            )}
            </div>
          );
          })}
        </div>
      ))}
    </div>
  );
}
