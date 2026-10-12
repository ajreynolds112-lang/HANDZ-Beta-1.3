import { useEffect, useState } from "react";
import { LoaderCircle } from "lucide-react";
import { useCloudSaves } from "@/lib/cloudSaves";
import { useScreenKind } from "@/lib/uiChrome";
import { applyTrainingSections, startLiveTrainingWatcher, startTuningDefaultsWatcher } from "@/lib/tuningBundle";

const POLL_MS = 15_000;
/** Set by the live server on every page: the Neural Network bundle this page booted on. */
const live = typeof window === "undefined" ? {}
  : window as unknown as { __HANDZ_TUNED_LIVE_REV__?: string; __HANDZ_TRAINING_REV__?: string };
const bootRev = live.__HANDZ_TUNED_LIVE_REV__;
/** Kept outside the handz_ namespace so career files don't carry it. */
const TRAINING_STAMP_KEY = "liveTrainingRev";

/**
 * Neural Network live update.
 * Workspace: publishes every tunable (and the AI Training state) as it changes.
 * Live: watches for a newer publish and reloads onto it (the page seeds the
 * new bundle on boot), waiting for a fight or minigame to end first.
 */
export default function LiveTuningUpdater() {
  const [pending, setPending] = useState(false);
  const [updating, setUpdating] = useState(false);
  const inPlay = useScreenKind() === "play";
  const cloud = useCloudSaves();

  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const stopTuning = startTuningDefaultsWatcher();
    const stopTraining = startLiveTrainingWatcher();
    return () => { stopTuning(); stopTraining(); };
  }, []);

  // Live: take the AI Training state the page's publish carries, once per publish.
  useEffect(() => {
    const rev = live.__HANDZ_TRAINING_REV__;
    if (!rev || localStorage.getItem(TRAINING_STAMP_KEY) === rev) return;
    void (async () => {
      try {
        const res = await fetch("/api/live-tuning/training", { cache: "no-store" });
        if (!res.ok) return;
        const { params } = await res.json() as { params?: Record<string, unknown> };
        if (params && typeof params === "object") await applyTrainingSections(params);
        localStorage.setItem(TRAINING_STAMP_KEY, rev);
      } catch (error) { console.warn("[live-tuning] training not applied:", error); }
    })();
  }, []);

  useEffect(() => {
    if (!bootRev || pending) return;
    let stopped = false;
    const check = async () => {
      try {
        const res = await fetch("/api/live-tuning/status", { cache: "no-store" });
        if (!res.ok) return;
        const { rev } = await res.json() as { rev: string | null };
        if (!stopped && rev && rev !== bootRev) setPending(true);
      } catch { /* offline or mid-restart: try again next tick */ }
    };
    void check();
    const id = window.setInterval(check, POLL_MS);
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    document.addEventListener("visibilitychange", visible);
    return () => { stopped = true; window.clearInterval(id); document.removeEventListener("visibilitychange", visible); };
  }, [pending]);

  useEffect(() => {
    if (!pending || inPlay || updating) return;
    setUpdating(true);
    void (async () => {
      // Flush career progress first; a slow or signed-out save must not block the update.
      await Promise.race([cloud.saveNow().catch(() => {}), new Promise(r => setTimeout(r, 5000))]);
      window.location.reload();
    })();
  }, [pending, inPlay, updating, cloud]);

  if (!updating) return null;
  return (
    <div role="status" aria-live="polite" className="fixed inset-0 z-[10000] flex flex-col items-center justify-center gap-4 bg-[#11120f]/95 text-[#f0c461]">
      <LoaderCircle className="h-10 w-10 animate-spin" aria-hidden="true" />
      <p className="text-sm font-extrabold uppercase tracking-[.2em]">Updating…</p>
    </div>
  );
}
