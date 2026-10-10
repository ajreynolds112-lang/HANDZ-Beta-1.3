import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useAuth } from "@clerk/react";
import { queryClient } from "./queryClient";
import * as saves from "./localSaves";
import { captureCareerStorage, replaceCareerStorage } from "./careerStorage";
import { deleteBackup, getBackup, migrateLegacyBackups, setBackup } from "./cloudBackups";
import { IMPORT_CONFIRMATIONS, validateCareerSave } from "@shared/cloudSave";

type Status = "guest" | "loading" | "ready" | "saving" | "error" | "conflict";
interface CloudState {
  status: Status;
  error: string | null;
  lastSavedAt: string | null;
  cloudFighterName: string | null;
}
interface CloudContext extends CloudState {
  gameReady: boolean;
  gameEpoch: number;
  saveNow: () => Promise<void>;
  reloadCloud: () => Promise<void>;
  replaceFromFile: (data: saves.SaveFileData) => Promise<void>;
  prepareSignOut: () => Promise<void>;
}
interface Metadata { userId: string; revision: number; fingerprint: string }
interface CloudResponse { save: saves.SaveFileData | null; revision: number; updatedAt: string | null }
const SESSION_KEY = "handz_cloud_session";
const GUEST_KEY = "handz_cloud_guest_backup";
const RECOVERY_KEY = "handz_cloud_recovery";
const Context = createContext<CloudContext | null>(null);
const initial: CloudState = { status: "loading", error: null, lastSavedAt: null, cloudFighterName: null };

function fingerprint(save: saves.SaveFileData | null): string {
  const text = JSON.stringify(save);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return `${text.length}:${hash >>> 0}`;
}
function currentSave(): saves.SaveFileData | null {
  const fighter = saves.getFighters()[0];
  return fighter ? saves.exportSaveFile(fighter) : null;
}
function metadata(): Metadata | null {
  const raw = localStorage.getItem(SESSION_KEY);
  return raw ? JSON.parse(raw) : null;
}
type Recovery = { metadata: Metadata; snapshot: Record<string, string> };
async function stashRecovery(previous: Metadata): Promise<void> {
  if (fingerprint(currentSave()) !== previous.fingerprint) {
    await setBackup(`${RECOVERY_KEY}_${previous.userId}`, { metadata: previous, snapshot: captureCareerStorage() });
  }
}
async function restoreGuest(): Promise<void> {
  replaceCareerStorage((await getBackup<Record<string, string>>(GUEST_KEY)) ?? {});
}
class CloudError extends Error {
  constructor(message: string, public code: number) { super(message); }
}
async function request<T>(method: "GET" | "PUT", body?: unknown): Promise<T> {
  const response = await fetch("/api/cloud-save", {
    method, credentials: "same-origin",
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) throw new CloudError(result.error || "Cloud save request failed.", response.status);
  return result as T;
}

export function CloudSaveProvider({ children }: { children: ReactNode }) {
  const { isLoaded, userId } = useAuth();
  const identity = isLoaded ? userId ?? "guest" : null;
  const [state, setState] = useState<CloudState>(initial);
  const [readyIdentity, setReadyIdentity] = useState<string | null>(null);
  const [gameEpoch, setGameEpoch] = useState(0);
  const revision = useRef(0);
  const acknowledged = useRef("");
  const owner = useRef<string | null>(null);
  const mounted = useRef(true);
  const pending = useRef<Promise<void> | null>(null);
  const paused = useRef(true);
  const conflicted = useRef(false);
  const identityRef = useRef(identity);
  identityRef.current = identity;

  const fail = useCallback((error: unknown) => {
    const conflict = error instanceof CloudError && error.code === 409;
    conflicted.current = conflict;
    if (mounted.current) setState(s => ({
      ...s, status: conflict ? "conflict" : "error",
      error: error instanceof Error ? error.message : "Unable to sync this career.",
    }));
  }, []);
  const acknowledge = useCallback((save: saves.SaveFileData | null, rev: number, at: string | null) => {
    revision.current = rev;
    acknowledged.current = fingerprint(save);
    localStorage.setItem(SESSION_KEY, JSON.stringify({
      userId: owner.current, revision: rev, fingerprint: acknowledged.current,
    }));
    void deleteBackup(`${RECOVERY_KEY}_${owner.current}`).catch(() => {});
    conflicted.current = false;
    setState({ status: "ready", error: null, lastSavedAt: at, cloudFighterName: save?.fighter.name ?? null });
  }, []);

  const saveNow = useCallback(async () => {
    if (pending.current) return pending.current;
    if (paused.current || !owner.current || owner.current !== identityRef.current) return;
    if (conflicted.current) throw new Error("Resolve the cloud save conflict first.");
    let save: saves.SaveFileData | null;
    try {
      save = currentSave();
      if (save) validateCareerSave(save);
    } catch (error) { fail(error); throw error; }
    const signature = fingerprint(save);
    if (signature === acknowledged.current) return;
    const id = owner.current;
    const work = (async () => {
      setState(s => ({ ...s, status: "saving", error: null }));
      try {
        const result = await request<{ revision: number; updatedAt: string }>("PUT", {
          revision: revision.current, save, reason: "autosave",
        });
        if (owner.current === id && identityRef.current === id) acknowledge(save, result.revision, result.updatedAt);
      } catch (error) { fail(error); throw error; }
    })();
    pending.current = work;
    try { await work; } finally { if (pending.current === work) pending.current = null; }
  }, [acknowledge, fail]);

  const loadAccount = useCallback(async (id: string, discardLocal = false) => {
    paused.current = true;
    setReadyIdentity(null);
    setState(s => ({ ...s, status: "loading", error: null }));
    if (pending.current) await pending.current.catch(() => {});
    const remote = await request<CloudResponse>("GET");
    if (identityRef.current !== id) return;
    let previous = metadata();
    if (previous && previous.userId !== id) {
      await stashRecovery(previous);
      await restoreGuest();
    }
    if (!previous) await setBackup(GUEST_KEY, captureCareerStorage());
    const recovery = (await getBackup<Recovery>(`${RECOVERY_KEY}_${id}`)) ?? null;
    if (!discardLocal && previous?.userId !== id && recovery?.metadata.userId === id) {
      replaceCareerStorage(recovery.snapshot);
      previous = recovery.metadata;
      localStorage.setItem(SESSION_KEY, JSON.stringify(previous));
    }
    owner.current = id;
    revision.current = remote.revision;
    const local = currentSave();
    const sameAccount = previous?.userId === id;
    const dirty = sameAccount && previous?.fingerprint !== fingerprint(local);
    if (!discardLocal && dirty) {
      acknowledged.current = previous!.fingerprint;
      conflicted.current = previous!.revision !== remote.revision;
      setState({
        status: conflicted.current ? "conflict" : "ready",
        error: conflicted.current ? "Unsynced local progress conflicts with the cloud career. Download your local career before discarding it." : null,
        cloudFighterName: remote.save?.fighter.name ?? null, lastSavedAt: remote.updatedAt,
      });
    } else if (remote.save || remote.revision > 0 || discardLocal) {
      const backup = captureCareerStorage();
      try {
        replaceCareerStorage({});
        if (remote.save) saves.importSaveFile(remote.save, { replaceExisting: true, preserveIdentity: true });
      } catch (error) { replaceCareerStorage(backup); throw error; }
      acknowledge(currentSave(), remote.revision, remote.updatedAt);
    } else {
      // A new account adopts the current browser career without touching its guest backup.
      acknowledged.current = fingerprint(null);
      localStorage.setItem(SESSION_KEY, JSON.stringify({ userId: id, revision: 0, fingerprint: acknowledged.current }));
      setState({ status: "ready", error: null, cloudFighterName: null, lastSavedAt: null });
    }
    paused.current = false;
    setGameEpoch(n => n + 1);
    queryClient.clear();
    setReadyIdentity(id);
  }, [acknowledge]);

  useEffect(() => {
    if (!identity) return;
    let cancelled = false;
    paused.current = true;
    const start = async () => {
      try {
        await migrateLegacyBackups();
        if (identity === "guest") {
          if (pending.current) await pending.current.catch(() => {});
          const previous = metadata();
          if (previous) {
            await stashRecovery(previous);
            await restoreGuest();
            localStorage.removeItem(SESSION_KEY);
          }
          owner.current = null;
          if (!cancelled) {
            setState({ ...initial, status: "guest" });
            setReadyIdentity("guest");
            setGameEpoch(n => n + 1);
            queryClient.clear();
          }
        } else if (!cancelled) await loadAccount(identity);
      } catch (error) { if (!cancelled) fail(error); }
    };
    void start();
    return () => { cancelled = true; };
  }, [identity, loadAccount, fail]);
  useEffect(() => () => { mounted.current = false; }, []);

  useEffect(() => {
    if (!identity || identity === "guest" || readyIdentity !== identity) return;
    let timer: ReturnType<typeof setTimeout>;
    const changed = () => { clearTimeout(timer); timer = setTimeout(() => { void saveNow().catch(() => {}); }, 2000); };
    // After fights, minigames and rewards: save promptly. A request landing while a
    // write is in flight queues one follow-up so the newest progress is not skipped.
    let soonTimer: ReturnType<typeof setTimeout>;
    const saveSoon = () => {
      clearTimeout(soonTimer);
      soonTimer = setTimeout(() => {
        const inFlight = pending.current;
        const run = () => { void saveNow().catch(() => {}); };
        if (inFlight) void inFlight.catch(() => {}).then(run); else run();
      }, 400);
    };
    const interval = setInterval(() => { void saveNow().catch(() => {}); }, 10_000);
    const hidden = () => { if (document.visibilityState === "hidden") void saveNow().catch(() => {}); };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (fingerprint(currentSave()) !== acknowledged.current || pending.current) {
        event.preventDefault(); event.returnValue = "";
      }
    };
    window.addEventListener("handz-career-changed", changed);
    window.addEventListener("handz-save-now", saveSoon);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("beforeunload", beforeUnload);
    void saveNow().catch(() => {});
    return () => {
      clearTimeout(timer); clearTimeout(soonTimer); clearInterval(interval);
      window.removeEventListener("handz-save-now", saveSoon);
      window.removeEventListener("handz-career-changed", changed);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [identity, readyIdentity, saveNow]);

  const reloadCloud = useCallback(async () => {
    if (!userId) return;
    try { await loadAccount(userId, readyIdentity === userId); } catch (error) { fail(error); throw error; }
  }, [userId, readyIdentity, loadAccount, fail]);

  const replaceFromFile = useCallback(async (data: saves.SaveFileData) => {
    validateCareerSave(data);
    if (!userId || owner.current !== userId || paused.current) throw new Error("Sign in and load your cloud career first.");
    if (conflicted.current) throw new Error("Resolve the cloud save conflict before replacing a career.");
    paused.current = true;
    setReadyIdentity(null);
    setState(s => ({ ...s, status: "loading", error: null }));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    if (pending.current) await pending.current.catch(() => {});
    const backup = captureCareerStorage();
    try {
      replaceCareerStorage({});
      saves.importSaveFile(data, { replaceExisting: true, preserveIdentity: true });
      const imported = currentSave()!;
      const result = await request<{ revision: number; updatedAt: string }>("PUT", {
        revision: revision.current, save: imported, reason: "import", confirmations: IMPORT_CONFIRMATIONS,
      });
      acknowledge(imported, result.revision, result.updatedAt);
      setGameEpoch(n => n + 1);
      queryClient.clear();
    } catch (error) { replaceCareerStorage(backup); fail(error); throw error; }
    finally { paused.current = false; setReadyIdentity(userId); }
  }, [userId, acknowledge, fail]);

  const prepareSignOut = useCallback(async () => {
    if (readyIdentity !== userId) return; // A failed initial load has not touched browser progress.
    await saveNow();
    // A write can finish while another game update lands; flush the latest copy too.
    await saveNow();
    if (fingerprint(currentSave()) !== acknowledged.current) throw new Error("Your latest progress has not finished saving. Try again.");
  }, [saveNow, readyIdentity, userId]);
  return <Context.Provider value={{
    ...state, gameReady: identity !== null && readyIdentity === identity, gameEpoch,
    saveNow, reloadCloud, replaceFromFile, prepareSignOut,
  }}>{children}</Context.Provider>;
}

export function useCloudSaves(): CloudContext {
  const value = useContext(Context);
  if (!value) throw new Error("Cloud saves must be used inside CloudSaveProvider.");
  return value;
}
