import { useRef, useEffect } from "react";
import { FighterColors } from "@/game/types";
import { renderFighterPreview } from "@/game/renderer";

interface FighterStanceCanvasProps {
  colors: FighterColors;
  width?: number;
  height?: number;
  scale?: number;
  /** Show sparring headgear — used by the colour pickers so the choice is visible. */
  showHeadgear?: boolean;
}

export default function FighterStanceCanvas({ colors, width = 160, height = 192, scale = 1, showHeadgear = false }: FighterStanceCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animRef = useRef<number>(0);
  const phaseRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let lastTime = performance.now();

    const animate = (now: number) => {
      const dt = (now - lastTime) / 1000;
      lastTime = now;

      const effectiveBobSpeed = 2 * 0.8 + 1.0;
      phaseRef.current += dt * effectiveBobSpeed * Math.PI * 2;
      if (phaseRef.current > Math.PI * 2) phaseRef.current -= Math.PI * 2;

      renderFighterPreview(ctx, width, height, colors, phaseRef.current, scale, showHeadgear);

      animRef.current = requestAnimationFrame(animate);
    };

    animRef.current = requestAnimationFrame(animate);

    return () => {
      cancelAnimationFrame(animRef.current);
    };
  }, [colors, width, height, scale, showHeadgear]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="w-full h-full"
      data-testid="canvas-fighter-preview"
    />
  );
}
