import { useEffect, useRef, useState } from "react";
import type { FighterColors, FighterState, GameState } from "@/game/types";
import { activeRefinementsOnly, createInitialState } from "@/game/engine";
import { soundEngine } from "@/game/sound";
import { useFightScene3D } from "@/game/three/useFightScene3D";
import type { CeremonyStage } from "@/components/DecisionCeremony";

interface SkillPoints {
  power: number; speed: number; defense: number; stamina: number; focus: number;
}

interface BoutDetails {
  playerLevel: number; playerWins: number; playerLosses: number; playerDraws: number; playerKOs: number;
  playerSp?: SkillPoints; playerRefinement?: Record<string, number>;
  enemyLevel: number; enemyWins: number; enemyLosses: number; enemyDraws: number; enemyKOs: number;
  enemySp?: SkillPoints; enemyRefinement?: Record<string, number>;
  enemyRank?: number;
}

interface RingWalkOverlayProps {
  playerName: string;
  enemyName: string;
  playerNickname?: string;
  playerColors: FighterColors;
  enemyColors: FighterColors;
  ringCanvasColor?: string;
  stage: CeremonyStage;
  boutDetails: BoutDetails;
  playerRank?: number;
  onComplete: () => void;
}

const BASE_W = 800;
const BASE_H = 600;
const MAX_SP = 200;
const STAT_KEYS = [
  { key: "power" as const, short: "PWR", color: "#ef4444" },
  { key: "speed" as const, short: "SPD", color: "#3b82f6" },
  { key: "defense" as const, short: "DEF", color: "#22c55e" },
  { key: "stamina" as const, short: "STA", color: "#f59e0b" },
  { key: "focus" as const, short: "FOC", color: "#a855f7" },
];
const REF_KEYS = ["jabPower","hookPower","uppercutPower","ironChin","slippery","guardMaster","duckRecovery","punchRolling","fastTwitch","heartRefinement","chinHitter","technician","lifeDrain","pressureFighter","precisionStriker","bruiser","koArtist"] as const;
const REF_LABELS: Record<string, string> = {
  jabPower: "Straight Punch", hookPower: "Hook Power", uppercutPower: "Uppercut Power", bruiser: "Bruiser", koArtist: "KO Artist",
  ironChin: "Iron Chin", slippery: "Slippery", guardMaster: "Guard Master",
  duckRecovery: "Duck Recovery", punchRolling: "Punch Rolling", fastTwitch: "Fast Twitch",
  heartRefinement: "Heart", chinHitter: "Chin Hitter", technician: "Technician", lifeDrain: "Life Drain",
  pressureFighter: "Pressure Fighter", precisionStriker: "Precision Striker",
};

/** Face-off staging (engine px): fighters nose to nose at ring centre, ref off one shoulder behind. */
const MID_X = 400, MID_Z = 262, HALF_GAP = 20;
const REF_X = 475, REF_Z = 215;
/** Used when the ref's line can't be heard (sound off / not loaded yet). */
const SILENT_LINE_S = 7;

function parseNickname(fullName: string): { baseName: string; nickname?: string } {
  const match = fullName.match(/"([^"]+)"/);
  if (match) {
    return { baseName: fullName.replace(`"${match[1]}"`, "").replace(/\s+/g, " ").trim(), nickname: match[1] };
  }
  return { baseName: fullName };
}

function makeFaceoffState(p: RingWalkOverlayProps): GameState {
  const state = createInitialState();
  state.menuBackground = true;
  state.phase = "fighting" as GameState["phase"];
  state.faceoff = true;
  state.crowdBobTime = 0;
  state.ringCanvasColor = p.ringCanvasColor ?? "#3d2f1e";
  state.ringColors = p.stage.ringColors ?? null;
  state.refereeVisible = true;
  state.refX = REF_X;
  state.refZ = REF_Z;
  const place = (f: FighterState, colors: FighterColors, x: number, facing: number, look: CeremonyStage["player"]) => {
    f.x = x; f.z = MID_Z; f.facingAngle = facing; f.facing = facing === 0 ? 1 : -1;
    f.colors = colors;
    f.boxingStance = look.boxingStance;
    if (look.guardStance !== undefined) f.guardStance = look.guardStance;
  };
  place(state.player, p.playerColors, MID_X - HALF_GAP, 0, p.stage.player);
  place(state.enemy, p.enemyColors, MID_X + HALF_GAP, Math.PI, p.stage.enemy);
  state.playerColors = p.playerColors;
  state.enemyColors = p.enemyColors;
  return state;
}

/** The 3D ring, both fighters squared up head on. */
function FaceoffRing({ props }: { props: RingWalkOverlayProps }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState>(makeFaceoffState(props));
  const view3d = useFightScene3D({ fillAspect: true });

  useEffect(() => {
    let raf = 0, last = 0;
    const loop = (ts: number) => {
      const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
      last = ts;
      const s = stateRef.current;
      stateRef.current = { ...s, crowdBobTime: s.crowdBobTime + dt * 1.2 };
      view3d.draw(canvasRef.current?.getContext("2d") ?? null, stateRef.current, { hud: false });
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <>
      <canvas ref={view3d.glCanvasRef} aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none" style={{ visibility: "hidden" }} />
      <canvas ref={canvasRef} width={BASE_W} height={BASE_H} aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none" />
    </>
  );
}

const ROW = "1fr 52px 1fr";
const label: React.CSSProperties = { textAlign: "center", fontSize: "8px", fontWeight: 700, letterSpacing: "0.1em", color: "rgba(255,255,255,0.35)", textTransform: "uppercase", lineHeight: 1.15 };

function Bar({ value, pct, color, side }: { value: number; pct: number; color: string; side: "l" | "r" }) {
  const bar = (
    <div style={{ flex: 1, maxWidth: 110, height: 5, background: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden", display: "flex", justifyContent: side === "l" ? "flex-end" : "flex-start" }}>
      <div style={{ height: "100%", width: `${Math.min(100, pct)}%`, background: color, borderRadius: 3 }} />
    </div>
  );
  const num = <span style={{ fontSize: "11px", fontWeight: 700, color: value > 0 ? "rgba(255,255,255,0.85)" : "rgba(255,255,255,0.25)", minWidth: 24, textAlign: side === "l" ? "right" : "left" }}>{value}</span>;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, justifyContent: side === "l" ? "flex-end" : "flex-start" }}>
      {side === "l" ? <>{num}{bar}</> : <>{bar}{num}</>}
    </div>
  );
}

/** Tale of the tape across the bottom half: names, records, stats and refinements. */
function FaceoffCard({ p, visible }: { p: RingWalkOverlayProps; visible: boolean }) {
  const bd = p.boutDetails;
  const { baseName: pBase, nickname: pParsedNick } = parseNickname(p.playerName);
  const pNick = p.playerNickname ?? pParsedNick;
  const { baseName: eBase, nickname: eNick } = parseNickname(p.enemyName);
  // Same filter Bout Details uses: the player's own pick list, the opponent's top five.
  const pRef = activeRefinementsOnly(bd.playerRefinement as Record<string, unknown> | undefined, true) as Record<string, number> | undefined;
  const eRef = activeRefinementsOnly(bd.enemyRefinement as Record<string, unknown> | undefined) as Record<string, number> | undefined;
  const refKeys = REF_KEYS.filter(k => (pRef?.[k] ?? 0) > 0 || (eRef?.[k] ?? 0) > 0);
  const showStats = !!(bd.playerSp || bd.enemySp);

  const rows: Array<{ label: string; pVal: string | number; eVal: string | number; color: string }> = [
    { label: "Level", pVal: bd.playerLevel, eVal: bd.enemyLevel, color: "#fbbf24" },
    { label: "Rank", pVal: p.playerRank != null ? `#${p.playerRank}` : "—", eVal: bd.enemyRank != null ? `#${bd.enemyRank}` : "—", color: "#a78bfa" },
    { label: "Record", pVal: `${bd.playerWins}-${bd.playerLosses}-${bd.playerDraws}`, eVal: `${bd.enemyWins}-${bd.enemyLosses}-${bd.enemyDraws}`, color: "#e2e8f0" },
    { label: "KOs", pVal: bd.playerKOs, eVal: bd.enemyKOs, color: "#ef4444" },
  ];

  const column = (children: React.ReactNode) => (
    <div style={{ flex: "1 1 300px", minWidth: 0, display: "flex", flexDirection: "column", gap: 2 }}>{children}</div>
  );

  return (
    <div
      data-testid="card-ring-walk"
      style={{
        position: "absolute", left: 0, right: 0, bottom: 0, height: "50%",
        background: "linear-gradient(180deg, rgba(5,5,14,0) 0%, rgba(5,5,14,0.88) 14%, rgba(5,5,14,0.96) 100%)",
        display: "flex", flexDirection: "column", alignItems: "center", padding: "1.5vh 16px 1.5vh",
        opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(40px)",
        transition: "opacity 0.6s ease-out, transform 0.7s cubic-bezier(0.22,1,0.36,1)",
        overflow: "hidden",
      }}
    >
      <div style={{ width: "min(980px, 96vw)", display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "end", gap: 16, marginBottom: 6 }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "clamp(15px, 2.2vw, 26px)", fontWeight: 900, color: "#fff", textTransform: "uppercase", lineHeight: 1.05, textShadow: "0 0 24px rgba(59,130,246,0.45)" }}>{pBase}</div>
          {pNick && <div style={{ fontSize: "12px", fontStyle: "italic", color: "rgba(255,255,255,0.45)", marginTop: 2 }}>"{pNick}"</div>}
        </div>
        <div style={{ fontSize: "clamp(11px, 1.4vw, 15px)", fontWeight: 900, color: "#fbbf24", letterSpacing: "0.3em", paddingBottom: 4 }}>VS</div>
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: "clamp(15px, 2.2vw, 26px)", fontWeight: 900, color: "#fff", textTransform: "uppercase", lineHeight: 1.05, textShadow: "0 0 24px rgba(239,68,68,0.45)" }}>{eBase}</div>
          {eNick && <div style={{ fontSize: "12px", fontStyle: "italic", color: "rgba(255,255,255,0.45)", marginTop: 2 }}>"{eNick}"</div>}
        </div>
      </div>
      <div style={{ width: "min(980px, 96vw)", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, marginBottom: 8 }}>
        <div style={{ height: 3, background: "#3b82f6", borderRadius: 2 }} />
        <div style={{ height: 3, background: "#ef4444", borderRadius: 2 }} />
      </div>

      <div style={{ width: "min(980px, 96vw)", display: "flex", flexWrap: "wrap", gap: "10px 40px" }}>
        {column(<>
          {rows.map(r => (
            <div key={r.label} style={{ display: "grid", gridTemplateColumns: ROW, gap: "0 8px", alignItems: "center" }}>
              <div style={{ textAlign: "right", fontSize: "clamp(12px, 1.4vw, 16px)", fontWeight: 900, color: r.color }}>{r.pVal}</div>
              <div style={label}>{r.label}</div>
              <div style={{ textAlign: "left", fontSize: "clamp(12px, 1.4vw, 16px)", fontWeight: 900, color: r.color }}>{r.eVal}</div>
            </div>
          ))}
          {showStats && <div style={{ height: 1, background: "rgba(255,255,255,0.08)", margin: "2px 0" }} />}
          {showStats && STAT_KEYS.map(sk => {
            const pv = bd.playerSp?.[sk.key] ?? 0;
            const ev = bd.enemySp?.[sk.key] ?? 0;
            return (
              <div key={sk.key} style={{ display: "grid", gridTemplateColumns: ROW, gap: "0 8px", alignItems: "center" }}>
                <Bar value={pv} pct={(pv / MAX_SP) * 100} color={sk.color} side="l" />
                <div style={label}>{sk.short}</div>
                <Bar value={ev} pct={(ev / MAX_SP) * 100} color={sk.color} side="r" />
              </div>
            );
          })}
        </>)}
        {refKeys.length > 0 && column(<>
          <div style={{ ...label, color: "rgba(192,132,252,0.7)", letterSpacing: "0.2em", marginBottom: 2 }}>Refinements</div>
          {refKeys.map(k => {
            const pv = pRef?.[k] ?? 0;
            const ev = eRef?.[k] ?? 0;
            return (
              <div key={k} style={{ display: "grid", gridTemplateColumns: ROW, gap: "0 8px", alignItems: "center" }}>
                <Bar value={pv} pct={pv} color="#a855f7" side="l" />
                <div style={{ ...label, fontSize: "7px" }}>{REF_LABELS[k]}</div>
                <Bar value={ev} pct={ev} color="#a855f7" side="r" />
              </div>
            );
          })}
        </>)}
      </div>
    </div>
  );
}

export default function RingWalkOverlay(props: RingWalkOverlayProps) {
  const { onComplete } = props;
  const [shown, setShown] = useState(false);
  const [cardVisible, setCardVisible] = useState(false);
  const done = useRef(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const finish = () => {
    if (done.current) return;
    done.current = true;
    timers.current.forEach(clearTimeout);
    onComplete();
  };

  useEffect(() => {
    const at = (fn: () => void, ms: number) => { timers.current.push(setTimeout(() => { if (!done.current) fn(); }, ms)); };
    at(() => setShown(true), 40);
    // The crowd carries straight on into the bout (the fight's start is a no-op while it plays).
    at(() => { soundEngine.startCrowdAmbient(); soundEngine.playCheer(2); }, 300);
    at(() => setCardVisible(true), 700);
    at(() => {
      // The ref's full instructions; the countdown starts once he's finished.
      const len = soundEngine.refLine("refIntro") || SILENT_LINE_S;
      at(() => soundEngine.playCheer(3), len * 1000);
      at(finish, len * 1000 + 700);
    }, 1100);
    return () => {
      timers.current.forEach(clearTimeout);
      soundEngine.stopRefLine();
    };
  }, []);

  return (
    <div
      data-testid="overlay-ring-walk"
      style={{
        position: "fixed", inset: 0, zIndex: 60, overflow: "hidden", background: "#06060e",
        opacity: shown ? 1 : 0, transition: "opacity 0.4s ease-out", userSelect: "none",
      }}
    >
      <FaceoffRing props={props} />
      <FaceoffCard p={props} visible={cardVisible} />
      <button
        data-testid="button-ring-walk-skip"
        onClick={finish}
        style={{
          position: "fixed", top: 14, right: 16, zIndex: 70, padding: "6px 16px",
          background: "rgba(0,0,0,0.55)", border: "1px solid rgba(255,255,255,0.2)", borderRadius: "20px",
          color: "rgba(255,255,255,0.55)", fontSize: "11px", fontWeight: 700, letterSpacing: "0.15em",
          cursor: "pointer", textTransform: "uppercase", backdropFilter: "blur(4px)",
        }}
      >
        SKIP ›
      </button>
    </div>
  );
}
