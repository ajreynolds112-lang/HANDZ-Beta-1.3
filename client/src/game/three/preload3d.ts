/**
 * One await for every 3D asset the scenes load from the network: the boxer rig
 * and gear GLBs, the Tripo props, and the font the canvas-drawn signs use.
 * Loading screens await this before swapping to a 3D view so nothing pops into
 * place after the screen lifts. Loads are cached per page, so after the first
 * call this resolves immediately.
 */
import { preloadFighterAssets } from "./fighterRig";
import { preloadGeneratedProps } from "./props3d";

/** A stalled request must never hold a loading screen up forever. */
const PRELOAD_TIMEOUT_MS = 15000;

let done = false;

export function are3dAssetsLoaded(): boolean {
  return done;
}

export function preload3dAssets(): Promise<void> {
  const fonts = typeof document !== "undefined" && document.fonts
    ? Promise.all([
        document.fonts.load("900 40px 'Oxanium'"),
        document.fonts.load("800 40px 'Oxanium'"),
      ]).catch(() => undefined)
    : Promise.resolve();
  const all = Promise.all([preloadFighterAssets(), preloadGeneratedProps(), fonts]).then(() => { done = true; });
  return Promise.race([all, new Promise<void>(r => setTimeout(r, PRELOAD_TIMEOUT_MS))]);
}
