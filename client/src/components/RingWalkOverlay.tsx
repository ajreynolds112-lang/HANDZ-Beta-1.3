import { useEffect, useRef, useState } from "react";
import { FighterColors } from "@/game/types";
import { cssColorOf } from "@/game/spacialColor";
import { activeRefinementsOnly } from "@/game/engine";

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
  boutDetails?: BoutDetails;
  playerRank?: number;
  onComplete: () => void;
}

type Phase = "arena" | "blueWalk" | "blueRecord" | "redWalk" | "redRecord" | "tape" | "transition";

const MAX_SP = 200;
const STAT_KEYS = [
  { key: "power" as const, label: "Power", short: "PWR", color: "#ef4444" },
  { key: "speed" as const, label: "Speed", short: "SPD", color: "#3b82f6" },
  { key: "defense" as const, label: "Defense", short: "DEF", color: "#22c55e" },
  { key: "stamina" as const, label: "Stamina", short: "STA", color: "#f59e0b" },
  { key: "focus" as const, label: "Focus", short: "FOC", color: "#a855f7" },
];
const REF_KEYS = ["jabPower","hookPower","uppercutPower","ironChin","slippery","guardMaster","duckRecovery","punchRolling","fastTwitch","heartRefinement","chinHitter","technician","lifeDrain","pressureFighter","precisionStriker","bruiser","koArtist"] as const;
const REF_LABELS: Record<string, string> = {
  jabPower: "Straight Punch", hookPower: "Hook Power", uppercutPower: "Uppercut Power", bruiser: "Bruiser", koArtist: "KO Artist",
  ironChin: "Iron Chin", slippery: "Slippery", guardMaster: "Guard Master",
  duckRecovery: "Duck Recovery", punchRolling: "Punch Rolling", fastTwitch: "Fast Twitch",
  heartRefinement: "Heart", chinHitter: "Chin Hitter", technician: "Technician", lifeDrain: "Life Drain",
  pressureFighter: "Pressure Fighter", precisionStriker: "Precision Striker",
};
const CROWD_COLORS = ["#4a2c6e","#2c4a6e","#6e2c2c","#2c6e4a","#3a3a7e","#6e4a2c","#2c6e6e"];
const CAM_LABELS = ["WIDE SHOT", "RINGSIDE", "AERIAL VIEW", "TRACKING SHOT"];

function parseNickname(fullName: string): { baseName: string; nickname?: string } {
  const match = fullName.match(/"([^"]+)"/);
  if (match) {
    return {
      baseName: fullName.replace(`"${match[1]}"`, "").replace(/\s+/g, " ").trim(),
      nickname: match[1],
    };
  }
  return { baseName: fullName };
}

function BoxerSilhouette({ colors, facing, legPose = false }: {
  colors: FighterColors; facing: 1 | -1; legPose?: boolean;
}) {
  const ll = legPose ? -5 : 5;
  const rl = legPose ? 5 : -5;
  return (
    <svg width="80" height="130" viewBox="0 0 80 130"
      style={{ transform: facing === -1 ? "scaleX(-1)" : undefined, display: "block", flexShrink: 0 }}>
      <ellipse cx="40" cy="14" rx="11" ry="13" fill={colors.skin} />
      <rect x="27" y="27" width="26" height="28" rx="4" fill={cssColorOf(colors.trunks)} />
      <rect x="25" y="48" width="30" height="20" rx="3" fill={cssColorOf(colors.trunks)} />
      <line x1="27" y1="36" x2="10" y2="48" stroke={colors.skin} strokeWidth="9" strokeLinecap="round" />
      <rect x="9" y="44" width="7" height="11" rx="2" fill={cssColorOf(colors.gloveTape)} transform="rotate(-32 12 50)" />
      <ellipse cx="6" cy="50" rx="9" ry="7.5" fill={cssColorOf(colors.gloves)} />
      <ellipse cx="4" cy="53" rx="4" ry="3" fill={cssColorOf(colors.gloves)} stroke="rgba(0,0,0,0.25)" strokeWidth="0.7" />
      <line x1="53" y1="33" x2="72" y2="24" stroke={colors.skin} strokeWidth="9" strokeLinecap="round" />
      <rect x="68" y="18" width="7" height="11" rx="2" fill={cssColorOf(colors.gloveTape)} transform="rotate(-26 71 23)" />
      <ellipse cx="76" cy="22" rx="9" ry="7.5" fill={cssColorOf(colors.gloves)} />
      <ellipse cx="78" cy="25" rx="4" ry="3" fill={cssColorOf(colors.gloves)} stroke="rgba(0,0,0,0.25)" strokeWidth="0.7" />
      <g style={{ transform: `translateX(${ll}px)`, transition: "transform 0.32s ease-in-out" }}>
        <rect x="27" y="68" width="11" height="36" rx="3" fill={cssColorOf(colors.trunks)} />
        <rect x="27" y="88" width="11" height="12" rx="2" fill={cssColorOf(colors.socks || "#f0f0f0")} />
        <rect x="26" y="94" width="13" height="9" rx="3" fill={cssColorOf(colors.shoes)} />
        <rect x="24" y="100" width="19" height="6" rx="2" fill={cssColorOf(colors.shoes)} />
        <rect x="24" y="105" width="19" height="3" rx="1.5" fill="rgba(0,0,0,0.45)" />
      </g>
      <g style={{ transform: `translateX(${rl}px)`, transition: "transform 0.32s ease-in-out" }}>
        <rect x="42" y="68" width="11" height="36" rx="3" fill={cssColorOf(colors.trunks)} />
        <rect x="42" y="88" width="11" height="12" rx="2" fill={cssColorOf(colors.socks || "#f0f0f0")} />
        <rect x="41" y="94" width="13" height="9" rx="3" fill={cssColorOf(colors.shoes)} />
        <rect x="39" y="100" width="19" height="6" rx="2" fill={cssColorOf(colors.shoes)} />
        <rect x="39" y="105" width="19" height="3" rx="1.5" fill="rgba(0,0,0,0.45)" />
      </g>
    </svg>
  );
}

function ArenaScene({ playerName, enemyName }: { playerName: string; enemyName: string }) {
  const [zoomed, setZoomed] = useState(false);
  const [spotPhase, setSpotPhase] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setZoomed(true), 80);
    const iv = setInterval(() => setSpotPhase(p => !p), 1900);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, []);

  const topCrowd = Array.from({ length: 4 }, (_, r) =>
    Array.from({ length: 22 + r * 3 }, (_, i) => {
      const x = 20 + i * (760 / (22 + r * 3));
      return <ellipse key={`tc-${r}-${i}`} cx={x} cy={28 + r * 18} rx={4 - r * 0.4} ry={3 - r * 0.3}
        fill={CROWD_COLORS[(r * 25 + i) % CROWD_COLORS.length]} opacity={0.65} />;
    })
  );
  const sideCrowd = (side: "l" | "r") => Array.from({ length: 3 }, (_, r) =>
    Array.from({ length: 12 }, (_, j) => {
      const x = side === "l" ? 8 + r * 22 : 792 - r * 22;
      return <ellipse key={`${side}c-${r}-${j}`} cx={x} cy={85 + j * 30} rx={4} ry={3}
        fill={CROWD_COLORS[(r * 12 + j + (side === "r" ? 4 : 0)) % CROWD_COLORS.length]} opacity={0.65} />;
    })
  );

  const pBase = parseNickname(playerName).baseName;
  const eBase = parseNickname(enemyName).baseName;

  return (
    <div style={{ position: "absolute", inset: 0, background: "#06060e" }}>
      <div style={{
        position: "absolute", inset: 0,
        transform: zoomed ? "scale(1.07)" : "scale(1)",
        transition: "transform 2.9s ease-out",
        transformOrigin: "50% 55%",
      }}>
        <svg viewBox="0 0 800 450" width="100%" height="100%" preserveAspectRatio="xMidYMid slice"
          style={{ position: "absolute", inset: 0 }}>
          <defs>
            <radialGradient id="ag" cx="50%" cy="55%" r="48%">
              <stop offset="0%" stopColor="#1a0f3d" stopOpacity="0.75" />
              <stop offset="100%" stopColor="#000" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="rg" cx="50%" cy="50%" r="55%">
              <stop offset="0%" stopColor="#c4a84a" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#c4a84a" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="sp1" cx="22%" cy="0%" r="62%">
              <stop offset="0%" stopColor="#fff8dc" stopOpacity={spotPhase ? "0.16" : "0.07"} />
              <stop offset="100%" stopColor="#fff8dc" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="sp2" cx="50%" cy="0%" r="55%">
              <stop offset="0%" stopColor="#fff8dc" stopOpacity={spotPhase ? "0.09" : "0.18"} />
              <stop offset="100%" stopColor="#fff8dc" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="sp3" cx="78%" cy="0%" r="60%">
              <stop offset="0%" stopColor="#fff8dc" stopOpacity={spotPhase ? "0.18" : "0.08"} />
              <stop offset="100%" stopColor="#fff8dc" stopOpacity="0" />
            </radialGradient>
          </defs>
          <rect width="800" height="450" fill="#06060e" />
          {topCrowd}
          {sideCrowd("l")}
          {sideCrowd("r")}
          <rect x="245" y="162" width="310" height="175" rx="4" fill="#131325" stroke="#333355" strokeWidth="2" />
          <rect x="253" y="170" width="294" height="159" rx="2" fill="#c4a84a" opacity="0.06" />
          <rect x="245" y="178" width="310" height="5" rx="2" fill="#cc4444" opacity="0.9" />
          <rect x="245" y="208" width="310" height="4" rx="2" fill="#cc4444" opacity="0.9" />
          <rect x="245" y="236" width="310" height="4" rx="2" fill="#4444cc" opacity="0.9" />
          <rect x="241" y="155" width="8" height="100" rx="3" fill="#999" opacity="0.75" />
          <rect x="551" y="155" width="8" height="100" rx="3" fill="#999" opacity="0.75" />
          <rect x="241" y="290" width="8" height="50" rx="3" fill="#999" opacity="0.75" />
          <rect x="551" y="290" width="8" height="50" rx="3" fill="#999" opacity="0.75" />
          <rect x="200" y="130" width="400" height="240" fill="url(#rg)" />
          <rect width="800" height="450" fill="url(#ag)" />
          <rect width="800" height="450" fill="url(#sp1)" style={{ transition: "opacity 1.9s ease-in-out" }} />
          <rect width="800" height="450" fill="url(#sp2)" style={{ transition: "opacity 1.9s ease-in-out" }} />
          <rect width="800" height="450" fill="url(#sp3)" style={{ transition: "opacity 1.9s ease-in-out" }} />
        </svg>
      </div>
      <div style={{ position: "relative", zIndex: 2, height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", pointerEvents: "none" }}>
        <div style={{ fontSize: "10px", fontWeight: 900, letterSpacing: "0.5em", color: "#b45309", textTransform: "uppercase", marginBottom: "8px" }}>
          MAIN EVENT TONIGHT
        </div>
        <div style={{ height: 1, width: 120, background: "linear-gradient(90deg, transparent, #b45309, transparent)", marginBottom: "18px" }} />
        <div style={{ fontSize: "clamp(18px, 3.5vw, 30px)", fontWeight: 900, color: "#fff", textShadow: "0 0 40px rgba(255,200,100,0.5)", letterSpacing: "0.06em", textTransform: "uppercase", textAlign: "center", padding: "0 16px" }}>
          {pBase}
          <span style={{ color: "#555", fontSize: "0.5em", margin: "0 12px" }}>VS</span>
          {eBase}
        </div>
      </div>
    </div>
  );
}

function WalkBg({ shot }: { shot: number }) {
  return (
    <svg viewBox="0 0 800 500" width="100%" height="100%" style={{ position: "absolute", inset: 0 }} preserveAspectRatio="xMidYMid slice">
      <rect width="800" height="500" fill="#06060c" />
      {shot === 0 && <>
        <defs>
          <linearGradient id="af" x1="50%" y1="100%" x2="50%" y2="0%">
            <stop offset="0%" stopColor="#161008" />
            <stop offset="100%" stopColor="#080604" />
          </linearGradient>
        </defs>
        <polygon points="400,140 130,500 670,500" fill="url(#af)" />
        <line x1="400" y1="140" x2="130" y2="500" stroke="#222" strokeWidth="2" />
        <line x1="400" y1="140" x2="670" y2="500" stroke="#222" strokeWidth="2" />
        <rect x="325" y="90" width="150" height="65" rx="2" fill="#11112a" stroke="#3a3a6e" strokeWidth="1.5" />
        <line x1="325" y1="106" x2="475" y2="106" stroke="#cc4444" strokeWidth="2.5" />
        <line x1="325" y1="120" x2="475" y2="120" stroke="#cc4444" strokeWidth="2" />
        <line x1="325" y1="133" x2="475" y2="133" stroke="#4444cc" strokeWidth="2" />
        {Array.from({ length: 40 }, (_, i) => <ellipse key={i} cx={((i * 173) % 180) + (i < 20 ? 10 : 610)} cy={100 + ((i * 97) % 350)} rx={5} ry={4} fill={CROWD_COLORS[i % CROWD_COLORS.length]} opacity={0.6} />)}
        <ellipse cx="400" cy="250" rx="100" ry="180" fill="#fff8dc" opacity="0.04" />
      </>}
      {shot === 1 && <>
        <rect x="0" y="115" width="420" height="240" fill="#11112a" />
        <rect x="0" y="133" width="420" height="5" rx="2" fill="#cc4444" opacity="0.9" />
        <rect x="0" y="163" width="420" height="4" rx="2" fill="#cc4444" opacity="0.9" />
        <rect x="0" y="192" width="420" height="4" rx="2" fill="#4444cc" opacity="0.9" />
        <rect x="416" y="108" width="8" height="145" rx="3" fill="#888" opacity="0.8" />
        {Array.from({ length: 60 }, (_, i) => <ellipse key={i} cx={450 + ((i * 113) % 330)} cy={45 + ((i * 79) % 380)} rx={6} ry={5} fill={CROWD_COLORS[i % CROWD_COLORS.length]} opacity={0.65} />)}
        <rect x="0" y="355" width="800" height="145" fill="#0c0c0c" />
        <rect x="0" y="355" width="420" height="5" fill="#2a2a2a" />
      </>}
      {shot === 2 && <>
        <defs>
          <radialGradient id="aerGl" cx="50%" cy="55%" r="45%">
            <stop offset="0%" stopColor="#1a0f3d" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#000" stopOpacity="0" />
          </radialGradient>
        </defs>
        {Array.from({ length: 4 }, (_, r) => Array.from({ length: 28 }, (_, i) => {
          const a = (i / 28) * Math.PI * 2;
          return <ellipse key={`${r}-${i}`} cx={400 + Math.cos(a) * (240 + r * 65)} cy={230 + Math.sin(a) * (90 + r * 30)} rx={5} ry={4} fill={CROWD_COLORS[(r * 28 + i) % CROWD_COLORS.length]} opacity={0.65} />;
        }))}
        <rect x="360" y="0" width="80" height="320" fill="#0e0e18" opacity="0.85" />
        <rect x="300" y="290" width="200" height="120" rx="4" fill="#131325" stroke="#3a3a6e" strokeWidth="2" />
        <rect x="308" y="298" width="184" height="104" rx="2" fill="#c4a84a" opacity="0.06" />
        <rect x="300" y="305" width="200" height="4" rx="2" fill="#cc4444" opacity="0.7" />
        <rect x="300" y="320" width="200" height="3" rx="2" fill="#cc4444" opacity="0.7" />
        <rect x="300" y="334" width="200" height="3" rx="2" fill="#4444cc" opacity="0.7" />
        <rect width="800" height="500" fill="url(#aerGl)" />
      </>}
      {shot === 3 && <>
        <line x1="80" y1="215" x2="720" y2="215" stroke="#cc4444" strokeWidth="4.5" opacity="0.65" />
        <line x1="60" y1="252" x2="740" y2="252" stroke="#cc4444" strokeWidth="4" opacity="0.65" />
        <line x1="40" y1="286" x2="760" y2="286" stroke="#4444cc" strokeWidth="4" opacity="0.65" />
        <rect x="38" y="175" width="10" height="155" rx="4" fill="#aaa" opacity="0.6" />
        <rect x="752" y="175" width="10" height="155" rx="4" fill="#aaa" opacity="0.6" />
        {Array.from({ length: 32 }, (_, i) => <ellipse key={i} cx={((i * 257) % 780) + 10} cy={((i * 181) % 140) + 40} rx={7} ry={5} fill={CROWD_COLORS[i % CROWD_COLORS.length]} opacity={0.45} />)}
        <ellipse cx="400" cy="350" rx="280" ry="100" fill="#c4a84a" opacity="0.04" />
        <ellipse cx="400" cy="250" rx="190" ry="240" fill="#fff8dc" opacity="0.04" />
      </>}
    </svg>
  );
}

function WalkScene({ colors, corner, cameraShot, walkProgress, legPose, visible }: {
  colors: FighterColors; corner: "blue" | "red"; cameraShot: number;
  walkProgress: number; legPose: boolean; visible: boolean;
}) {
  const cornerColor = corner === "blue" ? "#3b82f6" : "#ef4444";

  const getTransform = () => {
    const p = walkProgress;
    switch (cameraShot) {
      case 0: return { scale: 0.28 + p * 1.12, xOff: 0, yOff: -100 + p * 140, yBase: "55%" };
      case 1: return { scale: 0.75 + p * 0.3, xOff: corner === "blue" ? (-180 + p * 280) : (180 - p * 280), yOff: 30, yBase: "58%" };
      case 2: return { scale: 0.18 + p * 0.22, xOff: 0, yOff: -120 + p * 140, yBase: "40%" };
      case 3: return { scale: 1.1 + p * 0.55, xOff: 0, yOff: p * 50, yBase: "65%" };
      default: return { scale: 1, xOff: 0, yOff: 0, yBase: "55%" };
    }
  };
  const { scale, xOff, yOff, yBase } = getTransform();
  const facingDir: 1 | -1 = cameraShot === 3 ? (corner === "blue" ? -1 : 1) : (corner === "blue" ? 1 : -1);

  return (
    <div style={{ position: "absolute", inset: 0, opacity: visible ? 1 : 0, transition: "opacity 0.22s ease" }}>
      <WalkBg shot={cameraShot} />
      <div style={{ position: "absolute", top: 10, left: 14, fontSize: "9px", fontWeight: 700, letterSpacing: "0.2em", color: "rgba(255,255,255,0.25)", textTransform: "uppercase" }}>
        {CAM_LABELS[cameraShot]}
      </div>
      <div style={{ position: "absolute", top: 10, right: 90, fontSize: "10px", fontWeight: 900, letterSpacing: "0.22em", color: cornerColor, textTransform: "uppercase", textShadow: `0 0 14px ${cornerColor}` }}>
        {corner === "blue" ? "BLUE CORNER" : "RED CORNER"}
      </div>
      <div style={{
        position: "absolute", left: "50%", top: yBase,
        transform: `translateX(calc(-50% + ${xOff}px)) translateY(calc(-50% + ${yOff}px)) scale(${scale})`,
        transformOrigin: "center bottom",
        transition: "transform 0.12s linear",
        filter: `drop-shadow(0 0 18px ${cornerColor}88)`,
        zIndex: 5,
      }}>
        <BoxerSilhouette colors={colors} facing={facingDir} legPose={legPose} />
      </div>
    </div>
  );
}

function RecordCard({ name, nickname, rank, wins, losses, draws, kos, level, corner, visible }: {
  name: string; nickname?: string; rank?: number;
  wins: number; losses: number; draws: number; kos: number; level: number;
  corner: "blue" | "red"; visible: boolean;
}) {
  const { baseName, nickname: parsedNick } = parseNickname(name);
  const displayNick = nickname ?? parsedNick;
  const cornerColor = corner === "blue" ? "#3b82f6" : "#ef4444";
  const cornerGlow = corner === "blue" ? "rgba(59,130,246,0.35)" : "rgba(239,68,68,0.35)";
  const isChamp = rank === 1;

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.88)" }}>
      <div style={{
        transform: visible ? "translateY(0) scale(1)" : "translateY(55px) scale(0.97)",
        opacity: visible ? 1 : 0,
        transition: "transform 0.6s cubic-bezier(0.22,1,0.36,1), opacity 0.45s ease-out",
        width: "min(430px, 90vw)",
        padding: "28px 26px 24px",
        background: "linear-gradient(140deg, #09091a 0%, #0d0d20 100%)",
        border: `1px solid ${cornerColor}33`,
        borderLeft: `4px solid ${cornerColor}`,
        borderRadius: "4px",
        boxShadow: `0 0 70px ${cornerGlow}, 0 24px 50px rgba(0,0,0,0.85)`,
      }}>
        <div style={{ fontSize: "9px", fontWeight: 900, letterSpacing: "0.4em", color: cornerColor, textTransform: "uppercase", marginBottom: "18px", display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{ width: 18, height: 2, background: cornerColor, display: "inline-block", borderRadius: 1 }} />
          {corner === "blue" ? "BLUE CORNER" : "RED CORNER"}
        </div>
        <div style={{ fontSize: "clamp(20px, 4.5vw, 36px)", fontWeight: 900, color: "#fff", textTransform: "uppercase", letterSpacing: "0.03em", lineHeight: 1.1, marginBottom: displayNick ? "6px" : "14px", textShadow: `0 0 28px ${cornerGlow}` }}>
          {baseName}
        </div>
        {displayNick && (
          <div style={{ fontSize: "13px", fontStyle: "italic", color: "rgba(255,255,255,0.45)", marginBottom: "14px", letterSpacing: "0.05em" }}>
            "{displayNick}"
          </div>
        )}
        {isChamp ? (
          <div style={{ display: "inline-block", marginBottom: "20px", padding: "4px 14px", background: "linear-gradient(135deg, #7c2d12, #b45309)", color: "#ffd700", fontWeight: 900, fontSize: "10px", letterSpacing: "0.25em", textTransform: "uppercase", borderRadius: "2px", boxShadow: "0 0 18px rgba(180,83,9,0.5)" }}>
            ★ UNDISPUTED CHAMPION
          </div>
        ) : rank != null ? (
          <div style={{ display: "inline-block", marginBottom: "20px", padding: "3px 12px", border: `1px solid ${cornerColor}55`, color: cornerColor, fontWeight: 900, fontSize: "10px", letterSpacing: "0.22em", textTransform: "uppercase", borderRadius: "2px" }}>
            RANK #{rank}
          </div>
        ) : (
          <div style={{ marginBottom: "20px" }} />
        )}
        <div style={{ height: 1, background: `linear-gradient(90deg, ${cornerColor}55, transparent)`, marginBottom: "20px" }} />
        <div style={{ display: "flex", gap: "28px", flexWrap: "wrap" }}>
          <div>
            <div style={{ fontSize: "8px", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: "4px" }}>Record</div>
            <div style={{ fontSize: "clamp(22px, 5vw, 34px)", fontWeight: 900, color: "#fff", letterSpacing: "0.03em" }}>
              {wins}<span style={{ color: "rgba(255,255,255,0.25)", fontSize: "0.55em" }}>-</span>{losses}<span style={{ color: "rgba(255,255,255,0.25)", fontSize: "0.55em" }}>-</span>{draws}
            </div>
          </div>
          {kos > 0 && (
            <div>
              <div style={{ fontSize: "8px", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: "4px" }}>KOs</div>
              <div style={{ fontSize: "clamp(22px, 5vw, 34px)", fontWeight: 900, color: "#ef4444" }}>{kos}</div>
            </div>
          )}
          <div>
            <div style={{ fontSize: "8px", color: "rgba(255,255,255,0.3)", textTransform: "uppercase", letterSpacing: "0.15em", marginBottom: "4px" }}>Level</div>
            <div style={{ fontSize: "clamp(22px, 5vw, 34px)", fontWeight: 900, color: "#fbbf24" }}>{level}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TaleOfTape({
  playerName, playerNickname, playerRank, playerWins, playerLosses, playerDraws, playerKOs, playerLevel, playerSp, playerRefinement,
  enemyName, enemyRank, enemyWins, enemyLosses, enemyDraws, enemyKOs, enemyLevel, enemySp, enemyRefinement,
  visible,
}: {
  playerName: string; playerNickname?: string; playerRank?: number;
  playerWins: number; playerLosses: number; playerDraws: number; playerKOs: number; playerLevel: number;
  playerSp?: SkillPoints; playerRefinement?: Record<string, number>;
  enemyName: string; enemyRank?: number;
  enemyWins: number; enemyLosses: number; enemyDraws: number; enemyKOs: number; enemyLevel: number;
  enemySp?: SkillPoints; enemyRefinement?: Record<string, number>;
  visible: boolean;
}) {
  const { baseName: pBase, nickname: pParsedNick } = parseNickname(playerName);
  const pNick = playerNickname ?? pParsedNick;
  const { baseName: eBase, nickname: eNick } = parseNickname(enemyName);
  // Only what each corner is actually bringing into the ring, same filter Bout
  // Details uses so the two screens never disagree: the player's own pick list
  // decides theirs, an opponent map has none so its five highest stand in. The
  // rows shown are the union of the two, and with neither corner bringing
  // anything the section is left out entirely rather than listing zeros.
  const pActiveRef = activeRefinementsOnly(playerRefinement as Record<string, unknown> | undefined, true) as Record<string, number> | undefined;
  const eActiveRef = activeRefinementsOnly(enemyRefinement as Record<string, unknown> | undefined) as Record<string, number> | undefined;
  const shownRefKeys = REF_KEYS.filter(k => (pActiveRef?.[k] ?? 0) > 0 || (eActiveRef?.[k] ?? 0) > 0);
  const showRefinements = (enemyRank ?? 999) <= 650 && shownRefKeys.length > 0;

  const labelRows: Array<{ label: string; pVal: string | number; eVal: string | number; color: string }> = [
    { label: "LEVEL", pVal: playerLevel, eVal: enemyLevel, color: "#fbbf24" },
    { label: "RANK", pVal: playerRank != null ? `#${playerRank}` : "—", eVal: enemyRank != null ? `#${enemyRank}` : "—", color: "#a78bfa" },
    { label: "RECORD", pVal: `${playerWins}-${playerLosses}-${playerDraws}`, eVal: `${enemyWins}-${enemyLosses}-${enemyDraws}`, color: "#e2e8f0" },
    { label: "KOs", pVal: playerKOs, eVal: enemyKOs, color: "#ef4444" },
  ];

  return (
    <div style={{ position: "absolute", inset: 0, background: "linear-gradient(180deg, #070710 0%, #0a0a1a 100%)", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", padding: "20px 12px", overflowY: "auto" }}>
      <div style={{ opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(-18px)", transition: "opacity 0.5s, transform 0.5s", textAlign: "center", marginBottom: "16px", paddingTop: "8px" }}>
        <div style={{ fontSize: "clamp(14px, 3vw, 26px)", fontWeight: 900, color: "#fbbf24", letterSpacing: "0.3em", textTransform: "uppercase", textShadow: "0 0 30px rgba(251,191,36,0.5)" }}>
          TALE OF THE TAPE
        </div>
        <div style={{ height: 1, width: 200, margin: "7px auto 0", background: "linear-gradient(90deg, transparent, #fbbf24, transparent)" }} />
      </div>

      <div style={{ width: "min(680px, 96vw)", display: "grid", gridTemplateColumns: "1fr 44px 1fr", gap: "0 8px", marginBottom: "8px", opacity: visible ? 1 : 0, transition: "opacity 0.5s 0.08s" }}>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: "clamp(11px, 2.3vw, 17px)", fontWeight: 900, color: "#fff", textTransform: "uppercase", lineHeight: 1.1 }}>{pBase}</div>
          {pNick && <div style={{ fontSize: "10px", fontStyle: "italic", color: "rgba(255,255,255,0.38)", marginTop: "2px" }}>"{pNick}"</div>}
        </div>
        <div />
        <div style={{ textAlign: "left" }}>
          <div style={{ fontSize: "clamp(11px, 2.3vw, 17px)", fontWeight: 900, color: "#fff", textTransform: "uppercase", lineHeight: 1.1 }}>{eBase}</div>
          {eNick && <div style={{ fontSize: "10px", fontStyle: "italic", color: "rgba(255,255,255,0.38)", marginTop: "2px" }}>"{eNick}"</div>}
        </div>
      </div>

      <div style={{ width: "min(680px, 96vw)", display: "grid", gridTemplateColumns: "1fr 44px 1fr", gap: "0 8px", marginBottom: "12px", opacity: visible ? 1 : 0, transition: "opacity 0.5s 0.12s" }}>
        <div style={{ height: 3, background: "#3b82f6", borderRadius: 2 }} />
        <div />
        <div style={{ height: 3, background: "#ef4444", borderRadius: 2 }} />
      </div>

      <div style={{ width: "min(680px, 96vw)", display: "flex", flexDirection: "column", gap: "6px" }}>
        {labelRows.map((row, i) => (
          <div key={row.label} style={{
            display: "grid", gridTemplateColumns: "1fr 44px 1fr", gap: "0 8px",
            opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(10px)",
            transition: `opacity 0.4s ${0.18 + i * 0.06}s, transform 0.4s ${0.18 + i * 0.06}s`,
          }}>
            <div style={{ textAlign: "right", fontSize: "clamp(12px, 2.5vw, 20px)", fontWeight: 900, color: row.color }}>{row.pVal}</div>
            <div style={{ textAlign: "center", fontSize: "7px", fontWeight: 700, letterSpacing: "0.1em", color: "rgba(255,255,255,0.28)", textTransform: "uppercase", display: "flex", alignItems: "center", justifyContent: "center" }}>{row.label}</div>
            <div style={{ textAlign: "left", fontSize: "clamp(12px, 2.5vw, 20px)", fontWeight: 900, color: row.color }}>{row.eVal}</div>
          </div>
        ))}

        {/* SP stat bars */}
        <div style={{ height: 1, background: "rgba(255,255,255,0.07)", margin: "3px 0" }} />
        {STAT_KEYS.map((sk, i) => {
          const pv = playerSp?.[sk.key] ?? 0;
          const ev = enemySp?.[sk.key] ?? 0;
          const pPct = Math.min(100, (pv / MAX_SP) * 100);
          const ePct = Math.min(100, (ev / MAX_SP) * 100);
          const delay = 0.18 + (labelRows.length + 1 + i) * 0.055;
          return (
            <div key={sk.key} style={{
              display: "grid", gridTemplateColumns: "1fr 44px 1fr", gap: "0 8px", alignItems: "center",
              opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(8px)",
              transition: `opacity 0.4s ${delay}s, transform 0.4s ${delay}s`,
            }}>
              <div style={{ display: "flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}>
                <span style={{ fontSize: "10px", fontWeight: 700, color: "rgba(255,255,255,0.8)", minWidth: 22, textAlign: "right" }}>{pv}</span>
                <div style={{ width: 90, height: 5, background: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden", display: "flex", justifyContent: "flex-end" }}>
                  <div style={{ height: "100%", width: `${pPct}%`, background: sk.color, borderRadius: 3 }} />
                </div>
              </div>
              <div style={{ textAlign: "center", fontSize: "7px", fontWeight: 700, letterSpacing: "0.09em", color: "rgba(255,255,255,0.28)", textTransform: "uppercase" }}>{sk.short}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <div style={{ width: 90, height: 5, background: "rgba(255,255,255,0.08)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ height: "100%", width: `${ePct}%`, background: sk.color, borderRadius: 3 }} />
                </div>
                <span style={{ fontSize: "10px", fontWeight: 700, color: "rgba(255,255,255,0.8)", minWidth: 22 }}>{ev}</span>
              </div>
            </div>
          );
        })}

        {/* Refinements (shown when opponent rank ≤ 650) */}
        {showRefinements && (
          <>
            <div style={{ height: 1, background: "rgba(168,85,247,0.2)", margin: "4px 0" }} />
            <div style={{
              textAlign: "center", fontSize: "7px", fontWeight: 700, letterSpacing: "0.18em",
              color: "rgba(168,85,247,0.5)", textTransform: "uppercase", marginBottom: "2px",
              opacity: visible ? 1 : 0, transition: "opacity 0.4s 0.7s",
            }}>
              REFINEMENTS
            </div>
            {shownRefKeys.map((k, i) => {
              const pv = pActiveRef?.[k] ?? 0;
              const ev = eActiveRef?.[k] ?? 0;
              const delay = 0.72 + i * 0.04;
              return (
                <div key={k} style={{
                  display: "grid", gridTemplateColumns: "1fr 44px 1fr", gap: "0 8px", alignItems: "center",
                  opacity: visible ? 1 : 0, transform: visible ? "translateY(0)" : "translateY(6px)",
                  transition: `opacity 0.35s ${delay}s, transform 0.35s ${delay}s`,
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, justifyContent: "flex-end" }}>
                    <span style={{ fontSize: "9px", fontWeight: pv > 0 ? 700 : 400, color: pv > 0 ? "#c084fc" : "rgba(255,255,255,0.2)", minWidth: 20, textAlign: "right" }}>{pv}</span>
                    <div style={{ width: 80, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden", display: "flex", justifyContent: "flex-end" }}>
                      <div style={{ height: "100%", width: `${pv}%`, background: "#a855f7", borderRadius: 2, opacity: pv > 0 ? 1 : 0 }} />
                    </div>
                  </div>
                  <div style={{ textAlign: "center", fontSize: "6px", fontWeight: 600, letterSpacing: "0.05em", color: "rgba(255,255,255,0.22)", textTransform: "uppercase", lineHeight: 1.2 }}>
                    {REF_LABELS[k].split(" ").map((w, wi) => <span key={wi} style={{ display: "block" }}>{w}</span>)}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <div style={{ width: 80, height: 4, background: "rgba(255,255,255,0.06)", borderRadius: 2, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${ev}%`, background: "#a855f7", borderRadius: 2, opacity: ev > 0 ? 1 : 0 }} />
                    </div>
                    <span style={{ fontSize: "9px", fontWeight: ev > 0 ? 700 : 400, color: ev > 0 ? "#c084fc" : "rgba(255,255,255,0.2)", minWidth: 20 }}>{ev}</span>
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function TransitionScene({ playerColors, enemyColors, zoomed, fadeOut }: {
  playerColors: FighterColors; enemyColors: FighterColors; zoomed: boolean; fadeOut: boolean;
}) {
  return (
    <div style={{ position: "absolute", inset: 0, background: "#080810", display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
      <div style={{ position: "absolute", top: "28%", left: 0, right: 0, height: 5, background: "rgba(204,68,68,0.45)" }} />
      <div style={{ position: "absolute", top: "36%", left: 0, right: 0, height: 4, background: "rgba(204,68,68,0.4)" }} />
      <div style={{ position: "absolute", top: "44%", left: 0, right: 0, height: 4, background: "rgba(68,68,204,0.4)" }} />
      <div style={{ position: "absolute", inset: 0, background: "radial-gradient(ellipse at 50% 60%, rgba(255,248,200,0.07) 0%, transparent 65%)" }} />
      <div style={{
        transform: zoomed ? "scale(1.38)" : "scale(1)",
        transition: "transform 2.1s ease-in",
        display: "flex", alignItems: "flex-end", gap: 10, position: "relative", zIndex: 2,
      }}>
        <div style={{ transform: "scale(1.9)", transformOrigin: "bottom center" }}>
          <BoxerSilhouette colors={playerColors} facing={1} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", marginBottom: 4 }}>
          <div style={{ width: 16, height: 16, borderRadius: "50%", background: "rgba(255,255,255,0.18)", marginBottom: 3 }} />
          <div style={{ width: 12, height: 62, background: "rgba(255,255,255,0.14)", borderRadius: 3 }} />
          <div style={{ width: 20, height: 14, background: "rgba(255,255,255,0.1)", borderRadius: 2, marginTop: 2 }} />
        </div>
        <div style={{ transform: "scale(1.9)", transformOrigin: "bottom center" }}>
          <BoxerSilhouette colors={enemyColors} facing={-1} />
        </div>
      </div>
      <div style={{ position: "absolute", inset: 0, background: "#000", opacity: fadeOut ? 1 : 0, transition: "opacity 0.75s ease-in", pointerEvents: "none" }} />
    </div>
  );
}

export default function RingWalkOverlay({
  playerName, enemyName, playerNickname, playerColors, enemyColors, boutDetails, playerRank, onComplete,
}: RingWalkOverlayProps) {
  const [phase, setPhase] = useState<Phase>("arena");
  const [overlayOpacity, setOverlayOpacity] = useState(0);
  const [cameraShot, setCameraShot] = useState(0);
  const [shotVisible, setShotVisible] = useState(true);
  const [walkProgress, setWalkProgress] = useState(0);
  const [legPose, setLegPose] = useState(false);
  const [cardVisible, setCardVisible] = useState(false);
  const [tapeVisible, setTapeVisible] = useState(false);
  const [transZoomed, setTransZoomed] = useState(false);
  const [transFadeOut, setTransFadeOut] = useState(false);

  const phaseTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const activeIntervals = useRef<ReturnType<typeof setInterval>[]>([]);
  const skipped = useRef(false);

  const clearIntervals = () => {
    activeIntervals.current.forEach(clearInterval);
    activeIntervals.current = [];
  };
  const clearAll = () => {
    phaseTimers.current.forEach(clearTimeout);
    activeIntervals.current.forEach(clearInterval);
    phaseTimers.current = [];
    activeIntervals.current = [];
  };

  const sched = (fn: () => void, ms: number) => {
    const id = setTimeout(() => { if (!skipped.current) fn(); }, ms);
    phaseTimers.current.push(id);
  };
  const addIv = (fn: () => void, ms: number) => {
    const id = setInterval(() => { if (!skipped.current) fn(); }, ms);
    activeIntervals.current.push(id);
  };

  const startWalkPhase = (corner: "blue" | "red") => {
    const startShot = corner === "blue" ? 0 : 2;
    setWalkProgress(0);
    setLegPose(false);
    setCameraShot(startShot);
    setShotVisible(true);
    addIv(() => setWalkProgress(p => Math.min(1, p + 0.02)), 100);
    addIv(() => setLegPose(p => !p), 340);
    let shotIdx = startShot;
    const shotMs = corner === "blue" ? 1250 : 1380;
    addIv(() => {
      shotIdx = (shotIdx + 1) % 4;
      setShotVisible(false);
      const t = setTimeout(() => { if (!skipped.current) { setCameraShot(shotIdx); setShotVisible(true); } }, 210);
      phaseTimers.current.push(t);
    }, shotMs);
  };

  useEffect(() => {
    const initFade = setTimeout(() => setOverlayOpacity(1), 40);
    phaseTimers.current.push(initFade);

    let t = 0;
    t += 2800;

    sched(() => { clearIntervals(); setPhase("blueWalk"); startWalkPhase("blue"); }, t);
    t += 5000;

    sched(() => {
      clearIntervals(); setPhase("blueRecord"); setCardVisible(false);
      const ct = setTimeout(() => { if (!skipped.current) setCardVisible(true); }, 80);
      phaseTimers.current.push(ct);
    }, t);
    t += 3200;

    sched(() => { clearIntervals(); setPhase("redWalk"); startWalkPhase("red"); }, t);
    t += 5000;

    sched(() => {
      clearIntervals(); setPhase("redRecord"); setCardVisible(false);
      const ct = setTimeout(() => { if (!skipped.current) setCardVisible(true); }, 80);
      phaseTimers.current.push(ct);
    }, t);
    t += 3200;

    sched(() => {
      clearIntervals(); setPhase("tape"); setTapeVisible(false);
      const ct = setTimeout(() => { if (!skipped.current) setTapeVisible(true); }, 80);
      phaseTimers.current.push(ct);
    }, t);
    t += 5200;

    sched(() => {
      clearIntervals(); setPhase("transition");
      setTransZoomed(false); setTransFadeOut(false);
      const z = setTimeout(() => { if (!skipped.current) setTransZoomed(true); }, 80);
      const f = setTimeout(() => { if (!skipped.current) setTransFadeOut(true); }, 1850);
      phaseTimers.current.push(z, f);
    }, t);
    t += 2700;

    sched(() => { clearAll(); onComplete(); }, t);

    return clearAll;
  }, []);

  const handleSkip = () => {
    if (skipped.current) return;
    skipped.current = true;
    clearAll();
    onComplete();
  };

  const bd = boutDetails;
  const isBlue = phase === "blueWalk" || phase === "blueRecord";

  return (
    <div
      data-testid="overlay-ring-walk"
      style={{
        position: "fixed", inset: 0, zIndex: 60, overflow: "hidden",
        background: "#06060e",
        opacity: overlayOpacity,
        transition: "opacity 0.4s ease-out",
        userSelect: "none",
      }}
    >
      {phase === "arena" && <ArenaScene playerName={playerName} enemyName={enemyName} />}

      {(phase === "blueWalk" || phase === "redWalk") && (
        <WalkScene
          colors={isBlue ? playerColors : enemyColors}
          corner={isBlue ? "blue" : "red"}
          cameraShot={cameraShot}
          walkProgress={walkProgress}
          legPose={legPose}
          visible={shotVisible}
        />
      )}

      {phase === "blueRecord" && bd && (
        <RecordCard
          name={playerName} nickname={playerNickname} rank={playerRank}
          wins={bd.playerWins} losses={bd.playerLosses} draws={bd.playerDraws}
          kos={bd.playerKOs} level={bd.playerLevel}
          corner="blue" visible={cardVisible}
        />
      )}

      {phase === "redRecord" && bd && (
        <RecordCard
          name={enemyName} rank={bd.enemyRank}
          wins={bd.enemyWins} losses={bd.enemyLosses} draws={bd.enemyDraws}
          kos={bd.enemyKOs} level={bd.enemyLevel}
          corner="red" visible={cardVisible}
        />
      )}

      {phase === "tape" && bd && (
        <TaleOfTape
          playerName={playerName} playerNickname={playerNickname} playerRank={playerRank}
          playerWins={bd.playerWins} playerLosses={bd.playerLosses} playerDraws={bd.playerDraws}
          playerKOs={bd.playerKOs} playerLevel={bd.playerLevel}
          playerSp={bd.playerSp} playerRefinement={bd.playerRefinement}
          enemyName={enemyName} enemyRank={bd.enemyRank}
          enemyWins={bd.enemyWins} enemyLosses={bd.enemyLosses} enemyDraws={bd.enemyDraws}
          enemyKOs={bd.enemyKOs} enemyLevel={bd.enemyLevel}
          enemySp={bd.enemySp} enemyRefinement={bd.enemyRefinement}
          visible={tapeVisible}
        />
      )}

      {phase === "transition" && (
        <TransitionScene
          playerColors={playerColors} enemyColors={enemyColors}
          zoomed={transZoomed} fadeOut={transFadeOut}
        />
      )}

      <button
        data-testid="button-ring-walk-skip"
        onClick={handleSkip}
        style={{
          position: "fixed", top: 14, right: 16, zIndex: 70,
          padding: "6px 16px",
          background: "rgba(0,0,0,0.55)",
          border: "1px solid rgba(255,255,255,0.2)",
          borderRadius: "20px",
          color: "rgba(255,255,255,0.55)",
          fontSize: "11px", fontWeight: 700, letterSpacing: "0.15em",
          cursor: "pointer", textTransform: "uppercase",
          backdropFilter: "blur(4px)",
          transition: "color 0.2s, border-color 0.2s",
        }}
        onMouseEnter={e => { (e.target as HTMLButtonElement).style.color = "rgba(255,255,255,0.9)"; (e.target as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.5)"; }}
        onMouseLeave={e => { (e.target as HTMLButtonElement).style.color = "rgba(255,255,255,0.55)"; (e.target as HTMLButtonElement).style.borderColor = "rgba(255,255,255,0.2)"; }}
      >
        SKIP ›
      </button>
    </div>
  );
}
