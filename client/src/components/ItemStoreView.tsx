import { useEffect, useMemo, useRef, useState } from "react";
import type { Fighter } from "@shared/schema";
import { X, Zap, Lock } from "lucide-react";
import * as localSaves from "@/lib/localSaves";
import {
  careerBestRank, getInventory, purchaseStoreItem, quoteStorePrice, storeBlock, storeMaxQty,
  type StoreBlock, type StorePriceQuote,
} from "@/lib/itemInventory";
import {
  loadItemsConfig, storeCatalog, ITEM_RARITIES,
  rarityBorderClass, rarityBorderStyle, rarityTextClass, rarityTextStyle,
  type ItemDefinition,
} from "@/game/itemsConfig";
import { ItemIcon } from "@/components/LockerView";
import {
  DIAMOND_PACKS, diamondsPerDollar, formatUsd, startDiamondCheckout,
} from "@/game/diamondPacks";
import { useEnterKey, ENTER_PRIORITY } from "@/hooks/useEnterKey";

interface ItemStoreViewProps {
  fighterId: string;
  /** Career rank — lower is better. Null when the save hasn't been ranked yet. */
  playerRank: number | null;
  onClose: () => void;
  /** Fires after any purchase so the gym HUD can re-read the purse. */
  onChanged?: (fighter: Fighter) => void;
}

type StoreTab = "items" | "resources";

/** A row's buy button walks idle → pick a quantity → confirm that quantity. */
type BuyStage = "idle" | "qty" | "confirm";
interface BuyFlow {
  id: string;
  stage: Exclude<BuyStage, "idle">;
  qty: number;
}

const CATEGORY_BADGES: { key: keyof ItemDefinition; label: string }[] = [
  { key: "isBoost", label: "BOOST" },
  { key: "isConsumable", label: "CONSUMABLE" },
  { key: "isKeepsake", label: "KEEPSAKE" },
];

export default function ItemStoreView({ fighterId, playerRank, onClose, onChanged }: ItemStoreViewProps) {
  const [tab, setTab] = useState<StoreTab>("items");
  const [fighter, setFighter] = useState<Fighter | undefined>(() => localSaves.getFighter(fighterId));
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [search, setSearch] = useState("");
  // Only one row can be mid-purchase, so Enter and Escape can never answer a
  // prompt the player isn't looking at.
  const [flow, setFlow] = useState<BuyFlow | null>(null);
  const noticeTimer = useRef<number | null>(null);

  // One catalog snapshot for the life of the panel, so a price can't change
  // between the label the player read and the purchase they made.
  const shelf = useMemo(() => storeCatalog(loadItemsConfig()), []);
  const inv = useMemo(() => getInventory(fighter), [fighter]);
  // Rank unlocks are permanent, so the shelf is judged against the best rank
  // this career has ever held rather than wherever the player sits today.
  const bestRank = useMemo(() => careerBestRank(fighter, playerRank), [fighter, playerRank]);
  const force = fighter?.force ?? 0;
  const diamonds = fighter?.diamonds ?? 0;

  const say = (ok: boolean, text: string) => {
    if (noticeTimer.current) window.clearTimeout(noticeTimer.current);
    setNotice({ ok, text });
    noticeTimer.current = window.setTimeout(() => setNotice(null), 4000);
  };

  const buy = (def: ItemDefinition, qty: number) => {
    const res = purchaseStoreItem(fighterId, def.id, bestRank, qty);
    say(res.ok, res.message ?? (res.ok ? `Bought ${def.name}` : "Purchase failed"));
    setFlow(null);
    if (res.ok && res.fighter) {
      setFighter(res.fighter);
      onChanged?.(res.fighter);
    }
  };

  const flowDef = flow ? shelf.find(d => d.id === flow.id) ?? null : null;
  useEnterKey(
    () => { if (flow?.stage === "confirm" && flowDef) buy(flowDef, flow.qty); },
    { enabled: flow?.stage === "confirm", priority: ENTER_PRIORITY.milestone },
  );
  // Escape backs out of whichever step the flow is on. Enter is left to the
  // shared registry above so the focused YES button can't also answer it.
  useEffect(() => {
    if (!flow) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      setFlow(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [flow]);

  const buyDiamonds = async (packId: string) => {
    const res = await startDiamondCheckout(packId);
    if (res.ok && res.url) { window.location.href = res.url; return; }
    say(false, res.message ?? "Checkout unavailable.");
  };

  const query = search.trim().toLowerCase();
  const filtered = query === ""
    ? shelf
    : shelf.filter(d => `${d.name} ${d.rarity}`.toLowerCase().includes(query));

  const groups = ITEM_RARITIES
    .map(rarity => ({ rarity, items: filtered.filter(d => d.rarity === rarity) }))
    .filter(g => g.items.length > 0);

  const bestRate = Math.max(...DIAMOND_PACKS.map(diamondsPerDollar));

  return (
    <div className="fixed inset-0 z-[80] bg-black/85 flex items-center justify-center p-4" data-testid="item-store">
      <div className="bg-neutral-950 border border-white/15 rounded-lg w-full max-w-4xl max-h-[88vh] flex flex-col">

        <div className="flex items-center gap-3 px-4 py-3 border-b border-white/10">
          <h2 className="text-yellow-400 font-black italic uppercase text-lg tracking-wide">Store</h2>
          <div className="flex gap-1 ml-2">
            {([["items", "Items"], ["resources", "Resources"]] as const).map(([id, label]) => (
              <button
                key={id}
                onClick={() => setTab(id)}
                className={`px-3 py-1 rounded text-xs font-bold uppercase tracking-wide transition-colors ${
                  tab === id ? "bg-yellow-500 text-black" : "bg-white/5 text-white/60 hover:text-white"
                }`}
                data-testid={`tab-store-${id}`}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="flex items-center gap-1 text-yellow-400 font-mono font-bold text-sm" data-testid="store-force">
              <Zap className="w-3.5 h-3.5 fill-yellow-400" />{force.toLocaleString()}
            </span>
            <span className="flex items-center gap-1 text-cyan-300 font-mono font-bold text-sm" data-testid="store-diamonds">
              💎{diamonds.toLocaleString()}
            </span>
            <button onClick={onClose} className="text-white/50 hover:text-white" data-testid="button-close-store">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {notice && (
          <div
            className={`px-4 py-2 text-xs font-bold border-b ${
              notice.ok
                ? "bg-emerald-950/60 border-emerald-500/30 text-emerald-300"
                : "bg-red-950/60 border-red-500/30 text-red-300"
            }`}
            data-testid="store-notice"
          >
            {notice.text}
          </div>
        )}

        {tab === "items" && (
          <>
            <div className="px-4 pt-3">
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search the shelf…"
                className="w-full h-8 rounded bg-white/5 border border-white/10 px-2 text-xs text-white placeholder:text-white/30"
                data-testid="input-store-search"
              />
            </div>

            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
              {groups.length === 0 && (
                <p className="text-white/40 text-sm text-center py-10" data-testid="store-empty">
                  {shelf.length === 0
                    ? "Nothing is stocked yet."
                    : "No items match that search."}
                </p>
              )}

              {groups.map(group => (
                <div key={group.rarity}>
                  <h3
                    className={`text-xs font-black uppercase tracking-widest mb-2 ${rarityTextClass(group.rarity)}`}
                    style={rarityTextStyle(group.rarity)}
                  >
                    {group.rarity}
                  </h3>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {group.items.map(def => (
                      <StoreRow
                        key={def.id}
                        def={def}
                        owned={inv.owned[def.id] ?? 0}
                        block={storeBlock(def, inv, bestRank)}
                        quote={quoteStorePrice(def.storeCostForce, def.storeCostDiamonds, force, diamonds)}
                        force={force}
                        diamonds={diamonds}
                        stage={flow?.id === def.id ? flow.stage : "idle"}
                        qty={flow?.id === def.id ? flow.qty : 1}
                        maxQty={flow?.id === def.id ? storeMaxQty(def, inv, force, diamonds) : 0}
                        onStart={() => setFlow({ id: def.id, stage: "qty", qty: 1 })}
                        onPick={n => setFlow({ id: def.id, stage: "confirm", qty: n })}
                        onConfirm={() => buy(def, flow?.qty ?? 1)}
                        onCancel={() => setFlow(null)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {tab === "resources" && (
          <div className="flex-1 overflow-y-auto p-4">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {DIAMOND_PACKS.map(pack => {
                const best = diamondsPerDollar(pack) >= bestRate;
                return (
                  <button
                    key={pack.id}
                    onClick={() => void buyDiamonds(pack.id)}
                    className="relative flex flex-col items-center gap-1 rounded border border-cyan-500/25 bg-cyan-950/25 px-3 py-3 hover:border-cyan-400/70 hover:bg-cyan-900/30 transition-colors"
                    data-testid={`button-buy-${pack.id}`}
                  >
                    {best && (
                      <span className="absolute -top-2 right-2 bg-yellow-500 text-black text-[9px] font-black uppercase px-1.5 rounded">
                        Best value
                      </span>
                    )}
                    <span className="text-2xl leading-none">💎</span>
                    <span className="text-cyan-200 font-mono font-bold text-base">{pack.diamonds.toLocaleString()}</span>
                    <span className="text-white font-bold text-sm">{formatUsd(pack.cents)}</span>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-white/35 mt-3">Paid by credit or debit card.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function StoreRow({
  def, owned, block, quote, force, diamonds, stage, qty, maxQty, onStart, onPick, onConfirm, onCancel,
}: {
  def: ItemDefinition;
  owned: number;
  block: StoreBlock | null;
  quote: StorePriceQuote;
  force: number;
  diamonds: number;
  stage: BuyStage;
  qty: number;
  maxQty: number;
  onStart: () => void;
  onPick: (qty: number) => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const locked = block?.kind === "locked";
  const canBuy = !block && quote.affordable;
  const badges = CATEGORY_BADGES.filter(b => def[b.key] === true);
  // Diamonds cover the batch's shortfall in one go, so a bulk price is priced
  // as a batch rather than as the unit price times the count.
  const batch = quoteStorePrice(def.storeCostForce * qty, def.storeCostDiamonds * qty, force, diamonds);
  const paidBits: string[] = [];
  if (batch.force > 0) paidBits.push(`${batch.force.toLocaleString()} Force`);
  if (batch.diamonds > 0) paidBits.push(`💎${batch.diamonds.toLocaleString()}`);

  // A row the player has not earned yet drops its rarity colour for plain grey,
  // so the shelf reads as locked at a glance without a word of copy.
  return (
    <div
      className={`flex items-center gap-2.5 rounded border bg-white/[0.03] px-2.5 py-2 ${locked ? "border-white/15 opacity-60" : rarityBorderClass(def.rarity)}`}
      style={locked ? undefined : rarityBorderStyle(def.rarity)}
      data-testid={`store-item-${def.id}`}
    >
      <div className="shrink-0 w-11 h-11 flex items-center justify-center">
        <ItemIcon def={def} size={40} />
      </div>

      <div className="min-w-0 flex-1">
        <div className={`text-xs font-bold truncate ${rarityTextClass(def.rarity)}`} style={rarityTextStyle(def.rarity)}>
          {def.name}
        </div>
        <div className="flex items-center gap-1 flex-wrap mt-0.5">
          {badges.map(b => (
            <span key={b.label} className="text-[8px] font-bold text-white/40 border border-white/15 rounded px-1">
              {b.label}
            </span>
          ))}
          {owned > 0 && <span className="text-[9px] text-white/45 font-mono">owned ×{owned}</span>}
        </div>

        {locked ? (
          <div className="flex items-center gap-1 text-[10px] text-amber-400/90 mt-1" data-testid={`store-locked-${def.id}`}>
            <Lock className="w-2.5 h-2.5" />
            {block?.message}
          </div>
        ) : (
          <div className="flex items-center gap-1.5 mt-1">
            {def.storeCostForce > 0 && (
              <span className="flex items-center gap-0.5 text-yellow-400 font-mono text-[11px] font-bold">
                <Zap className="w-2.5 h-2.5 fill-yellow-400" />{def.storeCostForce.toLocaleString()}
              </span>
            )}
            {def.storeCostDiamonds > 0 && (
              <span className="text-cyan-300 font-mono text-[11px] font-bold" data-testid={`store-diamond-cost-${def.id}`}>
                💎{def.storeCostDiamonds.toLocaleString()}
              </span>
            )}
            {def.storeCostForce <= 0 && def.storeCostDiamonds <= 0 && (
              <span className="text-emerald-400 font-mono text-[11px] font-bold">Free</span>
            )}
          </div>
        )}
      </div>

      {stage === "idle" && (
        <button
          onClick={onStart}
          disabled={!canBuy}
          title={block?.message ?? (quote.affordable ? `Buy ${def.name}` : "Not enough Force or Diamonds")}
          className={`shrink-0 px-2.5 py-1 rounded text-[10px] font-black uppercase tracking-wide transition-colors ${
            canBuy
              ? "bg-yellow-500 text-black hover:bg-yellow-400"
              : "bg-white/5 text-white/30 cursor-not-allowed"
          }`}
          data-testid={`button-store-buy-${def.id}`}
        >
          {/* Only a refusal that really is about ownership reads as "Owned";
              anything else the shelf can still sell later, and the tooltip
              above carries the reason. */}
          {block?.kind === "owned" ? "Owned" : block && !locked ? "N/A" : "Buy"}
        </button>
      )}

      {stage === "qty" && (
        <div className="shrink-0 flex items-center gap-1" data-testid={`store-qty-${def.id}`}>
          {([["+1", 1, true], ["+10", 10, maxQty >= 10], ["+MAX", maxQty, maxQty >= 2]] as const).map(([label, n, on]) => (
            <button
              key={label}
              onClick={() => on && onPick(n)}
              disabled={!on}
              className={`px-2 py-1 rounded text-[10px] font-black uppercase tracking-wide transition-colors ${
                on ? "bg-yellow-500 text-black hover:bg-yellow-400" : "bg-white/5 text-white/25 cursor-not-allowed"
              }`}
              data-testid={`button-store-qty-${label === "+MAX" ? "max" : n}-${def.id}`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {stage === "confirm" && (
        <div className="shrink-0 flex items-center gap-1.5" data-testid={`store-confirm-${def.id}`}>
          <span className="text-[10px] font-bold text-white/85 text-right">
            Buy {qty.toLocaleString()} for {paidBits.length > 0 ? paidBits.join(" + ") : "free"}?
          </span>
          <button
            autoFocus
            onClick={onConfirm}
            className="px-2 py-1 rounded text-[10px] font-black uppercase tracking-wide bg-emerald-500 text-black hover:bg-emerald-400 transition-colors"
            data-testid={`button-store-yes-${def.id}`}
          >
            Yes
          </button>
          <button
            onClick={onCancel}
            className="px-2 py-1 rounded text-[10px] font-black uppercase tracking-wide bg-white/10 text-white/70 hover:bg-white/20 transition-colors"
            data-testid={`button-store-no-${def.id}`}
          >
            No
          </button>
        </div>
      )}
    </div>
  );
}

