import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ArrowLeft, Save, Plus, Trash2, Search, X } from "lucide-react";
import {
  loadItemsConfig, saveItemsConfig, buildNewItem, isForceBundleId,
  ITEM_RARITIES, rarityTextClass, rarityTextStyle, CONSUMABLE_LIMIT, MAX_SYNERGY_STACK, MAX_SELL_AMOUNT,
  MAX_STORE_COST, ITEM_SOURCES, allSourcesAllowed,
  type ItemDefinition, type ItemRarity,
} from "@/game/itemsConfig";
import { ITEM_EFFECTS } from "@/game/itemEffects";
import { familySynergyPatch, getItemFamily } from "@/game/itemFamily";
import DailyRewardTab from "@/components/DailyRewardTab";

const EFFECT_IDS = Object.keys(ITEM_EFFECTS).sort();

/** The catalog and the daily-chest odds share this page. */
type ItemsTab = "catalog" | "reward";
const TABS: { id: ItemsTab; label: string }[] = [
  { id: "catalog", label: "Catalog" },
  { id: "reward", label: "Reward Rarity" },
];

interface ItemsEditorViewProps {
  onBack: () => void;
}

const SELL_LABELS = {
  sellShards: "Shards",
  sellForce: "Force",
  sellDiamonds: "Diamonds",
} as const;

export default function ItemsEditorView({ onBack }: ItemsEditorViewProps) {
  const [tab, setTab] = useState<ItemsTab>("catalog");
  const [items, setItems] = useState<ItemDefinition[]>(() => loadItemsConfig());
  const [savedNotice, setSavedNotice] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  // Search matches name, rarity, effect id and the category words (boost / consumable / keepsake).
  const query = search.trim().toLowerCase();
  const visibleItems = query === ""
    ? items
    : items.filter(it => {
        const haystack = [
          it.name,
          it.rarity,
          it.effectId ?? "",
          it.isBoost ? "boost" : "",
          it.isConsumable ? "consumable" : "",
          it.isKeepsake ? "keepsake" : "",
          it.sellable ? "sellable" : "",
          it.storeVisible ? "store" : "",
        ].join(" ").toLowerCase();
        return haystack.includes(query);
      });

  const persist = (next: ItemDefinition[]) => {
    setItems(next);
    saveItemsConfig(next);
    setSavedNotice(true);
    setTimeout(() => setSavedNotice(false), 1500);
  };

  const update = (id: string, patch: Partial<ItemDefinition>) => {
    persist(items.map(it => (it.id === id ? { ...it, ...patch } : it)));
  };

  /**
   * Synergy is a family-wide rule — the stack pool is shared by every tier of
   * an item, so editing one tier writes the same flag and ceiling to all of
   * them. Editing them apart would leave a ladder the game can't honour.
   */
  const updateSynergy = (
    it: ItemDefinition,
    patch: { synergy?: boolean; synergyStackCount?: number; synergyAdditive?: boolean },
  ) => {
    persist(familySynergyPatch(items, it, patch));
  };

  /** Family resolved against the in-editor list so labels track unsaved edits. */
  const familyOf = (it: ItemDefinition) => getItemFamily(it, items);

  const setConsumable = (it: ItemDefinition, checked: boolean) => {
    if (checked) {
      // Consumable ↔ Keepsake are mutually exclusive; consumables lock the limit to 9999.
      update(it.id, { isConsumable: true, isKeepsake: false, obtainableLimit: CONSUMABLE_LIMIT });
    } else {
      update(it.id, { isConsumable: false, obtainableLimit: 1 });
    }
  };

  const setKeepsake = (it: ItemDefinition, checked: boolean) => {
    if (checked) {
      // Keepsakes are never sellable — flipping the flag clears any sell setup.
      update(it.id, { isKeepsake: true, isConsumable: false, obtainableLimit: 1, sellable: false });
    } else {
      update(it.id, { isKeepsake: false });
    }
  };

  const CheckRow = ({ label, checked, onChange, testId, disabled, title }: {
    label: string; checked: boolean; onChange: (v: boolean) => void; testId: string;
    disabled?: boolean; title?: string;
  }) => (
    <label
      className={`flex items-center gap-1.5 text-xs select-none ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
      title={title}
    >
      <input
        type="checkbox" checked={checked} disabled={disabled}
        onChange={e => onChange(e.target.checked)} data-testid={testId}
      />
      {label}
    </label>
  );

  return (
    <div className={`flex flex-col items-center gap-3 p-4 mx-auto ${tab === "catalog" ? "max-w-3xl" : "max-w-5xl"}`}>
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-items-editor">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <h2 className="text-xl font-bold">Items</h2>
          <p className="text-xs text-muted-foreground">
            {tab === "catalog"
              ? "Define every item in the game — Boost / Consumable / Keepsake, rarity & rarity %, limits, synergy & sell values"
              : "Daily reward chests by rank — which crates they roll and how many the day pays out"}
          </p>
        </div>
        {tab === "catalog" && (
          <Button size="sm" className="gap-1" onClick={() => persist([...items, buildNewItem()])} data-testid="button-add-item">
            <Plus className="w-4 h-4" /> Add Item
          </Button>
        )}
      </div>

      <div className="w-full flex gap-1 border-b border-border">
        {TABS.map(t => (
          <button
            key={t.id}
            type="button"
            className={`px-3 py-1.5 text-xs font-semibold border-b-2 -mb-px transition-colors ${
              tab === t.id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
            onClick={() => setTab(t.id)}
            data-testid={`tab-items-${t.id}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "reward" ? <DailyRewardTab /> : (
      <>
      {/* Floats over the page so a save never reflows what you're editing. */}
      {savedNotice && (
        <div
          className="fixed bottom-4 right-4 z-[90] bg-green-950 border border-green-600 rounded-md px-3 py-1.5 shadow-lg pointer-events-none"
          data-testid="items-saved-notice"
        >
          <p className="text-xs text-green-300 font-semibold flex items-center gap-1"><Save className="w-3 h-3" /> Saved</p>
        </div>
      )}

      <div className="w-full flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <Input
            className="h-8 text-xs pl-8 pr-8"
            value={search}
            placeholder="Search items by name, rarity, effect or category…"
            onChange={e => setSearch(e.target.value)}
            data-testid="input-items-search"
          />
          {search !== "" && (
            <button
              type="button"
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setSearch("")}
              title="Clear search"
              data-testid="button-clear-items-search"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <span className="text-[10px] text-muted-foreground whitespace-nowrap" data-testid="text-items-count">
          {query === "" ? `${items.length} items` : `${visibleItems.length} of ${items.length}`}
        </span>
      </div>

      {items.length === 0 && (
        <Card className="p-6 w-full text-center">
          <p className="text-sm text-muted-foreground" data-testid="text-no-items">No items defined yet. Click "Add Item" to create the first one.</p>
        </Card>
      )}

      {items.length > 0 && visibleItems.length === 0 && (
        <Card className="p-6 w-full text-center">
          <p className="text-sm text-muted-foreground" data-testid="text-no-items-match">No items match "{search.trim()}".</p>
        </Card>
      )}

      <div className="w-full flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: "calc(100vh - 160px)" }} data-testid="items-editor-list">
        {visibleItems.map(it => (
          <Card key={it.id} className="p-3 w-full" data-testid={`item-card-${it.id}`}>
            <div className="flex items-center gap-2 mb-2">
              <Input
                className="h-8 text-xs w-14 text-center"
                value={it.icon}
                onChange={e => update(it.id, { icon: e.target.value.slice(0, 4) })}
                title="Icon (emoji)"
                data-testid={`input-item-icon-${it.id}`}
              />
              <Input
                className="h-8 text-xs flex-1"
                value={it.name}
                onChange={e => update(it.id, { name: e.target.value })}
                placeholder="Item name"
                data-testid={`input-item-name-${it.id}`}
              />
              <select
                className={`h-8 text-xs rounded-md border bg-background px-2 ${rarityTextClass(it.rarity)}`}
                value={it.rarity}
                style={rarityTextStyle(it.rarity)}
                onChange={e => update(it.id, { rarity: e.target.value as ItemRarity })}
                data-testid={`select-item-rarity-${it.id}`}
              >
                {ITEM_RARITIES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              {deleteConfirm === it.id ? (
                <div className="flex gap-1">
                  <Button variant="destructive" size="sm" className="h-8 text-xs" onClick={() => { setDeleteConfirm(null); persist(items.filter(x => x.id !== it.id)); }} data-testid={`button-item-delete-confirm-${it.id}`}>Delete</Button>
                  <Button variant="secondary" size="sm" className="h-8 text-xs" onClick={() => setDeleteConfirm(null)} data-testid={`button-item-delete-cancel-${it.id}`}>Keep</Button>
                </div>
              ) : (
                <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground" onClick={() => setDeleteConfirm(it.id)} data-testid={`button-item-delete-${it.id}`}>
                  <Trash2 className="w-4 h-4" />
                </Button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <CheckRow label="Boost Item" checked={it.isBoost} onChange={v => update(it.id, { isBoost: v })} testId={`check-item-boost-${it.id}`} />
              <CheckRow label="Consumable" checked={it.isConsumable} onChange={v => setConsumable(it, v)} testId={`check-item-consumable-${it.id}`} />
              <CheckRow label="Keepsake" checked={it.isKeepsake} onChange={v => setKeepsake(it, v)} testId={`check-item-keepsake-${it.id}`} />

              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Obtain limit</span>
                <Input
                  type="number" min={1}
                  className="h-7 text-xs w-20"
                  value={it.obtainableLimit}
                  disabled={it.isConsumable}
                  title={it.isConsumable ? "Consumables are fixed at 9999" : "Lifetime obtainable copies"}
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    if (!isNaN(v)) update(it.id, { obtainableLimit: Math.max(1, v) });
                  }}
                  data-testid={`input-item-limit-${it.id}`}
                />
              </div>

              {/* Synergy reads and writes the whole family, so a mixed legacy
                  config shows the rule the game actually applies. */}
              <CheckRow
                label="Synergy Item"
                checked={familyOf(it).synergy}
                onChange={v => updateSynergy(it, { synergy: v })}
                testId={`check-item-synergy-${it.id}`}
                title={familyOf(it).tiered
                  ? `Applies to every ${familyOf(it).baseName} tier — they share one stack pool`
                  : undefined}
              />
              {familyOf(it).synergy && (
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Stacks (max 9999)</span>
                  <Input
                    type="number" min={1} max={MAX_SYNERGY_STACK}
                    className="h-7 text-xs w-20"
                    value={familyOf(it).stackCount}
                    onChange={e => {
                      const v = parseInt(e.target.value, 10);
                      if (!isNaN(v)) updateSynergy(it, { synergyStackCount: Math.max(1, Math.min(MAX_SYNERGY_STACK, v)) });
                    }}
                    data-testid={`input-item-stacks-${it.id}`}
                  />
                  {familyOf(it).tiered && (
                    <span
                      className="text-[10px] text-emerald-300/80"
                      title={`Shared with all ${familyOf(it).memberIds.length} ${familyOf(it).baseName} tiers`}
                      data-testid={`text-item-synergy-family-${it.id}`}
                    >shared across all {familyOf(it).baseName} tiers</span>
                  )}
                  {/* Additive turns m^n into m×n — two copies of a 5× item pay
                      10×, not 25×. Family-wide, like the rest of synergy. */}
                  <CheckRow
                    label="Additive"
                    checked={familyOf(it).additive}
                    onChange={v => updateSynergy(it, { synergyAdditive: v })}
                    testId={`check-item-additive-${it.id}`}
                    title="Stacks add instead of compounding — two copies of a 5× item give 10× total, not 25×"
                  />
                </div>
              )}

              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Rarity %</span>
                <Input
                  type="number" min={0} max={100}
                  className="h-7 text-xs w-20"
                  value={it.rarityPercent}
                  title="Drop chance weighting used by reward draws (0–100%)"
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) update(it.id, { rarityPercent: Math.max(0, Math.min(100, v)) });
                  }}
                  data-testid={`input-item-rarity-percent-${it.id}`}
                />
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 w-full border-t border-white/10 pt-2">
                <CheckRow
                  label="Sellable"
                  checked={it.sellable && !it.isKeepsake}
                  disabled={it.isKeepsake}
                  title={it.isKeepsake ? "Keepsakes can't be sold" : "Allow this item to be sold from the Locker"}
                  onChange={v => update(it.id, { sellable: v })}
                  testId={`check-item-sellable-${it.id}`}
                />
                {(["sellShards", "sellForce", "sellDiamonds"] as const).map(field => (
                  <div key={field} className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground">{SELL_LABELS[field]}</span>
                    <Input
                      type="number" min={0} max={MAX_SELL_AMOUNT}
                      className="h-7 text-xs w-28"
                      value={it[field]}
                      disabled={!it.sellable || it.isKeepsake}
                      title={it.isKeepsake
                        ? "Keepsakes can't be sold"
                        : it.sellable ? `Sell payout in ${SELL_LABELS[field]}` : "Enable Sellable to set sell amounts"}
                      onChange={e => {
                        const v = parseInt(e.target.value, 10);
                        if (!isNaN(v)) update(it.id, { [field]: Math.max(0, Math.min(MAX_SELL_AMOUNT, v)) } as Partial<ItemDefinition>);
                      }}
                      data-testid={`input-item-${field.toLowerCase()}-${it.id}`}
                    />
                  </div>
                ))}
              </div>

              {/* Store shelf — price, rank gate and whether it is listed at all.
                  Force Bundles pay out Force, so they are never sellable for it. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 w-full border-t border-white/10 pt-2">
                {isForceBundleId(it.id) ? (
                  <span className="text-[10px] text-muted-foreground" data-testid={`text-item-store-excluded-${it.id}`}>
                    Force Bundles are never sold in the store.
                  </span>
                ) : (
                  <>
                    <CheckRow
                      label="In Store"
                      checked={it.storeVisible}
                      title="List this item on the gym store's shelf"
                      onChange={v => update(it.id, { storeVisible: v })}
                      testId={`check-item-store-${it.id}`}
                    />
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">Cost (Force)</span>
                      <Input
                        type="number" min={0} max={MAX_STORE_COST}
                        className="h-7 text-xs w-28"
                        value={it.storeCostForce}
                        disabled={!it.storeVisible}
                        title={it.storeVisible
                          ? "Store price in Force. A player short on Force pays the rest in Diamonds, on a sliding scale that starts at 1 Diamond for 2,500 Force."
                          : "Enable In Store to set a price"}
                        onChange={e => {
                          const v = parseInt(e.target.value, 10);
                          if (!isNaN(v)) update(it.id, { storeCostForce: Math.max(0, Math.min(MAX_STORE_COST, v)) });
                        }}
                        data-testid={`input-item-store-cost-${it.id}`}
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">Cost (Diamonds)</span>
                      <Input
                        type="number" min={0} max={MAX_STORE_COST}
                        className="h-7 text-xs w-24"
                        value={it.storeCostDiamonds}
                        disabled={!it.storeVisible}
                        title={it.storeVisible
                          ? "Diamonds charged on top of the Force price. Either price may be 0."
                          : "Enable In Store to set a price"}
                        onChange={e => {
                          const v = parseInt(e.target.value, 10);
                          if (!isNaN(v)) update(it.id, { storeCostDiamonds: Math.max(0, Math.min(MAX_STORE_COST, v)) });
                        }}
                        data-testid={`input-item-store-diamonds-${it.id}`}
                      />
                    </div>
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] text-muted-foreground">Rank unlock (blank = any)</span>
                      <Input
                        type="number" min={1}
                        className="h-7 text-xs w-20"
                        value={it.storeRankUnlock ?? ""}
                        placeholder="any"
                        disabled={!it.storeVisible}
                        title="Locked until the player reaches this rank or better. Lower is better, so 50 opens at rank #50."
                        onChange={e => {
                          const v = parseInt(e.target.value, 10);
                          update(it.id, { storeRankUnlock: isNaN(v) ? null : Math.max(1, v) });
                        }}
                        data-testid={`input-item-store-rank-${it.id}`}
                      />
                    </div>
                  </>
                )}
              </div>

              {/* Which reward paths may hand this item over. Unchecking one drops
                  the item out of that draw entirely rather than re-rolling it. */}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 w-full border-t border-white/10 pt-2">
                <span className="text-[10px] font-bold uppercase tracking-wide text-muted-foreground">Obtainable from</span>
                {ITEM_SOURCES.map(src => (
                  <CheckRow
                    key={src.key}
                    label={src.label}
                    checked={it.sourceAllowed?.[src.key] !== false}
                    title={src.hint}
                    onChange={v => update(it.id, { sourceAllowed: { ...allSourcesAllowed(), ...it.sourceAllowed, [src.key]: v } })}
                    testId={`check-item-source-${src.key}-${it.id}`}
                  />
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                <span className="text-[10px] text-muted-foreground">Rank unlock (blank = from the start)</span>
                <Input
                  type="number"
                  className="h-7 text-xs w-16"
                  value={it.rankUnlockThreshold ?? ""}
                  placeholder="rank"
                  onChange={e => {
                    const v = parseInt(e.target.value, 10);
                    update(it.id, { rankUnlockThreshold: isNaN(v) ? null : Math.max(1, v) });
                  }}
                  data-testid={`input-item-rankunlock-${it.id}`}
                />
                <span className="text-[10px] text-muted-foreground/70">reach it once, keeps it for good</span>
              </div>

              <div className="flex flex-wrap items-center gap-x-3 gap-y-2 w-full border-t border-white/10 pt-2">
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Effect</span>
                  <select
                    className="h-7 text-xs rounded-md border bg-background px-2 max-w-[220px]"
                    value={it.effectId ?? ""}
                    title="Gameplay effect this item triggers. 'None' means the item is cosmetic/sell-only."
                    onChange={e => update(it.id, { effectId: e.target.value || undefined })}
                    data-testid={`select-item-effect-${it.id}`}
                  >
                    <option value="">— none —</option>
                    {EFFECT_IDS.map(id => <option key={id} value={id}>{id}</option>)}
                  </select>
                </div>
                {it.effectId && ITEM_EFFECTS[it.effectId] && (
                  <span className="text-[10px] text-muted-foreground max-w-[420px]" data-testid={`text-item-effect-desc-${it.id}`}>
                    {ITEM_EFFECTS[it.effectId].text}
                  </span>
                )}
                <div className="flex items-center gap-1.5">
                  <span className="text-[10px] text-muted-foreground">Icon image</span>
                  <Input
                    className="h-7 text-xs w-56"
                    value={it.iconImage ?? ""}
                    placeholder="/items/example.png"
                    title="Path to the item's PNG icon. Blank falls back to the emoji above."
                    onChange={e => update(it.id, { iconImage: e.target.value || undefined })}
                    data-testid={`input-item-icon-image-${it.id}`}
                  />
                  {it.iconImage && (
                    <img
                      src={it.iconImage}
                      alt=""
                      className="w-7 h-7 object-contain"
                      style={{ imageRendering: "pixelated" }}
                      data-testid={`img-item-icon-preview-${it.id}`}
                    />
                  )}
                </div>
              </div>
            </div>
          </Card>
        ))}
      </div>
      </>
      )}
    </div>
  );
}
