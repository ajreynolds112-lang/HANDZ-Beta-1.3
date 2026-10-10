import { useEffect } from "react";
import { Switch, Route, Redirect, useLocation } from "wouter";
import { ClerkProvider, useAuth, useUser } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { soundEngine } from "@/game/sound";
import NotFound from "@/pages/not-found";
import Game from "@/pages/Game";
import FullscreenToggle from "@/components/FullscreenToggle";
import { CloudSaveProvider, useCloudSaves } from "@/lib/cloudSaves";
import CloudAccountPanel from "@/components/CloudAccountPanel";
import { SignInPage, SignUpPage } from "@/components/AuthPages";
import { clerkAppearance, clerkLocalization } from "@/components/clerkAppearance";

const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || "/" : path;
}

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

const ROSTER_EDITOR_EMAIL = "ajreynolds12@gmail.com";

/** Edit Roster: the Replit workspace preview (dev server) or the owner's verified email. */
function useCanEditRoster(): boolean {
  const { user } = useUser();
  if (import.meta.env.DEV) return true;
  return !!user?.emailAddresses.some(email =>
    email.emailAddress.toLowerCase() === ROSTER_EDITOR_EMAIL && email.verification?.status === "verified");
}

function GameScreen() {
  const cloud = useCloudSaves();
  const canEditRoster = useCanEditRoster();
  if (!cloud.gameReady) return (
    <main className="flex min-h-screen items-center justify-center bg-[#101114] text-yellow-400">
      <div role="status">{cloud.error || "Loading career…"}</div>
    </main>
  );
  return <Game key={cloud.gameEpoch} autoCreateCareer={cloud.status !== "guest"} canEditRoster={canEditRoster} />;
}

function Home() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && isSignedIn) return <Redirect to="/play" />;
  return <GameScreen />;
}

function PlayerPortal() {
  const { isLoaded, isSignedIn } = useAuth();
  if (isLoaded && !isSignedIn) return <Redirect to="/" />;
  return <GameScreen />;
}

function Router() {
  return (
    <Switch>
      <Route path="/" component={Home} />
      <Route path="/play" component={PlayerPortal} />
      <Route path="/sign-in/*?" component={SignInPage} />
      <Route path="/sign-up/*?" component={SignUpPage} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  useUiClickSounds();
  const [, setLocation] = useLocation();
  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      localization={clerkLocalization}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
    <QueryClientProvider client={queryClient}>
      <CloudSaveProvider>
      <TooltipProvider>
        <Toaster />
        <Router />
        {/* Sits above every screen so the corner works in the menu too. */}
        <FullscreenToggle />
        <CloudAccountPanel />
      </TooltipProvider>
      </CloudSaveProvider>
    </QueryClientProvider>
    </ClerkProvider>
  );
}

export default App;
