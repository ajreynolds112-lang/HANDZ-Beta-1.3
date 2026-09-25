import { useEffect } from "react";
import { Switch, Route } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { soundEngine } from "@/game/sound";
import NotFound from "@/pages/not-found";
import Game from "@/pages/Game";
import FullscreenToggle from "@/components/FullscreenToggle";

const UI_SELECTOR =
  'button, [role="button"], [role="switch"], [role="tab"], [role="option"], [role="menuitem"], [role="menuitemradio"], a[href], .cursor-pointer, [data-ui-sound]';

// One global, capture-phase click listener routes the UI sound for every
// interactive control: back buttons -> back, the two start-match buttons ->
// start, everything else -> forward. Capture phase means controls that call
// stopPropagation (e.g. download/delete on a save slot) still sound. The game
// board is a <canvas> with cursor-pointer that handles its own click sounds, so
// it (and native form fields) are skipped here.
function useUiClickSounds() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const el = target.closest<HTMLElement>(UI_SELECTOR);
      if (!el) return;

      const tag = el.tagName;
      if (tag === "CANVAS" || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") return;

      const explicit = el.dataset.uiSound;
      if (explicit === "none") return;

      const testid = el.getAttribute("data-testid") || "";
      if (explicit === "back" || testid.startsWith("button-back")) {
        soundEngine.uiBack();
      } else if (explicit === "start" || testid === "button-start-bout" || testid === "button-confirm-class") {
        soundEngine.uiStart();
      } else if (explicit === "stats") {
        soundEngine.uiStatAllocate();
      } else {
        soundEngine.uiClick();
      }
    };

    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, []);
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Game} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  useUiClickSounds();
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <Toaster />
        <Router />
        {/* Sits above every screen so the corner works in the menu too. */}
        <FullscreenToggle />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
