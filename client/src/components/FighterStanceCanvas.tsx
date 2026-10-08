import { useRef, useEffect } from "react";
import { BoxingStance, FighterColors } from "@/game/types";
import { renderFighterPreview3D, subscribeFighterPreview } from "@/game/three/fighterPreview3d";

interface FighterStanceCanvasProps {
  colors: FighterColors;
  width?: number;
  height?: number;
  /** Show sparring headgear — used by the colour pickers so the choice is visible. */
  showHeadgear?: boolean;
  /** Orthodox or southpaw. */
  stance?: BoxingStance;
}

/** The player's saved stance (the same key the fight start reads). */
export function playerBoxingStance(): BoxingStance {
  try { return localStorage.getItem("handz_player_boxing_stance") === "southpaw" ? "southpaw" : "orthodox"; } catch { return "orthodox"; }
}

const BOB_SPEED = 2 * 0.8 + 1.0;

/** An idling 3D fighter card. One shared WebGL renderer serves every card (see fighterPreview3d). */
export default function FighterStanceCanvas({ colors, width = 160, height = 192, showHeadgear = false, stance = "orthodox" }: FighterStanceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
  const pxW = Math.round(width * dpr);
  const pxH = Math.round(height * dpr);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    // Only draw while on screen: long roster lists keep most cards idle.
    let onScreen = true;
    const io = typeof IntersectionObserver !== "undefined"
      ? new IntersectionObserver(entries => { for (const e of entries) onScreen = e.isIntersecting; })
      : null;
    io?.observe(canvas);
    // Random start so a list of cards doesn't sway in lockstep.
    const seed = Math.random() * 100;
    const unsubscribe = subscribeFighterPreview(now => {
      const t = now / 1000 + seed;
      renderFighterPreview3D(ctx, {
        colors,
        stance,
        bobPhase: t * BOB_SPEED * Math.PI * 2,
        yaw: Math.sin(t * 0.45) * 0.4,
        headgear: showHeadgear,
      });
    }, () => onScreen && canvas.isConnected);
    return () => { unsubscribe(); io?.disconnect(); };
  }, [colors, width, height, showHeadgear, stance]);

  return (
    <canvas
      ref={canvasRef}
      width={pxW}
      height={pxH}
      className="w-full h-full"
      data-testid="canvas-fighter-preview"
    />
  );
}
