import { useState } from "react";
import type { CareerRosterState, Fighter } from "@shared/schema";
import * as localSaves from "@/lib/localSaves";
import {
  getInventory, sellItem, useItem, isUsable,
} from "@/lib/itemInventory";
import {
  effectOf, isInstantGrant, isPermanentEffect,
  coachNotesPctFor, COACH_NOTES_STATS, COACH_NOTES_CAP,
} from "@/game/itemEffects";
import { getItemFamily } from "@/game/itemFamily";
import {
  loadItemsConfig, buildNewItem, ITEM_RARITIES, RARITY_COLORS, rarityBorderClass, rarityTextClass, rarityTextStyle,
  type ItemDefinition, type ItemRarity,
} from "@/game/itemsConfig";

interface LockerViewProps {
  fighterId: string;
  onClose: () => void;
  /** Called after any sale or use so the parent can refresh its fighter snapshot / HUD. */
  onChanged?: (fighter: Fighter) => void;
  /** Roster state, so week- and camp-scoped boosts can be pinned correctly. */
  roster?: CareerRosterState | null;
}

type RarityFilter = "All" | ItemRarity;

/** The item's isometric pixel-art icon, falling back to its emoji. */
export function ItemIcon({ def, size }: { def: ItemDefinition; size: number }) {
  const [failed, setFailed] = useState(false);
  if (!def.iconImage || failed) {
    return <span style={{ fontSize: Math.round(size * 0.72), lineHeight: 1 }}>{def.icon}</span>;
  }
  return (
    <img
      src={def.iconImage}
      alt={def.name}
      width={size}
      height={size}
      onError={() => setFailed(true)}
      style={{ imageRendering: "pixelated", width: size, height: size, objectFit: "contain" }}
      draggable={false}
    />
  );
}

const COACH_NOTES_LABELS: Record<string, string> = {
  power: "POW", speed: "SPD", defense: "DEF", stamina: "STA", focus: "FOC",
};

/**
 * Coach's Notes banks a permanent percentage on a random stat every camp sparring
 * session, so the item's own text can't say what it is worth right now. Show the
 * live per-stat total in the empty margin beside the rarity line.
 */
function CoachNotesBanked({ fighter }: { fighter: Fighter | undefined }) {
  return (
    <div className="flex items-center gap-1 flex-wrap" data-testid="locker-coach-notes">
      {COACH_NOTES_STATS.map(stat => {
        const key = stat as string;
        const pct = coachNotesPctFor(fighter, stat);
        const maxed = pct >= COACH_NOTES_CAP;
        return (
          <span
            key={key}
            className={`rounded px-1.5 py-px text-[10px] font-bold font-mono border ${
              maxed
                ? "border-amber-400/60 bg-amber-400/10 text-amber-200"
                : pct > 0
                  ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-200"
                  : "border-white/10 bg-white/5 text-white/35"
            }`}
            title={`${key} — ${maxed ? "capped at " : ""}+${pct.toFixed(2)}% banked`}
            data-testid={`locker-coach-notes-${key}`}
          >
            {COACH_NOTES_LABELS[key] ?? key} +{pct.toFixed(2)}%
          </span>
        );
      })}
    </div>
  );
}

/** "🔷 250 + ⚡ 10 + 💎 1" for whatever currencies the item actually pays out. */
function sellPayout(def: ItemDefinition): string {
  const parts: string[] = [];
  if (def.sellShards > 0) parts.push(`🔷 ${def.sellShards.toLocaleString()}`);
  if (def.sellForce > 0) parts.push(`⚡ ${def.sellForce.toLocaleString()}`);
  if (def.sellDiamonds > 0) parts.push(`💎 ${def.sellDiamonds.toLocaleString()}`);
  return parts.length > 0 ? parts.join(" + ") : "nothing";
}

export default function LockerView({ fighterId, onClose, onChanged, roster }: LockerViewProps) {
  // Always read the persisted save — in-memory snapshots can be stale on slot load.
  const [fighter, setFighter] = useState<Fighter | undefined>(() => localSaves.getFighter(fighterId));
  const [filter, setFilter] = useState<RarityFilter>("All");
  const [selected, setSelected] = useState<string | null>(null);
  const [confirmSell, setConfirmSell] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Set while the player is choosing a refinement category for Sparta's Trophy. */
  /** Set while the player is confirming that a new AC boost replaces the live one. */
  const [acPrompt, setAcPrompt] = useState<{ itemId: string; currentName: string } | null>(null);
  /**
   * Items that were unseen when this visit started, snapshotted once so selling or
   * using something mid-visit can't drop the badges. The ids themselves are cleared
   * by the gym when the Locker closes, so the next visit shows no green bubbles.
   */
  const [newItemIds] = useState<Set<string>>(
    () => new Set(getInventory(localSaves.getFighter(fighterId)).unseenItemIds ?? []),
  );

  const inv = getInventory(fighter);
  const defs = loadItemsConfig();
  const shards = fighter?.shards ?? 0;

  /**
   * Copies whose catalog entry is gone (an item deleted or renamed in the Items
   * editor, or a catalog rolled back by an import) are still owned by the save,
   * so they get a placeholder tile instead of silently vanishing from the
   * locker. They can't be used or sold — restoring the catalog entry brings the
   * real item straight back.
   */
  const orphanDefs: ItemDefinition[] = Object.keys(inv.owned)
    .filter(id => (inv.owned[id] ?? 0) > 0 && !defs.some(d => d.id === id))
    .map(id => ({ ...buildNewItem(), id, name: id, icon: "❔", obtainableLimit: 9999 }));
  const ownedDefs = [...defs.filter(d => (inv.owned[d.id] ?? 0) > 0), ...orphanDefs];
  const visible = ownedDefs.filter(d => filter === "All" || d.rarity === filter);
  const keepsakes = visible.filter(d => d.isKeepsake);
  const consumables = visible.filter(d => d.isConsumable);
  const others = visible.filter(d => !d.isKeepsake && !d.isConsumable);
  const selectedDef = selected ? defs.find(d => d.id === selected) ?? null : null;
  // Synergy is pooled across the item's tier ladder, so show the family verdict.
  const selectedFamily = selectedDef ? getItemFamily(selectedDef, defs) : null;

  const applyResult = (itemId: string, res: ReturnType<typeof sellItem>) => {
    if (res.fighter) {
      setFighter(res.fighter);
      onChanged?.(res.fighter);
    }
    if (res.message) {
      setNotice(res.message);
      setTimeout(() => setNotice(null), 2500);
    }
    const fresh = res.fighter ? getInventory(res.fighter) : inv;
    if ((fresh.owned[itemId] ?? 0) <= 0) setSelected(null);
  };

  const doSell = () => {
    if (!selectedDef) return;
    setConfirmSell(false);
    applyResult(selectedDef.id, sellItem(fighterId, selectedDef.id, 1));
  };

  const doUse = (
    itemId: string,
    extra: { confirmReplaceAc?: boolean } = {},
  ) => {
    const res = useItem(fighterId, itemId, { roster, ...extra });
    // The storage layer signals "an AC boost is already running" rather than
    // silently overwriting it — surface the confirmation here.
    const replacing = !res.ok && res.message?.startsWith("REPLACE_AC:");
    if (replacing) {
      setAcPrompt({ itemId, currentName: res.message!.slice("REPLACE_AC:".length) });
      return;
    }
    setAcPrompt(null);
    applyResult(itemId, res);
  };

  const onUseClick = () => {
    if (!selectedDef) return;
    setConfirmSell(false);
    doUse(selectedDef.id);
  };

  const ItemGrid = ({ list, testId }: { list: ItemDefinition[]; testId: string }) => (
    <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(64px, 1fr))" }} data-testid={testId}>
      {list.map(d => {
        const qty = inv.owned[d.id] ?? 0;
        const active = inv.activeBoosts[d.id] ?? 0;
        const isSel = selected === d.id;
        // Keepsakes are permanent one-of-a-kind gifts — they always wear a gold frame.
        const gold = d.isKeepsake;
        // A selected GOAT wears the animated starfield frame, which drives its
        // own border and glow — an inline rarity outline would fight it.
        const goatSel = isSel && !gold && d.rarity === "GOAT";
        return (
          <button
            key={d.id}
            className={`relative aspect-square rounded-md flex items-center justify-center text-2xl transition-colors ${
              gold
                ? `border-2 border-amber-400 ${isSel ? "bg-amber-400/20" : "bg-amber-400/5 hover:bg-amber-400/15"}`
                : goatSel
                  ? `border-2 ${rarityBorderClass(d.rarity)}`
                  : `border ${isSel ? "border-yellow-400 bg-yellow-400/10" : "border-white/15 bg-white/5 hover:bg-white/10"}`
            }`}
            style={goatSel ? undefined : {
              boxShadow: `${gold ? "0 0 8px rgba(251,191,36,0.5), " : ""}inset 0 0 0 2px ${isSel ? RARITY_COLORS[d.rarity] : "transparent"}`,
            }}
            title={`${d.name} — ${d.rarity}${effectOf(d) ? `\n${effectOf(d)!.text}` : ""}`}
            onClick={() => { setSelected(isSel ? null : d.id); setConfirmSell(false); setAcPrompt(null); }}
            data-testid={`locker-item-${d.id}`}
          >
            <ItemIcon def={d} size={44} />
            {qty > 1 && (
              <span className="absolute bottom-0.5 right-1 text-[10px] font-bold text-white/90 font-mono">×{qty}</span>
            )}
            {/* New this visit — green bubble in the top-left corner. */}
            {newItemIds.has(d.id) && (
              <span className="absolute top-0.5 left-0.5 flex h-2.5 w-2.5" data-testid={`locker-item-new-${d.id}`}>
                <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75 animate-ping" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-emerald-400 border border-emerald-200 shadow-[0_0_6px_rgba(52,211,153,0.9)]" />
              </span>
            )}
            {active > 0 && (
              <span className="absolute bottom-0.5 left-1 text-[9px] font-bold text-green-300">●{active > 1 ? active : ""}</span>
            )}
          </button>
        );
      })}
    </div>
  );

  const Section = ({ title, list, testId }: { title: string; list: ItemDefinition[]; testId: string }) => (
    <div>
      <div className="text-white/70 text-[11px] font-bold uppercase tracking-wider mb-1.5">{title}</div>
      {list.length === 0
        ? <div className="text-white/30 text-xs italic py-2">Nothing here yet.</div>
        : <ItemGrid list={list} testId={testId} />}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center" onClick={onClose} data-testid="locker-overlay">
      <div
        className="relative bg-[#16161c] border border-white/20 rounded-lg shadow-2xl w-[min(92vw,720px)] h-[min(92vh,860px)] flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
        data-testid="locker-popup"
      >
        {/* Header */}
        <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-white/10">
          <div className="text-white font-black italic uppercase text-lg" data-testid="locker-title">🔒 Locker</div>
          <div className="flex items-center gap-1.5 bg-black/50 border border-white/10 rounded px-2 py-1 ml-2">
            <span className="text-sm leading-none">🔷</span>
            <span className="text-sky-300 font-bold text-sm font-mono" data-testid="locker-shards">{shards.toLocaleString()}</span>
            <span className="text-white/40 text-[10px] font-bold">SHARDS</span>
          </div>
          <div className="flex-1" />
          <div className="flex items-center gap-1.5">
            <span className="text-white/50 text-[11px] font-bold">View:</span>
            <select
              className="bg-black/60 border border-white/15 rounded text-xs text-white px-2 py-1"
              value={filter}
              onChange={e => setFilter(e.target.value as RarityFilter)}
              data-testid="locker-rarity-filter"
            >
              <option value="All">All</option>
              {ITEM_RARITIES.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <button className="text-white/60 hover:text-white text-xl font-bold px-1" onClick={onClose} data-testid="locker-close">✕</button>
        </div>

        {/* Floating toast — absolutely positioned so it never reflows the grid. */}
        {notice && (
          <div className="pointer-events-none absolute top-14 left-1/2 -translate-x-1/2 z-10 max-w-[90%] animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="bg-sky-950/95 border border-sky-500/50 rounded px-3 py-1.5 shadow-lg shadow-black/50">
              <span className="text-sky-200 text-xs font-bold whitespace-nowrap overflow-hidden text-ellipsis block" data-testid="locker-notice">{notice}</span>
            </div>
          </div>
        )}

        {/* Scrollable grid — min-h-0 so a full locker (or a tall detail footer)
            scrolls inside the popup instead of pushing rows out of reach. */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain scroll-slim px-4 py-3 space-y-4" data-testid="locker-grid">
          {ownedDefs.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <p className="text-white/40 text-sm text-center" data-testid="locker-empty">
                Your locker is empty.<br />Items you earn will show up here.
              </p>
            </div>
          ) : (
            <>
              <Section title="Consumables" list={consumables} testId="locker-consumables" />
              {others.length > 0 && <Section title="Other" list={others} testId="locker-others" />}
              {/* Keepsakes always sit at the bottom of the locker. */}
              <Section title="Keepsakes" list={keepsakes} testId="locker-keepsakes" />
            </>
          )}
        </div>

        {/* Selected item footer */}
        {selectedDef && (
          <div
            className="shrink-0 max-h-[45%] overflow-y-auto scroll-slim border-t border-white/10 px-4 py-3 flex items-center gap-3 flex-wrap"
            data-testid="locker-detail"
          >
            <ItemIcon def={selectedDef} size={40} />
            <div className="flex-1 min-w-0">
              <div className="text-white text-sm font-bold truncate">{selectedDef.name}</div>
              <div className="flex items-center gap-2 flex-wrap">
                <div className={`text-[11px] ${rarityTextClass(selectedDef.rarity)}`} style={rarityTextStyle(selectedDef.rarity)}>
                  {selectedDef.rarity}
                  {selectedDef.isKeepsake ? " · Keepsake" : selectedDef.isConsumable ? " · Consumable" : ""}
                  {selectedDef.isBoost ? " · Boost" : ""}
                  {selectedFamily?.synergy
                    ? ` · Synergy ×${selectedFamily.stackCount}${selectedFamily.tiered ? ` (all ${selectedFamily.baseName} tiers share it)` : ""}`
                    : ""}
                </div>
                {effectOf(selectedDef)?.coachNotesPerSparring ? <CoachNotesBanked fighter={fighter} /> : null}
              </div>
              {effectOf(selectedDef) && (
                <div className="text-white font-bold text-[11px] mt-0.5" data-testid="locker-effect">
                  {effectOf(selectedDef)!.text}
                  {isPermanentEffect(selectedDef) && <span className="text-emerald-300 font-bold"> · Always on</span>}
                </div>
              )}
            </div>
            {isUsable(selectedDef) && (
              <button
                className="rounded px-3 py-1.5 text-xs font-bold text-black bg-emerald-400 hover:bg-emerald-300"
                onClick={onUseClick}
                data-testid="locker-use"
              >{isInstantGrant(selectedDef) ? "Use" : "Activate"}</button>
            )}
            {!selectedDef.sellable ? (
              <span className="text-white/40 text-xs font-bold" data-testid="locker-sell-disabled">Not sellable</span>
            ) : confirmSell ? (
              <div className="flex items-center gap-2">
                <span className="text-sky-300 text-xs font-bold" data-testid="locker-sell-confirm-text">Sell 1 for {sellPayout(selectedDef)}?</span>
                <button className="rounded px-2.5 py-1.5 text-xs font-bold text-black bg-sky-400 hover:bg-sky-300" onClick={doSell} data-testid="locker-sell-confirm">Confirm</button>
                <button className="rounded px-2.5 py-1.5 text-xs font-bold text-white/70 bg-white/10 hover:bg-white/20" onClick={() => setConfirmSell(false)} data-testid="locker-sell-cancel">Cancel</button>
              </div>
            ) : (
              <button
                className="rounded px-3 py-1.5 text-xs font-bold text-black bg-sky-400 hover:bg-sky-300"
                onClick={() => setConfirmSell(true)}
                data-testid="locker-sell"
              >Sell — {sellPayout(selectedDef)}</button>
            )}

            {/* AC boosts share one slot — confirm before the live one is replaced. */}
            {acPrompt?.itemId === selectedDef.id && (
              <div className="w-full mt-2 bg-black/50 border border-sky-500/40 rounded p-2 flex items-center gap-2" data-testid="locker-ac-prompt">
                <span className="text-sky-200 text-[11px] font-bold flex-1">
                  {acPrompt.currentName} is already running. Using {selectedDef.name} replaces it and restarts the 24-hour timer.
                </span>
                <button className="rounded px-2.5 py-1.5 text-xs font-bold text-black bg-sky-400 hover:bg-sky-300" onClick={() => doUse(selectedDef.id, { confirmReplaceAc: true })} data-testid="locker-ac-confirm">Replace</button>
                <button className="rounded px-2.5 py-1.5 text-xs font-bold text-white/70 bg-white/10 hover:bg-white/20" onClick={() => setAcPrompt(null)} data-testid="locker-ac-cancel">Cancel</button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
