/**
 * UNDER THE HOOD
 * ==============
 * A read-only window onto the AI's pattern memory during a bout: the last few
 * combinations it has memorized off the player, and which one it is answering
 * right now.
 *
 * It reads the live GameState ref rather than the throttled React snapshot,
 * because armed patterns are not part of the canvas loop's UI signature and
 * would otherwise only appear on the 250ms heartbeat. Polling keeps the whole
 * feature inside this component: nothing in the fight loop has to know the
 * overlay exists.
 */
import { useEffect, useState } from "react";
import type { MutableRefObject } from "react";
import type { GameState } from "@/game/types";
import {
  PATTERN_HUD_MAX,
  describePattern,
  selectRecentArmedPatterns,
} from "@/game/aiPatterns";
import { AI_STRINGS_BY_ID } from "@/game/aiStrings";
import { RL_UTILITIES, RL_UTILITY_LABELS } from "@/game/rlPolicy";

const LS_UNDER_THE_HOOD_KEY = "handz_under_the_hood";
const POLL_MS = 150;

/** The under-the-hood switch, off by default. Read live so flipping it on the
 *  Neural Network screen takes effect in the very next bout without a reload. */
export function isUnderTheHoodEnabled(): boolean {
  try {
    return localStorage.getItem(LS_UNDER_THE_HOOD_KEY) === "true";
  } catch {
    return false;
  }
}

export function setUnderTheHoodEnabled(on: boolean): void {
  try {
    localStorage.setItem(LS_UNDER_THE_HOOD_KEY, on ? "true" : "false");
  } catch {}
}

interface HudRow {
  key: string;
  text: string;
  n: number;
  studied: boolean;
  running: boolean;
}

interface PatternMemoryHudProps {
  liveStateRef: MutableRefObject<GameState>;
}

function readRows(state: GameState | null): HudRow[] {
  const mem = state?.aiBrain?.patterns;
  if (!mem || !Array.isArray(mem.armed)) return [];
  return selectRecentArmedPatterns(mem, PATTERN_HUD_MAX).map(p => ({
    key: p.key,
    text: describePattern(p.acts),
    n: p.n,
    studied: !!p.studied,
    running: mem.scriptKey === p.key,
  }));
}

/** The RL policy's latest choice, when the opponent's brain carries one. */
function readRlLine(state: GameState | null): string | null {
  const rl = state?.aiBrain?.rl;
  if (!rl || !rl.policy) return null;
  const last = rl.last;
  if (!last) return "RL policy \u00b7 no pick yet";
  const def = AI_STRINGS_BY_ID.get(last.stringId);
  const util = RL_UTILITIES[last.utility];
  const utilText = util ? RL_UTILITY_LABELS[util] : "?";
  const outcome = last.applied === false && util !== "standard" ? " (refused)" : "";
  return `RL \u00b7 ${def ? def.name : "#" + last.stringId} \u00b7 ${Math.round(last.tempo * 1000)}ms \u00b7 ${utilText}${outcome}`;
}

/** Cheap change test, so an unchanged memory does not re-render at 6-7Hz. */
function rowsSignature(rows: HudRow[]): string {
  return rows.map(r => `${r.key}|${r.n}|${r.running ? 1 : 0}`).join("~");
}

export default function PatternMemoryHud({ liveStateRef }: PatternMemoryHudProps) {
  const [on, setOn] = useState(() => isUnderTheHoodEnabled());
  const [rows, setRows] = useState<HudRow[]>([]);
  const [rlLine, setRlLine] = useState<string | null>(null);

  useEffect(() => {
    let sig = "";
    const tick = () => {
      const enabled = isUnderTheHoodEnabled();
      setOn(prev => (prev === enabled ? prev : enabled));
      if (!enabled) return;
      const nextRl = readRlLine(liveStateRef.current ?? null);
      setRlLine(prev => (prev === nextRl ? prev : nextRl));
      const next = readRows(liveStateRef.current ?? null);
      const nextSig = rowsSignature(next);
      if (nextSig === sig) return;
      sig = nextSig;
      setRows(next);
    };
    tick();
    const id = window.setInterval(tick, POLL_MS);
    return () => window.clearInterval(id);
  }, [liveStateRef]);

  if (!on) return null;

  return (
    // Click-through: this sits over the canvas and must never eat a punch.
    <div
      className="absolute top-12 right-3 z-[53] pointer-events-none text-right select-none"
      style={{ maxWidth: "48%", textShadow: "0 1px 3px rgba(0,0,0,0.95)" }}
      data-testid="pattern-memory-hud"
    >
      <p className="text-[10px] font-bold tracking-[0.18em] text-white/80">UNDER THE HOOD</p>
      {rlLine && (
        <p className="text-[11px] leading-tight text-white font-mono whitespace-nowrap overflow-hidden text-ellipsis" data-testid="text-rl-hud">
          {rlLine}
        </p>
      )}
      {rows.length === 0 ? (
        <p className="text-[11px] text-white/60 leading-tight" data-testid="text-pattern-hud-empty">
          nothing memorized yet
        </p>
      ) : (
        <ul className="mt-0.5 space-y-[1px]">
          {rows.map(r => (
            <li
              key={r.key}
              className="text-[11px] leading-tight text-white font-mono whitespace-nowrap overflow-hidden text-ellipsis"
              style={{ opacity: r.running ? 1 : 0.82 }}
              data-testid={`row-pattern-hud-${r.key}`}
            >
              {r.running && <span className="text-white">&#9654; </span>}
              <span>{r.text}</span>
              <span className="text-white/60">
                {" "}
                &times;{r.n}
                {r.studied ? " \u00b7 tape" : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
