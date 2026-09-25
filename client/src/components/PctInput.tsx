import { useState } from "react";

/**
 * The typeable % readout beside a rebalancing slider. Keeps a local draft while
 * the field is focused so the box can be cleared or half-typed, but commits
 * (and lets the caller rebalance the rest) on every parseable keystroke.
 *
 * Shared by the crate-odds and rarity-odds tables on the Roster Generation page.
 */
export default function PctInput({ value, disabled, color, onCommit, testId }: {
  value: number;
  disabled: boolean;
  color: string;
  onCommit: (pct: number) => void;
  testId: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={0}
      max={100}
      step={1}
      disabled={disabled}
      value={draft ?? String(value)}
      onFocus={e => e.currentTarget.select()}
      onChange={e => {
        const raw = e.target.value;
        setDraft(raw);
        const n = parseInt(raw, 10);
        if (!isNaN(n)) onCommit(Math.max(0, Math.min(100, n)));
      }}
      // Dropping the draft snaps the box back to the real (rebalanced) value.
      onBlur={() => setDraft(null)}
      onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur(); }}
      className="w-9 h-6 shrink-0 rounded border border-white/15 bg-white/5 px-1 text-[10px] font-mono font-bold text-right tabular-nums outline-none focus:border-white/40"
      style={{ color }}
      title="Type a % or drag the slider"
      data-testid={testId}
    />
  );
}
