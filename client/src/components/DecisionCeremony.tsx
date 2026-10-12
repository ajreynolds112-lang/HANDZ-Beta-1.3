import { useEffect, useRef, useState } from "react";
import type { FighterColors, FighterState, GameState } from "@/game/types";
import { createInitialState } from "@/game/engine";
import type { RingColors } from "@/game/ringColors";
import { useFightScene3D } from "@/game/three/useFightScene3D";
import { useEnterKey } from "@/hooks/useEnterKey";

const DEFAULT_RING_COLOR = "#3d2f1e";
const BASE_W = 800;
const BASE_H = 600;

/** Looks carried from the bout into the staged ceremony. */
export interface CeremonyStage {
  ringColors?: RingColors | null;
  player: { boxingStance: FighterState["boxingStance"]; guardStance?: number };
  enemy: { boxingStance: FighterState["boxingStance"]; guardStance?: number };
}

interface DecisionCeremonyProps {
  isWin: boolean;
  isDraw: boolean;
  playerName: string;
  enemyName: string;
  playerColors: FighterColors;
  enemyColors: FighterColors;
  ringCanvasColor?: string;
  stage?: CeremonyStage;
  onContinue: () => void;
}

const REF_X = 400, REF_Z = 262, SPREAD = 72;

function makeCeremonyState(p: DecisionCeremonyProps): GameState {
  const state = createInitialState();
  state.menuBackground = true;
  state.phase = "fighting" as GameState["phase"];
  state.crowdBobTime = 0;
  state.crowdKdBounceTimer = 0;
  state.ringCanvasColor = p.ringCanvasColor ?? DEFAULT_RING_COLOR;
  state.ringColors = p.stage?.ringColors ?? null;
  state.refereeVisible = true;
  state.refX = REF_X;
  state.refZ = REF_Z;
  state.ceremony = { winner: p.isDraw ? "draw" : p.isWin ? "player" : "enemy", raised: false };
  const place = (f: FighterState, colors: FighterColors, x: number, facing: number, look?: CeremonyStage["player"]) => {
    f.x = x; f.z = REF_Z; f.facingAngle = facing; f.facing = facing < Math.PI / 2 ? 1 : -1;
    f.colors = colors;
    if (look) { f.boxingStance = look.boxingStance; if (look.guardStance !== undefined) f.guardStance = look.guardStance; }
  };
  place(state.player, p.playerColors, REF_X - SPREAD, Math.PI / 2 - 0.3, p.stage?.player);
  place(state.enemy, p.enemyColors, REF_X + SPREAD, Math.PI / 2 + 0.3, p.stage?.enemy);
  state.playerColors = p.playerColors;
  state.enemyColors = p.enemyColors;
  return state;
}

/** The 3D ring with both fighters either side of the referee. */
function CeremonyRing({ props, raised }: { props: DecisionCeremonyProps; raised: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState>(makeCeremonyState(props));
  const raisedRef = useRef(raised);
  raisedRef.current = raised;
  const view3d = useFightScene3D({ fillAspect: true });

  useEffect(() => {
    let raf = 0, last = 0;
    const loop = (ts: number) => {
      const dt = last ? Math.min(0.05, (ts - last) / 1000) : 0;
      last = ts;
      const s = stateRef.current;
      stateRef.current = {
        ...s,
        crowdBobTime: s.crowdBobTime + dt * 1.2,
        ceremony: s.ceremony && { ...s.ceremony, raised: raisedRef.current },
      };
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

export default function DecisionCeremony(props: DecisionCeremonyProps) {
  const { isWin, isDraw, playerName, enemyName, onContinue } = props;
  const [refArmRaised, setRefArmRaised] = useState(false);
  const [showResult, setShowResult] = useState(false);
  const [showButton, setShowButton] = useState(false);

  // Only once the button has faded in — Enter shouldn't skip the ceremony.
  useEnterKey(onContinue, { enabled: showButton });

  useEffect(() => {
    const t1 = setTimeout(() => setRefArmRaised(true), 900);
    const t2 = setTimeout(() => setShowResult(true), 1550);
    const t3 = setTimeout(() => setShowButton(true), 2600);
    return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
  }, []);

  const resultText = isDraw ? "DRAW" : isWin ? "VICTORY" : "DEFEAT";
  const resultColor = isDraw ? "#d97706" : isWin ? "#60a5fa" : "#f87171";
  const resultShadow = isDraw
    ? "0 0 70px rgba(217,119,6,0.9)"
    : isWin
    ? "0 0 70px rgba(96,165,250,0.9)"
    : "0 0 70px rgba(248,113,113,0.9)";

  return (
    <div
      className="fixed inset-0 select-none overflow-hidden"
      style={{ zIndex: 60 }}
      data-testid="overlay-decision-ceremony"
    >
      <CeremonyRing props={props} raised={refArmRaised} />
      <div className="absolute inset-0 flex flex-col items-center" style={{ zIndex: 1 }}>
        <div
          style={{
            opacity: showResult ? 1 : 0,
            transform: showResult ? "scale(1) translateY(0)" : "scale(0.6) translateY(10px)",
            transition: "opacity 0.5s, transform 0.55s cubic-bezier(0.22,1,0.36,1)",
            marginTop: "6vh",
            textAlign: "center",
          }}
        >
          <div
            className="font-black tracking-[0.18em] uppercase"
            style={{
              fontSize: "clamp(44px, 9vw, 82px)",
              color: resultColor,
              textShadow: resultShadow,
            }}
          >
            {resultText}
          </div>
          <div
            className="text-xs tracking-[0.35em] uppercase mt-1"
            style={{ color: "rgba(255,255,255,0.35)" }}
          >
            {isDraw ? "Judges split" : isWin ? "Winner" : "Winner"}
          </div>
        </div>

        <div style={{ flex: 1 }} />

        <div
          className="flex w-full justify-between items-end"
          style={{ padding: "0 clamp(24px, 12vw, 220px) clamp(70px, 10vh, 110px)" }}
        >
          <div
            className="font-black tracking-widest uppercase text-center"
            style={{
              fontSize: "clamp(10px, 1.3vw, 15px)",
              color: isWin ? "#60a5fa" : "rgba(255,255,255,0.55)",
              maxWidth: 210,
              wordBreak: "break-word",
              lineHeight: 1.2,
              textShadow: "0 2px 8px rgba(0,0,0,0.9)",
            }}
          >
            {playerName || "PLAYER"}
          </div>
          <div
            className="font-black tracking-widest uppercase text-center"
            style={{
              fontSize: "clamp(10px, 1.3vw, 15px)",
              color: !isWin && !isDraw ? "#f87171" : "rgba(255,255,255,0.55)",
              maxWidth: 210,
              wordBreak: "break-word",
              lineHeight: 1.2,
              textShadow: "0 2px 8px rgba(0,0,0,0.9)",
            }}
          >
            {enemyName || "OPPONENT"}
          </div>
        </div>

        <div
          style={{
            opacity: showButton ? 1 : 0,
            transform: showButton ? "translateY(0)" : "translateY(12px)",
            transition: "opacity 0.4s, transform 0.4s",
            pointerEvents: showButton ? "auto" : "none",
            position: "absolute",
            bottom: "clamp(16px, 3vh, 30px)",
          }}
        >
          <button
            onClick={onContinue}
            className="px-10 py-3 font-bold rounded-lg text-sm uppercase tracking-widest transition-colors text-[#000000]"
            style={{
              background: "rgba(255,255,255,0.10)",
              border: "1px solid rgba(255,255,255,0.22)",
              color: "#fff",
            }}
            onMouseEnter={e => (e.currentTarget.style.background = "rgba(255,255,255,0.18)")}
            onMouseLeave={e => (e.currentTarget.style.background = "rgba(255,255,255,0.10)")}
            data-testid="button-ceremony-continue"
            autoFocus
          >
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
