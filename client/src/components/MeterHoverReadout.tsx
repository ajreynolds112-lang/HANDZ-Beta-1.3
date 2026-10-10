/**
 * Hover panel for the gym meters: a short label/value list that opens to the
 * right of the meter while it is hovered. The meter's root must carry `group`
 * and `relative`.
 */
export interface ReadoutRow {
  label: string;
  value: string;
  /** "good" = green, "bad" = red, otherwise white. */
  tone?: "good" | "bad";
}

export default function MeterHoverReadout({ title, rows, testId }: { title: string; rows: ReadoutRow[]; testId?: string }) {
  return (
    <div
      className="pointer-events-none absolute left-full top-0 z-50 ml-2 hidden w-56 rounded border border-white/15 bg-black/90 px-2 py-1.5 shadow-xl group-hover:block"
      data-testid={testId}
    >
      <div className="mb-1 text-[10px] font-bold tracking-wide text-white/70">{title}</div>
      {rows.map(r => (
        <div key={r.label} className="flex items-baseline justify-between gap-3 text-[10px] leading-snug">
          <span className="text-white/60">{r.label}</span>
          <span className={`font-mono tabular-nums ${r.tone === "good" ? "text-green-400" : r.tone === "bad" ? "text-red-400" : "text-white"}`}>{r.value}</span>
        </div>
      ))}
    </div>
  );
}
