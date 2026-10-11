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
  /** Drag left/right to spin the fighter a full 360° instead of the idle sway. */
  spinnable?: boolean;
}

/** The player's saved stance (the same key the fight start reads). */
export function playerBoxingStance(): BoxingStance {
  try { return localStorage.getItem("handz_player_boxing_stance") === "southpaw" ? "southpaw" : "orthodox"; } catch { return "orthodox"; }
}

const BOB_SPEED = 2 * 0.8 + 1.0;

/** An idling 3D fighter card. One shared WebGL renderer serves every card (see fighterPreview3d). */
export default function FighterStanceCanvas({ colors, width = 160, height = 192, showHeadgear = false, stance = "orthodox", spinnable = false }: FighterStanceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dpr = Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2);
  const pxW = Math.round(width * dpr);
  const pxH = Math.round(height * dpr);
  // Read live by the draw loop, so a colour edit repaints in place instead of restarting the card.
  const look = useRef({ colors, showHeadgear, stance });
  look.current = { colors, showHeadgear, stance };
  const spin = useRef({ yaw: 0, dragX: null as number | null });
  const spinRef = useRef(spinnable);
  spinRef.current = spinnable;

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
      const { colors, showHeadgear, stance } = look.current;
      renderFighterPreview3D(ctx, {
        colors,
        stance,
        bobPhase: t * BOB_SPEED * Math.PI * 2,
        yaw: spinRef.current ? spin.current.yaw : Math.sin(t * 0.45) * 0.4,
        headgear: showHeadgear,
      });
    }, () => onScreen && canvas.isConnected);
    return () => { unsubscribe(); io?.disconnect(); };
  }, [width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={pxW}
      height={pxH}
      className={spinnable ? "w-full h-full cursor-grab active:cursor-grabbing touch-none" : "w-full h-full"}
      onPointerDown={spinnable ? e => { spin.current.dragX = e.clientX; e.currentTarget.setPointerCapture(e.pointerId); } : undefined}
      onPointerMove={spinnable ? e => {
        const s = spin.current;
        if (s.dragX === null) return;
        s.yaw = (s.yaw + (e.clientX - s.dragX) / width * Math.PI * 2) % (Math.PI * 2);
        s.dragX = e.clientX;
      } : undefined}
      onPointerUp={spinnable ? () => { spin.current.dragX = null; } : undefined}
      onPointerCancel={spinnable ? () => { spin.current.dragX = null; } : undefined}
      data-testid="canvas-fighter-preview"
    />
  );
}
