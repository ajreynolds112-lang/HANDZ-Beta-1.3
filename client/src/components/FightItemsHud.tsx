/**
 * Mid-fight item row — the boosts each corner is actually fighting with,
 * pinned to the top of the canvas (never the black letterbox margins, since
 * the host box tracks the canvas): the player's kit on the left, the AI
 * opponent's Item Distribution kit on the right. Each side is capped at 40%
 * so neither row reaches the XP panel centred between them.
 *
 * Toggled by "Item Icons in Fights" in the Fight Planner's settings gear.
 */
import type { CareerRosterState, Fighter } from "@shared/schema";
import ActiveBoostsHud from "@/components/ActiveBoostsHud";
import { boostsFromItemCounts } from "@/game/itemEffects";

interface FightItemsHudProps {
  fighter: Fighter | null | undefined;
  roster?: CareerRosterState | null;
  /** Item-id → stacks the AI walked in with, straight off the fight state. */
  opponentItems?: Record<string, number> | null;
}

export default function FightItemsHud({ fighter, roster, opponentItems }: FightItemsHudProps) {
  const oppBoosts = boostsFromItemCounts(opponentItems);
  return (
    // The row itself is click-through so it never steals a canvas click; only
    // the icon groups take the pointer, for their tooltips.
    <div
      className="absolute top-2 left-3 right-3 z-[52] flex items-start justify-between gap-4 pointer-events-none"
      data-testid="fight-items-hud"
    >
      <div className="pointer-events-auto max-w-[40%]">
        <ActiveBoostsHud
          fighter={fighter}
          roster={roster}
          size={26}
          tooltipAlign="left"
          tooltipSide="bottom"
        />
      </div>
      <div className="pointer-events-auto max-w-[40%] flex justify-end">
        {oppBoosts.length > 0 && (
          <ActiveBoostsHud
            fighter={null}
            boosts={oppBoosts}
            size={26}
            tooltipAlign="right"
            tooltipSide="bottom"
            className="justify-end"
          />
        )}
      </div>
    </div>
  );
}
