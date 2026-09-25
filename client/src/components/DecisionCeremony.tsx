import { useEffect, useState } from "react";
import { FighterColors } from "@/game/types";
import FighterStanceCanvas from "@/components/FighterStanceCanvas";
import { useEnterKey } from "@/hooks/useEnterKey";

const DEFAULT_RING_COLOR = "#3d2f1e";

interface DecisionCeremonyProps {
  isWin: boolean;
  isDraw: boolean;
  playerName: string;
  enemyName: string;
  playerColors: FighterColors;
  enemyColors: FighterColors;
  ringCanvasColor?: string;
  onContinue: () => void;
}

function CrowdRow({
  y, count, size, fill, opacity,
}: { y: number; count: number; size: number; fill: string; opacity: number }) {
  const items = [];
  for (let i = 0; i < count; i++) {
    const x = (i + 0.5) * (1000 / count) + Math.sin(i * 2.7 + 0.3) * 14;
    const ry = size * (0.85 + Math.sin(i * 1.9) * 0.15);
    items.push(<ellipse key={i} cx={x} cy={y} rx={size * 0.88} ry={ry} fill={fill} />);
  }
  return <g opacity={opacity}>{items}</g>;
}

function RingBackground({ ringColor }: { ringColor: string }) {
  const ropeY1 = 246, ropeY2 = 264, ropeY3 = 282;
  const apronY = 292;
  const floorY = 308;

  return (
    <svg
      style={{ position: "absolute", inset: 0, width: "100%", height: "100%", display: "block" }}
      viewBox="0 0 1000 600"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id="arenaGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#080414" />
          <stop offset="60%" stopColor="#0d0820" />
          <stop offset="100%" stopColor="#12091a" />
        </linearGradient>
        <radialGradient id="spotlight" cx="50%" cy="52%" r="45%">
          <stop offset="0%" stopColor="#fff8e0" stopOpacity="0.10" />
          <stop offset="100%" stopColor="#000" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="floorLight" cx="50%" cy="60%" r="60%">
          <stop offset="0%" stopColor="#fff8e0" stopOpacity="0.12" />
          <stop offset="100%" stopColor="#000" stopOpacity="0" />
        </radialGradient>
      </defs>

      <rect x="0" y="0" width="1000" height="600" fill="url(#arenaGrad)" />

      <CrowdRow y={100} count={22} size={28} fill="#1a1135" opacity={0.55} />
      <CrowdRow y={142} count={19} size={33} fill="#16102e" opacity={0.65} />
      <CrowdRow y={188} count={16} size={38} fill="#120d28" opacity={0.75} />
      <CrowdRow y={234} count={13} size={42} fill="#0e0b22" opacity={0.85} />

      <rect x="0" y="0" width="1000" height={floorY} fill="url(#spotlight)" />

      <rect x="28" y={ropeY1 - 4} width="14" height={apronY - ropeY1 + 8} rx="4" fill="#a0a0a0" />
      <rect x="958" y={ropeY1 - 4} width="14" height={apronY - ropeY1 + 8} rx="4" fill="#a0a0a0" />

      {[ropeY1, ropeY2, ropeY3].map((ry, i) => (
        <line key={i} x1="0" y1={ry} x2="1000" y2={ry}
          stroke="#e8e8e8" strokeWidth="5" opacity={0.88} strokeLinecap="round" />
      ))}

      <rect x="0" y={apronY} width="1000" height={floorY - apronY} fill="#4a1212" />

      <rect x="0" y={floorY} width="1000" height={600 - floorY} fill={ringColor} />
      <rect x="0" y={floorY} width="1000" height={600 - floorY} fill="url(#floorLight)" />

      <line x1="500" y1={floorY} x2="500" y2="600" stroke="rgba(255,255,255,0.06)" strokeWidth="2" />
      <ellipse cx="500" cy={floorY + 20} rx="180" ry="12" fill="rgba(255,255,255,0.05)" />
    </svg>
  );
}

function RefereeFigure({
  armRaisedLeft,
  armRaisedRight,
}: {
  armRaisedLeft: boolean;
  armRaisedRight: boolean;
}) {
  const skin = "#d4a97a";
  return (
    <svg width="192" height="390" viewBox="0 0 64 140" style={{ display: "block", overflow: "visible" }}>
      {/* Head */}
      <ellipse cx="32" cy="12" rx="9" ry="10" fill={skin} />
      {/* Hair */}
      <ellipse cx="32" cy="5" rx="9" ry="5" fill="#2a1a0a" />
      {/* Shirt (white) */}
      <rect x="19" y="22" width="26" height="30" rx="3" fill="#f4f4f4" />
      {/* Shirt front placket */}
      <rect x="30" y="23" width="4" height="29" fill="#e0e0e0" rx="1" />
      {/* Bow tie */}
      <path d="M 28 26 L 32 29 L 36 26 L 32 23 Z" fill="#111" />
      {/* Left arm */}
      <g style={{
        transformOrigin: "20px 30px",
        transform: armRaisedLeft ? "rotate(120deg)" : "rotate(0deg)",
        transition: "transform 0.7s cubic-bezier(0.22,1,0.36,1)",
      }}>
        <rect x="13" y="28" width="8" height="22" rx="4" fill={skin} />
        <ellipse cx="17" cy="51" rx="5" ry="4" fill={skin} />
      </g>
      {/* Right arm */}
      <g style={{
        transformOrigin: "44px 30px",
        transform: armRaisedRight ? "rotate(-120deg)" : "rotate(0deg)",
        transition: "transform 0.7s cubic-bezier(0.22,1,0.36,1)",
      }}>
        <rect x="43" y="28" width="8" height="22" rx="4" fill={skin} />
        <ellipse cx="47" cy="51" rx="5" ry="4" fill={skin} />
      </g>
      {/* Belt */}
      <rect x="19" y="50" width="26" height="5" rx="2" fill="#333" />
      <rect x="29" y="50" width="6" height="5" rx="1" fill="#888" />
      {/* Trousers */}
      <rect x="20" y="55" width="11" height="40" rx="3" fill="#1a1a2e" />
      <rect x="33" y="55" width="11" height="40" rx="3" fill="#1a1a2e" />
      {/* Shoes */}
      <rect x="16" y="92" width="17" height="8" rx="3" fill="#0a0a0a" />
      <rect x="31" y="92" width="17" height="8" rx="3" fill="#0a0a0a" />
    </svg>
  );
}

export default function DecisionCeremony({
  isWin,
  isDraw,
  playerName,
  enemyName,
  playerColors,
  enemyColors,
  ringCanvasColor = DEFAULT_RING_COLOR,
  onContinue,
}: DecisionCeremonyProps) {
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

  const refArmLeft = refArmRaised && isWin && !isDraw;
  const refArmRight = refArmRaised && !isWin && !isDraw;

  return (
    <div
      className="fixed inset-0 select-none overflow-hidden"
      style={{ zIndex: 60 }}
      data-testid="overlay-decision-ceremony"
    >
      <RingBackground ringColor={ringCanvasColor} />
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
          className="flex items-end"
          style={{ gap: "clamp(12px, 2vw, 28px)", paddingBottom: "clamp(60px, 8vh, 100px)" }}
        >
          <div className="flex flex-col items-center" style={{ gap: 8 }}>
            <div style={{ width: 260, height: 520 }}>
              <FighterStanceCanvas colors={playerColors} width={260} height={520} scale={4} />
            </div>
            <div
              className="font-black tracking-widest uppercase text-center"
              style={{
                fontSize: "clamp(9px, 1.1vw, 13px)",
                color: isWin ? "#60a5fa" : "rgba(255,255,255,0.38)",
                maxWidth: 210,
                wordBreak: "break-word",
                lineHeight: 1.2,
              }}
            >
              {playerName || "PLAYER"}
            </div>
          </div>

          <div className="flex flex-col items-center" style={{ gap: 8, marginBottom: 6 }}>
            <RefereeFigure armRaisedLeft={refArmLeft} armRaisedRight={refArmRight} />
            <div
              className="tracking-widest uppercase text-center"
              style={{ fontSize: "clamp(8px, 0.9vw, 11px)", color: "rgba(255,255,255,0.22)" }}
            >
              Ref
            </div>
          </div>

          <div className="flex flex-col items-center" style={{ gap: 8 }}>
            <div style={{ width: 260, height: 520, transform: "scaleX(-1)" }}>
              <FighterStanceCanvas colors={enemyColors} width={260} height={520} scale={4} />
            </div>
            <div
              className="font-black tracking-widest uppercase text-center text-[#00000061]"
              style={{
                fontSize: "clamp(9px, 1.1vw, 13px)",
                color: !isWin && !isDraw ? "#f87171" : "rgba(255,255,255,0.38)",
                maxWidth: 210,
                wordBreak: "break-word",
                lineHeight: 1.2,
              }}
            >
              {enemyName || "OPPONENT"}
            </div>
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
