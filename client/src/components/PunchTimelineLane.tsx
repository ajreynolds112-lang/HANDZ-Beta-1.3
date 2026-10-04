import { useRef } from "react";
import { SPEED_MAX, SPEED_MIN, type Key, evalRotation, evalSpeed } from "@/game/three/punchProfiles";

export type LaneKind = "rotation" | "speed";

const VB_W = 1000;

/** Value → 0..1 from the top. Rotation: +180 top, -180 bottom. Speed: log scale, fastest at the top. */
function valueToY(kind: LaneKind, v: number): number {
  if (kind === "rotation") return (180 - v) / 360;
  const LOG_LO = Math.log2(SPEED_MIN), LOG_HI = Math.log2(SPEED_MAX);
  return (LOG_HI - Math.log2(Math.max(SPEED_MIN, v))) / (LOG_HI - LOG_LO);
}
function yToValue(kind: LaneKind, y: number): number {
  const c = Math.max(0, Math.min(1, y));
  if (kind === "rotation") return Math.round(180 - c * 360);
  const LOG_LO = Math.log2(SPEED_MIN), LOG_HI = Math.log2(SPEED_MAX);
  return Math.round(2 ** (LOG_HI - c * (LOG_HI - LOG_LO)) * 100) / 100;
}

export interface PhaseBand { label: string; from: number; to: number }

interface LaneProps {
  label: string;
  kind: LaneKind;
  color: string;
  keys: Key[];
  /** Animation-time playhead 0..1. */
  playhead: number;
  bands: PhaseBand[];
  height?: number;
  /** Called once at the start of every edit gesture (undo checkpoint). */
  onBeginEdit: () => void;
  onChange: (keys: Key[]) => void;
  testId: string;
}

/**
 * One keyframe lane. Right-click empty space adds a key, right-click a key
 * removes it, left-drag a key moves it in time and value.
 */
export default function PunchTimelineLane({ label, kind, color, keys, playhead, bands, height = 64, onBeginEdit, onChange, testId }: LaneProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ key: Key; pointerId: number } | null>(null);
  const keysRef = useRef(keys);
  keysRef.current = keys;

  const at = (e: { clientX: number; clientY: number }) => {
    const r = boxRef.current!.getBoundingClientRect();
    return { t: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: (e.clientY - r.top) / r.height };
  };

  const evalAt = (t: number) => (kind === "rotation" ? evalRotation(keys, t) : evalSpeed(keys, t));
  const pts: string[] = [];
  for (let i = 0; i <= 200; i++) {
    const t = i / 200;
    pts.push(`${(t * VB_W).toFixed(1)},${(valueToY(kind, evalAt(t)) * height).toFixed(1)}`);
  }
  const zeroY = valueToY(kind, kind === "rotation" ? 0 : 1) * 100;
  const current = evalAt(playhead);

  const onLaneContext = (e: React.MouseEvent) => {
    e.preventDefault();
    const p = at(e);
    onBeginEdit();
    const k: Key = { t: Math.round(p.t * 1000) / 1000, v: yToValue(kind, p.y) };
    onChange([...keys, k].sort((a, b) => a.t - b.t));
  };
  const onKeyContext = (e: React.MouseEvent, k: Key) => {
    e.preventDefault();
    e.stopPropagation();
    onBeginEdit();
    onChange(keys.filter(x => x !== k));
  };
  const onKeyDown = (e: React.PointerEvent, k: Key) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    onBeginEdit();
    dragRef.current = { key: k, pointerId: e.pointerId };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onKeyMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const p = at(e);
    const nk: Key = { t: Math.round(p.t * 1000) / 1000, v: yToValue(kind, p.y) };
    const next = keysRef.current.map(x => (x === d.key ? nk : x)).sort((a, b) => a.t - b.t);
    d.key = nk;
    onChange(next);
  };
  const onKeyUp = (e: React.PointerEvent) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  };

  return (
    <div className="flex items-stretch gap-2" data-testid={testId}>
      <div className="w-20 shrink-0 flex flex-col justify-center text-[11px] leading-tight">
        <span className="font-semibold" style={{ color }}>{label}</span>
        <span className="text-muted-foreground tabular-nums">
          {kind === "rotation" ? `${Math.round(current)}°` : `${current.toFixed(2)}×`}
        </span>
      </div>
      <div ref={boxRef} className="relative flex-1 rounded border border-border bg-black/40 select-none overflow-hidden"
        style={{ height }} onContextMenu={onLaneContext}>
        {bands.map((b, i) => (
          <div key={b.label} className="absolute inset-y-0 pointer-events-none"
            style={{ left: `${b.from * 100}%`, width: `${(b.to - b.from) * 100}%`, background: i % 2 ? "rgba(255,255,255,0.03)" : "transparent" }} />
        ))}
        <div className="absolute inset-x-0 border-t border-dashed border-white/15 pointer-events-none" style={{ top: `${zeroY}%` }} />
        <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${VB_W} ${height}`} preserveAspectRatio="none">
          <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" opacity={0.9} />
        </svg>
        <div className="absolute inset-y-0 w-px bg-yellow-300 pointer-events-none" style={{ left: `${playhead * 100}%` }} />
        {keys.map((k, i) => (
          <div key={i}
            className="absolute w-3 h-3 -ml-1.5 -mt-1.5 rounded-full border-2 border-white cursor-grab active:cursor-grabbing"
            style={{ left: `${k.t * 100}%`, top: `${valueToY(kind, k.v) * 100}%`, background: color, touchAction: "none" }}
            title={kind === "rotation" ? `${k.v}° @ ${Math.round(k.t * 100)}%` : `${k.v}× @ ${Math.round(k.t * 100)}%`}
            onPointerDown={e => onKeyDown(e, k)} onPointerMove={onKeyMove} onPointerUp={onKeyUp}
            onContextMenu={e => onKeyContext(e, k)} data-testid={`${testId}-key-${i}`} />
        ))}
        <span className="absolute right-1 top-0.5 text-[9px] text-white/35 pointer-events-none">{kind === "rotation" ? "+180°" : `${SPEED_MAX}×`}</span>
        <span className="absolute right-1 bottom-0.5 text-[9px] text-white/35 pointer-events-none">{kind === "rotation" ? "-180°" : `${SPEED_MIN}×`}</span>
      </div>
    </div>
  );
}
