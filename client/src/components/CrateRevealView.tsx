import { useMemo, useState } from "react";
import { useEnterKey, ENTER_PRIORITY } from "@/hooks/useEnterKey";
import { getCrate, type CrateDefinition, type CrateId } from "@/game/cratesConfig";
import {
  loadItemsConfig, rarityBorderClass, rarityBorderStyle, rarityTextClass, rarityTextStyle,
  type ItemDefinition,
} from "@/game/itemsConfig";
import { effectOf } from "@/game/itemEffects";
import { ItemIcon } from "@/components/LockerView";

interface CrateRevealViewProps {
  crateId: CrateId;
  /** Item ids already granted to the save, in draw order (duplicates allowed). */
  itemIds: string[];
  /** Position of this chest in a multi-chest haul (0-based). */
  crateIndex?: number;
  /** How many chests this win awarded in total. */
  crateTotal?: number;
  /** Where the chests came from — the small caption above the crate name. */
  label?: string;
  /**
   * Title for the Quick Open summary. Defaults to "Everything You Won", which
   * only reads right for chests that were actually won — a daily reward passes
   * its own wording.
   */
  quickOpenTitle?: string;
  /**
   * Every item id still waiting across this chest and the ones behind it. Given
   * only when more than one chest is left, it powers Quick Open: the whole haul
   * shown in one list instead of a chest at a time. The items are already in the
   * locker either way — this only changes how they are presented.
   */
  quickOpenItemIds?: string[];
  /** Dismiss the whole queue — Quick Open's Continue. */
  onQuickOpen?: () => void;
  onClose: () => void;
}

/**
 * Chest artwork — one SVG driven by the crate's palette + texture so all six
 * crates read as the same object in different materials.
 */
export function CrateChest({ crate, open }: { crate: CrateDefinition; open: boolean }) {
  const gid = `crate-${crate.id}`;
  return (
    <svg viewBox="0 0 200 160" className="w-52 h-auto drop-shadow-2xl" aria-hidden="true">
      <defs>
        <linearGradient id={`${gid}-body`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={crate.body} />
          <stop offset="100%" stopColor={crate.bodyDark} />
        </linearGradient>
        <linearGradient id={`${gid}-lid`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor={crate.texture === "metal" ? crate.trimLight : crate.body} stopOpacity={crate.texture === "metal" ? 0.9 : 1} />
          <stop offset="45%" stopColor={crate.body} />
          <stop offset="100%" stopColor={crate.bodyDark} />
        </linearGradient>
        <linearGradient id={`${gid}-trim`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={crate.trimLight} />
          <stop offset="60%" stopColor={crate.trim} />
          <stop offset="100%" stopColor={crate.trim} />
        </linearGradient>
        <radialGradient id={`${gid}-glow`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={crate.trimLight} stopOpacity="0.85" />
          <stop offset="100%" stopColor={crate.trimLight} stopOpacity="0" />
        </radialGradient>
        {/* Keep lid/body surface texture inside the chest silhouette */}
        <clipPath id={`${gid}-lidclip`}>
          <path d="M26 62 Q100 12 174 62 L174 74 L26 74 Z" />
        </clipPath>
        <clipPath id={`${gid}-bodyclip`}>
          <rect x="26" y="74" width="148" height="62" rx="5" />
        </clipPath>
      </defs>

      {open && <ellipse cx="100" cy="72" rx="86" ry="52" fill={`url(#${gid}-glow)`} />}

      {/* Lid — hinges open on reveal */}
      <g transform={open ? "translate(0,-26) rotate(-16 26 60)" : ""} style={{ transition: "transform 420ms ease-out" }}>
        <path d="M26 62 Q100 12 174 62 L174 74 L26 74 Z" fill={`url(#${gid}-lid)`} stroke={crate.trim} strokeWidth="2.5" />
        <g clipPath={`url(#${gid}-lidclip)`}>
          {crate.texture === "wood" && (
            <>
              <path d="M40 62 Q100 22 160 62" fill="none" stroke="rgba(0,0,0,0.22)" strokeWidth="1.4" />
              <path d="M52 68 Q100 34 148 68" fill="none" stroke="rgba(0,0,0,0.16)" strokeWidth="1.2" />
            </>
          )}
          {crate.texture === "metal" && (
            <path d="M34 66 Q100 24 166 66" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="2" />
          )}
          {crate.texture === "quartz" && (
            <>
              <path d="M70 30 L92 70 L58 66 Z" fill="rgba(255,255,255,0.55)" />
              <path d="M112 26 L142 62 L108 68 Z" fill="rgba(255,255,255,0.35)" />
            </>
          )}
        </g>
        {/* Lid bands */}
        <path d="M62 74 L62 47 Q68 42 72 40 L72 74 Z" fill={`url(#${gid}-trim)`} />
        <path d="M128 74 L128 40 Q134 43 138 47 L138 74 Z" fill={`url(#${gid}-trim)`} />
      </g>

      {/* Body */}
      <rect x="26" y="74" width="148" height="62" rx="5" fill={`url(#${gid}-body)`} stroke={crate.trim} strokeWidth="2.5" />
      <g clipPath={`url(#${gid}-bodyclip)`}>
        {crate.texture === "wood" && [90, 104, 118].map(y => (
          <line key={y} x1="30" y1={y} x2="170" y2={y} stroke="rgba(0,0,0,0.18)" strokeWidth="1.2" />
        ))}
        {crate.texture === "metal" && (
          <rect x="34" y="80" width="132" height="10" rx="4" fill="rgba(255,255,255,0.18)" />
        )}
        {crate.texture === "quartz" && (
          <>
            <path d="M40 136 L66 82 L86 136 Z" fill="rgba(255,255,255,0.5)" />
            <path d="M104 136 L128 88 L152 136 Z" fill="rgba(255,255,255,0.32)" />
          </>
        )}
      </g>
      {/* Corner + vertical bands */}
      <rect x="62" y="74" width="10" height="62" fill={`url(#${gid}-trim)`} />
      <rect x="128" y="74" width="10" height="62" fill={`url(#${gid}-trim)`} />
      <rect x="26" y="128" width="148" height="8" rx="3" fill={`url(#${gid}-trim)`} />
      {/* Lock */}
      <rect x="90" y="70" width="20" height="24" rx="4" fill={`url(#${gid}-trim)`} stroke="rgba(0,0,0,0.35)" strokeWidth="1" />
      <circle cx="100" cy="82" r="3.4" fill="rgba(0,0,0,0.55)" />
    </svg>
  );
}

export default function CrateRevealView({
  crateId, itemIds, crateIndex = 0, crateTotal = 1,
  label = "Fight Reward", quickOpenTitle = "Everything You Won", quickOpenItemIds, onQuickOpen, onClose,
}: CrateRevealViewProps) {
  const hasMore = crateIndex + 1 < crateTotal;
  const crate = getCrate(crateId);
  const [opened, setOpened] = useState(false);
  /** Set by Quick Open — every remaining chest revealed as one list. */
  const [quickOpened, setQuickOpened] = useState(false);
  const remaining = crateTotal - crateIndex;
  const canQuickOpen = !!quickOpenItemIds && quickOpenItemIds.length > 0 && remaining > 1;
  /**
   * Hovered reward tile plus the screen rect it occupies. The popup scrolls,
   * so the tooltip can't live inside it — an absolutely positioned tip is
   * clipped by the scrollport on the top row. It renders in a fixed layer
   * placed off this rect instead.
   */
  const [hovered, setHovered] = useState<{ def: ItemDefinition; rect: DOMRect } | null>(null);
  const defs = useMemo(() => loadItemsConfig(), []);

  // Enter drives the same two steps as the button: open the chest, then move
  // on to the next chest (or out of the reveal). A quick-opened haul has no
  // next chest, so its Enter leaves the reveal entirely.
  useEnterKey(
    () => {
      if (quickOpened) { (onQuickOpen ?? onClose)(); return; }
      if (opened) onClose(); else setOpened(true);
    },
    { priority: ENTER_PRIORITY.crate },
  );

  // Collapse duplicates into "×N" entries while keeping draw order.
  const collapse = (ids: string[]) => {
    const order: string[] = [];
    const counts: Record<string, number> = {};
    for (const id of ids) {
      if (counts[id] == null) { counts[id] = 0; order.push(id); }
      counts[id]++;
    }
    return order
      .map(id => ({ def: defs.find(d => d.id === id) as ItemDefinition | undefined, qty: counts[id] }))
      .filter((r): r is { def: ItemDefinition; qty: number } => !!r.def);
  };
  const rows = useMemo(
    () => collapse(quickOpened && quickOpenItemIds ? quickOpenItemIds : itemIds),
    [itemIds, quickOpenItemIds, quickOpened, defs],
  );

  if (!crate) return null;

  return (
    <div className="fixed inset-0 z-[95] bg-black/85 flex items-center justify-center p-4" data-testid="crate-overlay">
      <div
        className="rounded-xl border shadow-2xl w-[min(94vw,640px)] max-h-[92vh] overflow-y-auto flex flex-col items-center gap-4 px-6 py-6"
        style={{ background: "#12131a", borderColor: crate.trim }}
        // The tooltip is anchored to a captured rect, so scrolling would leave
        // it floating away from its tile — drop it instead.
        onScroll={() => setHovered(null)}
        data-testid="crate-popup"
      >
        <div className="text-center">
          <div className="text-[11px] font-bold uppercase tracking-[0.2em] text-white/50" data-testid="crate-reward-label">
            {label}
            {quickOpened
              ? ` — All ${remaining} Chests`
              : crateTotal > 1 ? ` — Chest ${crateIndex + 1} of ${crateTotal}` : ""}
          </div>
          <div className="text-xl font-black italic uppercase" style={{ color: crate.trimLight }} data-testid="crate-name">
            {quickOpened ? quickOpenTitle : crate.name}
          </div>
        </div>

        <CrateChest crate={crate} open={opened || quickOpened} />

        {!opened && !quickOpened ? (
          <>
            <p className="text-white/60 text-xs text-center max-w-sm">
              {crate.blurb}.
            </p>
            <button
              className="rounded-lg px-6 py-2.5 text-sm font-black uppercase tracking-wide text-black transition-transform hover:scale-105"
              style={{ background: crate.trimLight }}
              onClick={() => setOpened(true)}
              data-testid="crate-open"
            >
              Open Crate
            </button>
            {canQuickOpen && (
              <button
                className="rounded-lg border px-5 py-2 text-xs font-bold uppercase tracking-wide text-white/80 transition-colors hover:bg-white/10"
                style={{ borderColor: crate.trim }}
                onClick={() => setQuickOpened(true)}
                data-testid="crate-quick-open"
              >
                Quick Open All {remaining} Chests
              </button>
            )}
          </>
        ) : (
          <>
            {/* Artwork only — the rarity border says what it is, the tooltip says the rest. */}
            <div className="flex flex-wrap justify-center gap-2.5" data-testid="crate-items">
              {rows.map(({ def, qty }) => (
                <div
                  key={def.id}
                  className={`relative h-16 w-16 rounded-md border-2 bg-white/5 flex items-center justify-center cursor-help ${rarityBorderClass(def.rarity)}`}
                  style={rarityBorderStyle(def.rarity)}
                  onMouseEnter={e => setHovered({ def, rect: e.currentTarget.getBoundingClientRect() })}
                  onMouseLeave={() => setHovered(h => (h?.def.id === def.id ? null : h))}
                  data-testid={`crate-item-${def.id}`}
                >
                  <ItemIcon def={def} size={44} />
                  {qty > 1 && (
                    <span className="absolute bottom-0.5 right-1 text-[10px] font-mono font-bold text-white/90 drop-shadow">
                      ×{qty}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <button
              className="rounded-lg px-6 py-2.5 text-sm font-bold text-black transition-transform hover:scale-105"
              style={{ background: crate.trimLight }}
              onClick={quickOpened ? (onQuickOpen ?? onClose) : onClose}
              data-testid="crate-continue"
            >
              {!quickOpened && hasMore ? `Next Chest (${crateIndex + 2}/${crateTotal})` : "Continue"}
            </button>
          </>
        )}
      </div>

      {hovered && <RewardTooltip def={hovered.def} rect={hovered.rect} />}
    </div>
  );
}

/**
 * Reward tooltip in its own fixed layer, anchored to the hovered tile's screen
 * rect. It sits above the tile when there's room and flips below when there
 * isn't, and its left edge is clamped inside the viewport so tiles in the
 * outer columns don't push it off-screen.
 */
function RewardTooltip({ def, rect }: { def: ItemDefinition; rect: DOMRect }) {
  const MARGIN = 8;
  // Narrow viewports get a narrower tooltip rather than one hanging off-screen.
  const WIDTH = Math.min(224, Math.max(120, window.innerWidth - MARGIN * 2));
  const effect = effectOf(def);
  const flipBelow = rect.top < 110;
  const maxLeft = Math.max(MARGIN, window.innerWidth - WIDTH - MARGIN);
  const left = Math.min(maxLeft, Math.max(MARGIN, rect.left + rect.width / 2 - WIDTH / 2));

  return (
    <div
      className="fixed z-[130] bg-[#101016] border border-white/25 rounded px-2 py-1.5 shadow-xl pointer-events-none"
      style={{
        width: WIDTH,
        left,
        ...(flipBelow ? { top: rect.bottom + 6 } : { bottom: window.innerHeight - rect.top + 6 }),
      }}
      data-testid={`crate-item-tip-${def.id}`}
    >
      <div className="text-[11px] font-bold text-white">{def.name}</div>
      <div className={`text-[10px] font-bold ${rarityTextClass(def.rarity)}`} style={rarityTextStyle(def.rarity)}>
        {def.rarity}
        {def.isKeepsake ? " · Keepsake" : def.isConsumable ? " · Consumable" : ""}
        {def.isBoost ? " · Boost" : ""}
      </div>
      <div className="text-white/80 text-[10px] leading-snug mt-0.5">
        {effect ? effect.text : "No fight effect — sell it or keep it as a collectible."}
      </div>
    </div>
  );
}
