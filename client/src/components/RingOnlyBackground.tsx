import { useRef, useEffect } from "react";
import { GameState } from "@/game/types";
import { createInitialState } from "@/game/engine";
import { renderRingOnly } from "@/game/renderer";
import { ringColorsOf, type RingColors } from "@/game/ringColors";

const BASE_W = 800;
const BASE_H = 600;

function makeRingState(): GameState {
  const state = createInitialState();
  state.menuBackground = true;
  state.phase = "fighting" as any;
  state.crowdBobTime = 0;
  state.crowdKdBounceTimer = 0;
  state.ringCanvasColor = "#BDEDF2";
  return state;
}

/**
 * The idle ring behind the career screens.
 *
 * `colors` is the career's saved ring palette. It is filled in against the stock
 * colours here rather than at the call sites, so a save that predates ring
 * colours (or no career at all) simply draws the stock ring.
 */
export default function RingOnlyBackground({ colors }: { colors?: RingColors | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef<GameState>(makeRingState());
  const animFrameRef = useRef<number>(0);
  const lastTimeRef = useRef<number>(0);
  // The render loop is started once and never re-created, so the live palette
  // reaches it through a ref instead of the effect's closure.
  const colorsRef = useRef(ringColorsOf({ ringColors: colors ?? undefined }));
  useEffect(() => { colorsRef.current = ringColorsOf({ ringColors: colors ?? undefined }); }, [colors]);

  useEffect(() => {
    const loop = (timestamp: number) => {
      if (lastTimeRef.current === 0) lastTimeRef.current = timestamp;
      const dt = Math.min(0.05, (timestamp - lastTimeRef.current) / 1000);
      lastTimeRef.current = timestamp;

      stateRef.current = {
        ...stateRef.current,
        crowdBobTime: stateRef.current.crowdBobTime + dt * 1.2,
        ringColors: colorsRef.current,
      };

      const canvas = canvasRef.current;
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) renderRingOnly(ctx, stateRef.current);
      }

      animFrameRef.current = requestAnimationFrame(loop);
    };
    animFrameRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(animFrameRef.current);
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={BASE_W}
      height={BASE_H}
      aria-hidden="true"
      className="absolute inset-0 w-full h-full pointer-events-none"
      style={{ imageRendering: "auto", objectFit: "cover" }}
    />
  );
}
