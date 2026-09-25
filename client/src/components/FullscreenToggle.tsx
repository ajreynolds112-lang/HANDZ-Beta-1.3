import { useEffect, useRef, useState } from "react";
import { Maximize2, Minimize2 } from "lucide-react";

/** How far into the top-left corner the pointer must be to start the dwell. */
const CORNER_PX = 72;
/** How long it has to rest there before the toggle fades in. */
const DWELL_MS = 750;
/**
 * The panel that fades in, pinned to the corner. The whole rectangle is the
 * button — icon, label and every bit of padding around them.
 */
const PANEL_W = 210;
const PANEL_H = 64;
/**
 * Once the panel is up, the pointer may roam a little past its edges before it
 * goes away again, so a small overshoot on the way to a click doesn't dismiss
 * the thing being aimed at.
 */
const KEEP_ALIVE_X = PANEL_W + 48;
const KEEP_ALIVE_Y = PANEL_H + 48;
/** How long the pointer has to stay off the panel before it fades back out. */
const HIDE_GRACE_MS = 500;

type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};
type FsElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};
type KeyboardLockNavigator = Navigator & {
  keyboard?: {
    lock?: (keys?: string[]) => Promise<void>;
    unlock?: () => void;
  };
};

function fullscreenOn(): boolean {
  const doc = document as FsDocument;
  return Boolean(doc.fullscreenElement || doc.webkitFullscreenElement);
}

/** Fire and forget: a browser that refuses leaves the game exactly as it was. */
function settle(r: unknown): void {
  void Promise.resolve(r).catch(() => {});
}

/**
 * Escape belongs to the pause menu, so while fullscreen is on we take the key
 * off the browser with the Keyboard Lock API: the press is delivered to the
 * page instead of being spent leaving fullscreen. The corner panel becomes the
 * way out.
 *
 * Two limits are the browser's, not ours: lock only exists in Chromium (Chrome,
 * Edge) and only for a top-level page — inside an embedded preview frame it is
 * refused — and even when it holds, a *held* Escape (about two seconds) always
 * drops fullscreen. A refusal just leaves the old behaviour in place.
 */
function holdEscape(on: boolean): void {
  const kb = (navigator as KeyboardLockNavigator).keyboard;
  if (!kb) return;
  try {
    if (on) settle(kb.lock?.(["Escape"]));
    else kb.unlock?.();
  } catch { /* unsupported context — the browser keeps Escape */ }
}

/**
 * The fullscreen toggle: a button hidden in the top-left corner of the screen.
 *
 * It is deliberately hard to hit by accident — the pointer has to sit in the
 * corner for three quarters of a second before it appears — because the corner
 * is also live game area. Nothing is mounted over that corner while it is
 * hidden either: the dwell is measured from a plain mousemove listener rather
 * than a hover target, so no invisible panel can ever swallow a click meant for
 * the canvas underneath.
 *
 * Fullscreen is requested on the document root, so every screen the game has —
 * the home menu, the career hub, the gym, the fight itself — goes with it.
 */
export default function FullscreenToggle() {
  const [visible, setVisible] = useState(false);
  const [isFull, setIsFull] = useState(false);
  const dwellRef = useRef<number | null>(null);
  const hideRef = useRef<number | null>(null);
  const visibleRef = useRef(false);

  useEffect(() => {
    const clearDwell = () => {
      if (dwellRef.current !== null) {
        window.clearTimeout(dwellRef.current);
        dwellRef.current = null;
      }
    };
    const clearHide = () => {
      if (hideRef.current !== null) {
        window.clearTimeout(hideRef.current);
        hideRef.current = null;
      }
    };
    const show = () => {
      clearHide();
      visibleRef.current = true;
      setVisible(true);
    };
    // Leaving the panel doesn't dismiss it on the spot — the pointer has to
    // stay off it for the full grace period, so brushing past an edge on the
    // way to the click doesn't take the button away mid-reach.
    const hideSoon = () => {
      if (!visibleRef.current || hideRef.current !== null) return;
      hideRef.current = window.setTimeout(() => {
        hideRef.current = null;
        visibleRef.current = false;
        setVisible(false);
      }, HIDE_GRACE_MS);
    };

    const onMove = (e: MouseEvent) => {
      // Once it's up, the panel itself (plus a little overshoot) holds it open;
      // before that, only the corner counts.
      if (visibleRef.current) {
        if (e.clientX <= KEEP_ALIVE_X && e.clientY <= KEEP_ALIVE_Y) clearHide();
        else hideSoon();
        return;
      }

      if (e.clientX <= CORNER_PX && e.clientY <= CORNER_PX) {
        // Already counting down — let it run.
        if (dwellRef.current === null) {
          dwellRef.current = window.setTimeout(() => {
            dwellRef.current = null;
            show();
          }, DWELL_MS);
        }
        return;
      }
      clearDwell();
    };

    // The pointer leaving the window is off the panel too — same grace.
    const onLeave = () => {
      clearDwell();
      hideSoon();
    };

    // Claim Escape the moment fullscreen goes on, hand it back on the way out.
    const onFsChange = () => {
      const on = fullscreenOn();
      setIsFull(on);
      holdEscape(on);
    };

    setIsFull(fullscreenOn());
    holdEscape(fullscreenOn());
    window.addEventListener("mousemove", onMove);
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    return () => {
      clearDwell();
      clearHide();
      holdEscape(false);
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
    };
  }, []);

  const toggle = () => {
    const doc = document as FsDocument;
    if (fullscreenOn()) {
      const exit = doc.exitFullscreen ?? doc.webkitExitFullscreen;
      if (exit) {
        try { settle(exit.call(doc)); } catch { /* already out */ }
      }
      return;
    }
    const el = document.documentElement as FsElement;
    const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
    if (req) {
      try { settle(req.call(el)); } catch { /* refused — stay windowed */ }
    }
  };

  if (!visible) return null;

  const Icon = isFull ? Minimize2 : Maximize2;
  return (
    // The <button> IS the panel: every pixel of it, padding included, toggles.
    <button
      onClick={toggle}
      data-testid="button-fullscreen-toggle"
      title={isFull ? "Leave fullscreen" : "Play fullscreen"}
      style={{ width: PANEL_W, height: PANEL_H }}
      className="fixed top-0 left-0 z-[9999] flex items-center justify-center gap-2 rounded-br-lg border-b border-r border-yellow-700/60 bg-black/85 text-sm font-bold tracking-wide text-yellow-400 shadow-lg backdrop-blur-sm transition-colors hover:bg-black hover:text-yellow-300 animate-in fade-in duration-200"
    >
      <Icon className="w-4 h-4" />
      {isFull ? "Exit Fullscreen" : "Fullscreen"}
    </button>
  );
}
