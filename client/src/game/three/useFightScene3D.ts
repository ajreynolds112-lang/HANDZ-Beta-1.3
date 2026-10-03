/**
 * The 3D view for the fight screens that run their own loop instead of
 * GameCanvas (menu background fight, idle ring, neural test ring, trainee
 * spars). Same layering as GameCanvas: a WebGL canvas under the 2D one, the 2D
 * canvas drawing only the HUD on top, so every click hit-test stays 2D.
 *
 * The scene is created lazily on the first frame that wants it and disposed on
 * unmount. The graphics setting is read once at mount, like the fight canvas;
 * if WebGL will not start, the screen stays on Classic 2D for good.
 */
import { useCallback, useEffect, useRef } from "react";
import type { GameState } from "../types";
import { renderGame } from "../renderer";
import { getGraphicsMode } from "../graphicsSetting";
import { FightScene3D, type FightSceneOptions, type FightSceneRenderOptions } from "./FightScene3D";

export interface FightScene3DHandle {
  /** Attach to the WebGL canvas that sits underneath the 2D canvas. */
  glCanvasRef: React.RefObject<HTMLCanvasElement>;
  /**
   * Draw one frame. In 3D: the scene plus (unless `hud` is false) the 2D HUD on
   * `ctx`; in Classic 2D, or with no WebGL, `fallback2D` draws the whole frame.
   * Returns whether the frame went through the 3D view.
   */
  draw: (
    ctx: CanvasRenderingContext2D | null,
    state: GameState,
    opts?: { hud?: boolean; scene?: FightSceneRenderOptions; fallback2D?: (ctx: CanvasRenderingContext2D) => void },
  ) => boolean;
}

export function useFightScene3D(sceneOptions?: FightSceneOptions): FightScene3DHandle {
  const glCanvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<FightScene3D | null>(null);
  const enabledRef = useRef<boolean>(getGraphicsMode() === "3d");
  const optsRef = useRef(sceneOptions);

  useEffect(() => () => {
    sceneRef.current?.dispose();
    sceneRef.current = null;
  }, []);

  const draw = useCallback<FightScene3DHandle["draw"]>((ctx, state, opts) => {
    const glCanvas = glCanvasRef.current;
    let scene: FightScene3D | null = null;
    if (glCanvas && enabledRef.current) {
      if (!sceneRef.current) {
        try {
          sceneRef.current = new FightScene3D(glCanvas, optsRef.current);
        } catch (err) {
          console.error("[3D] WebGL view unavailable, using Classic 2D", err);
          enabledRef.current = false;
        }
      }
      scene = sceneRef.current;
    }
    if (glCanvas) glCanvas.style.visibility = scene ? "visible" : "hidden";
    if (scene) {
      scene.render(state, opts?.scene);
      if (ctx) {
        if (opts?.hud === false) ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        else renderGame(ctx, state, { hudOnly: true, project: scene.project });
      }
      return true;
    }
    if (ctx) {
      if (opts?.fallback2D) opts.fallback2D(ctx);
      else renderGame(ctx, state);
    }
    return false;
  }, []);

  return { glCanvasRef, draw };
}
