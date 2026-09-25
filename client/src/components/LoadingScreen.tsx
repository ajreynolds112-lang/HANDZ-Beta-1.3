import { useEffect, useMemo, useRef, useState } from "react";

/**
 * Full-screen loading view for the heavy career transitions (week simulation,
 * career slot load, fight setup). It borrows the arena look of the ring-walk and
 * decision overlays: near-black purple-navy backdrop, a single warm spotlight,
 * uppercase black-weight type and a thin gold progress rail.
 */

const FIGHT_TIPS: string[] = [
  "Hold Tab to circle out — walking straight back keeps you in the pocket.",
  "A perfect block lands in the instant before impact, not while you sit on guard.",
  "Body work drains stamina. A tired opponent stops rolling with your hooks.",
  "Every knockdown count that reaches ten is a stoppage — no exceptions.",
  "Feints buy you a beat. Bait the guard up, then dig underneath it.",
  "Refinement points beat raw stat points once your opponent is above rank 20.",
  "Speed shortens your telegraph as well as your recovery.",
  "Chin refinement is the difference between a flash knockdown and a stoppage.",
  "Save your one-shot boosts for a title fight — they only burn when a bout ends.",
  "Rank 1 only changes hands by beating whoever is holding the belt.",
  "Roll with a punch instead of blocking it and you keep your stamina.",
  "Counters land hardest on the frame right after their punch peaks.",
  "Fight camp freezes your opponent's level — use every week of it.",
  "Sparring costs a fee per session, but it never costs you a ranking.",
  "Uppercuts beat a high guard. Hooks beat a fighter who ducks.",
];

interface LoadingScreenProps {
  /** Big headline, e.g. "Advancing Week" or "Making the Walk". */
  title: string;
  /** The phase currently running, shown under the bar. */
  label: string;
  /** 0..1. */
  progress: number;
  /** Optional line above the title, e.g. "Week 14". */
  subtitle?: string;
}

export default function LoadingScreen({ title, label, progress, subtitle }: LoadingScreenProps) {
  // Tips rotate on a timer so a long load doesn't sit on one line of text.
  const tips = useMemo(() => {
    const shuffled = [...FIGHT_TIPS];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }, []);
  const [tipIndex, setTipIndex] = useState(0);
  const [tipVisible, setTipVisible] = useState(true);

  useEffect(() => {
    const id = setInterval(() => {
      setTipVisible(false);
      setTimeout(() => {
        setTipIndex(i => (i + 1) % tips.length);
        setTipVisible(true);
      }, 320);
    }, 3600);
    return () => clearInterval(id);
  }, [tips.length]);

  // The bar never walks backwards, even if a phase reports a lower value.
  const shownRef = useRef(0);
  const pct = Math.round(Math.max(0, Math.min(1, progress)) * 100);
  if (pct > shownRef.current) shownRef.current = pct;
  const shown = shownRef.current;

  return (
    <div
      className="fixed inset-0 z-[70] flex flex-col items-center justify-center select-none overflow-hidden"
      style={{ background: "linear-gradient(180deg, #080414 0%, #0d0820 55%, #06060e 100%)" }}
      data-testid="overlay-loading-screen"
    >
      {/* Overhead ring spotlight */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          background: "radial-gradient(ellipse 55% 42% at 50% 38%, rgba(255,248,220,0.10) 0%, rgba(255,248,220,0.03) 45%, rgba(0,0,0,0) 75%)",
        }}
      />
      {/* Canvas-coloured floor band */}
      <div
        className="absolute left-0 right-0 bottom-0 h-[22%] pointer-events-none"
        style={{ background: "linear-gradient(180deg, rgba(61,47,30,0) 0%, rgba(61,47,30,0.35) 100%)" }}
      />

      <div className="relative w-full max-w-2xl px-8 text-center">
        {subtitle && (
          <div
            className="text-[11px] font-bold uppercase tracking-[0.42em] mb-3"
            style={{ color: "#c4a84a" }}
            data-testid="text-loading-subtitle"
          >
            {subtitle}
          </div>
        )}
        <h1
          className="text-4xl md:text-5xl font-black uppercase tracking-[0.18em] text-white"
          data-testid="text-loading-title"
        >
          {title}
        </h1>

        <div className="mt-10">
          <div
            className="h-[6px] w-full rounded-full overflow-hidden"
            style={{ background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.08)" }}
          >
            <div
              className="h-full rounded-full"
              style={{
                width: `${shown}%`,
                background: "linear-gradient(90deg, #8a6f26 0%, #c4a84a 55%, #fff8dc 100%)",
                boxShadow: "0 0 12px rgba(196,168,74,0.55)",
                transition: "width 0.35s cubic-bezier(0.22,1,0.36,1)",
              }}
              data-testid="bar-loading-progress"
            />
          </div>
          <div className="mt-3 flex items-baseline justify-between">
            <span
              className="text-[11px] font-bold uppercase tracking-[0.3em]"
              style={{ color: "rgba(255,255,255,0.72)" }}
              data-testid="text-loading-phase"
            >
              {label}
            </span>
            <span
              className="text-[11px] font-bold tabular-nums tracking-[0.2em]"
              style={{ color: "#c4a84a" }}
              data-testid="text-loading-percent"
            >
              {shown}%
            </span>
          </div>
        </div>

        <div className="mt-14 min-h-[3.5rem]">
          <div
            className="text-[10px] font-bold uppercase tracking-[0.38em] mb-2"
            style={{ color: "rgba(255,255,255,0.35)" }}
          >
            Cornerman Says
          </div>
          <p
            className="text-sm md:text-base"
            style={{
              color: "#fff8e0",
              opacity: tipVisible ? 0.92 : 0,
              transition: "opacity 0.3s ease-out",
            }}
            data-testid="text-loading-tip"
          >
            {tips[tipIndex]}
          </p>
        </div>
      </div>
    </div>
  );
}
