import { useEffect, useRef } from "react";

/**
 * Enter-to-advance for the game's blocking overlays (fight end, crate reveal,
 * milestones, ceremonies).
 *
 * Several of these overlays can be on screen at the same time — a milestone
 * popup can sit on top of a crate reveal, which sits on top of the fight-end
 * card — so a plain per-component `window` listener would fire every one of
 * them at once. Instead every caller registers here and a single listener
 * dispatches to the topmost registration: highest `priority` first, and among
 * equal priorities the one that mounted last (which is the one drawn on top).
 *
 * While any overlay is registered, Enter belongs to this hook: it calls the
 * topmost handler and preventDefaults, which also suppresses the browser's
 * own Enter-to-click on whatever button happens to hold focus, so the action
 * runs exactly once. (Deferring to that native click instead used to leave
 * Enter dead on the fight-end screens, because the still-mounted game canvas
 * preventDefaults Enter for its own input handling.) Enter typed into a text
 * field is always left alone, and with no overlay registered the key behaves
 * normally.
 */

interface Entry {
  id: number;
  priority: number;
  handler: () => void;
}

const entries: Entry[] = [];
let nextId = 1;
let listening = false;

function topEntry(): Entry | null {
  let best: Entry | null = null;
  for (const e of entries) {
    if (!best || e.priority > best.priority || (e.priority === best.priority && e.id > best.id)) best = e;
  }
  return best;
}

function tagOf(t: EventTarget | null): { tag: string; editable: boolean } {
  const el = t as HTMLElement | null;
  if (!el || !el.tagName) return { tag: "", editable: false };
  return { tag: el.tagName.toUpperCase(), editable: !!el.isContentEditable };
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== "Enter" || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
  const { tag, editable } = tagOf(e.target);
  if (editable || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
  const top = topEntry();
  if (!top) return;
  e.preventDefault();
  top.handler();
}

function ensureListener() {
  if (listening || typeof window === "undefined") return;
  window.addEventListener("keydown", onKeyDown);
  listening = true;
}

function releaseListener() {
  if (!listening || entries.length > 0 || typeof window === "undefined") return;
  window.removeEventListener("keydown", onKeyDown);
  listening = false;
}

/**
 * True while an overlay owns Enter. Screens with their own Enter handling (the
 * training minigame recaps) check this so a popup layered on top doesn't get
 * answered twice.
 */
export function isEnterOverlayActive(): boolean {
  return entries.length > 0;
}

export const ENTER_PRIORITY = {
  /** Fight end, ceremonies, simulation recap — the base screen layer. */
  screen: 10,
  /** Crate reveals, which pop over that screen. */
  crate: 20,
  /** Milestone popups, which pop over everything. */
  milestone: 30,
} as const;

/**
 * Fires `handler` when Enter is pressed and this is the topmost registration.
 * Pass `enabled: false` while the button it stands in for is hidden or not yet
 * actionable (e.g. a ceremony button that fades in on a delay).
 */
export function useEnterKey(
  handler: () => void,
  options?: { enabled?: boolean; priority?: number },
) {
  const enabled = options?.enabled ?? true;
  const priority = options?.priority ?? ENTER_PRIORITY.screen;
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    if (!enabled) return;
    ensureListener();
    const entry: Entry = { id: nextId++, priority, handler: () => handlerRef.current() };
    entries.push(entry);
    return () => {
      const i = entries.indexOf(entry);
      if (i >= 0) entries.splice(i, 1);
      releaseListener();
    };
  }, [enabled, priority]);
}
