/**
 * The 3D view for the fight screens that run their own loop instead of
 * GameCanvas (menu background fight, idle ring, neural test ring, trainee
 * spars). Same layering as GameCanvas: a WebGL canvas under the 2D one, the 2D
 * canvas drawing only the HUD on top, so every click hit-test stays 2D.
 *
 * The scene is created lazily on the first frame and disposed on unmount. If
 * WebGL will not start, only the HUD draws.
 */
import { useCallback, useEffect, useRef } from "react";
import type { GameState } from "../types";
import { renderGame } from "../renderer";
import { FightScene3D, type FightSceneOptions, type FightSceneRenderOptions } from "./FightScene3D";

export interface FightScene3DHandle {
  /** Attach to the WebGL canvas that sits underneath the 2D canvas. */
  glCanvasRef: React.RefObject<HTMLCanvasElement>;
  /**
   * Draw one frame: the scene plus (unless `hud` is false) the 2D HUD on `ctx`.
   * Returns whether the 3D scene drew.
   */
  draw: (
    ctx: CanvasRenderingContext2D | null,
    state: GameState,
    opts?: { hud?: boolean; scene?: FightSceneRenderOptions },
  ) => boolean;
}

export function useFightScene3D(sceneOptions?: FightSceneOptions): FightScene3DHandle {
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<FightScene3D | null>(null);
  const failedRef = useRef(false);
  const optsRef = useRef(sceneOptions);

  useEffect(() => () => {
    sceneRef.current?.dispose();
    sceneRef.current = null;
  }, []);

  const draw = useCallback<FightScene3DHandle["draw"]>((ctx, state, opts) => {
    const glCanvas = glCanvasRef.current;
    if (glCanvas && !sceneRef.current && !failedRef.current) {
      try {
        sceneRef.current = new FightScene3D(glCanvas, optsRef.current);
      } catch (err) {
        console.error("[3D] WebGL view unavailable", err);
        failedRef.current = true;
      }
    }
    const scene = sceneRef.current;
    if (glCanvas) glCanvas.style.visibility = scene ? "visible" : "hidden";
    scene?.render(state, opts?.scene);
    if (ctx) {
      if (opts?.hud === false) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
      else renderGame(ctx, state, scene ? scene.project : null);
    }
    return !!scene;
  }, []);

  return { glCanvasRef, draw };
}
