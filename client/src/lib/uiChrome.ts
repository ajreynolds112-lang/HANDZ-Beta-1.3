import { useSyncExternalStore } from "react";

/**
 * Which kind of screen the game is showing, for chrome that lives outside the
 * game tree (the account/settings corner). "play" = a fight or a minigame.
 */
export type ScreenKind = "menu" | "play" | "other";

let current: ScreenKind = "menu";
const listeners = new Set<() => void>();

export function setScreenKind(kind: ScreenKind): void {
  if (kind === current) return;
  current = kind;
  listeners.forEach(listener => listener());
}

export function useScreenKind(): ScreenKind {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => current,
  );
}

/**
 * Asks for an immediate cloud save: after a fight, a minigame or a reward.
 * Bursts are coalesced by the cloud save provider.
 */
export function requestCloudSave(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("handz-save-now"));
}
