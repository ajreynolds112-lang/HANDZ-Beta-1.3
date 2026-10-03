/**
 * "Graphics: 3D / Classic 2D". A device preference like the volume sliders, not
 * career data: one browser-level key, read by the fight canvas at mount.
 */
export type GraphicsMode = "3d" | "classic";

const KEY = "handz_graphics_mode";
/** Used when storage is unavailable, so the choice still holds for this page. */
let memoryMode: GraphicsMode | null = null;

export function getGraphicsMode(): GraphicsMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "classic" || v === "3d") return v;
  } catch {
    /* fall through */
  }
  return memoryMode ?? "3d";
}

export function setGraphicsMode(mode: GraphicsMode): void {
  memoryMode = mode;
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* storage unavailable: memoryMode keeps it for this page */
  }
}
