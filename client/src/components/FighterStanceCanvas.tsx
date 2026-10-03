import { useRef, useEffect } from "react";
import { BoxingStance, FighterColors } from "@/game/types";
import { renderFighterPreview } from "@/game/renderer";
import { getGraphicsMode } from "@/game/graphicsSetting";
import { fighterPreview3DAvailable, renderFighterPreview3D, subscribeFighterPreview } from "@/game/three/fighterPreview3d";

interface FighterStanceCanvasProps {
  colors: FighterColors;
  width?: number;
  height?: number;
  scale?: number;
  /** Show sparring headgear — used by the colour pickers so the choice is visible. */
  showHeadgear?: boolean;
  /** Orthodox or southpaw; shown by the 3D preview (the 2D sprite has no stance). */
  stance?: BoxingStance;
  /** Always draw the Classic 2D sprite, whatever the graphics setting. */
  force2d?: boolean;
}

/** The player's saved stance (the same key the fight start reads). */
export function playerBoxingStance(): BoxingStance {
  try { return localStorage.getItem("handz_player_boxing_stance") === "southpaw" ? "southpaw" : "orthodox"; } catch { return "orthodox"; }
}

const BOB_SPEED = 2 * 0.8 + 1.0;

export default function FighterStanceCanvas({ colors, width = 160, height = 192, scale = 1, showHeadgear = false, stance = "orthodox", force2d = false }: FighterStanceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const phaseRef = useRef(0);
  // Read once at mount: the setting lives in the main menu. One shared WebGL
  // renderer serves every 3D card (see fighterPreview3d).
  const use3dRef = useRef<boolean>(!force2d && getGraphicsMode() === "3d" && fighterPreview3DAvailable());
  const use3d = use3dRef.current;
  const dpr = use3d ? Math.min(typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1, 2) : 1;
  const pxW = Math.round(width * dpr);
  const pxH = Math.round(height * dpr);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    if (use3d) {
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
        const ok = renderFighterPreview3D(ctx, {
          colors,
          stance,
          bobPhase: t * BOB_SPEED * Math.PI * 2,
          yaw: Math.sin(t * 0.45) * 0.4,
          headgear: showHeadgear,
        });
        if (!ok) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          renderFighterPreview(ctx, width, height, colors, (t * BOB_SPEED * Math.PI * 2) % (Math.PI * 2), scale, showHeadgear);
          ctx.setTransform(1, 0, 0, 1, 0, 0);
        }
      }, () => onScreen && canvas.isConnected);
      return () => { unsubscribe(); io?.disconnect(); };
    }

    let lastTime = performance.now();

    const animate = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      phaseRef.current += dt * BOB_SPEED * Math.PI * 2;
      if (phaseRef.current > Math.PI * 2) phaseRef.current -= Math.PI * 2;

      renderFighterPreview(ctx, width, height, colors, phaseRef.current, scale, showHeadgear);

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animRef.current);
    };
  }, [colors, width, height, scale, showHeadgear, stance, use3d, dpr]);

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
