import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { SignIn, useClerk, useUser } from "@clerk/react";
import { clerkAppearance } from "./clerkAppearance";
import { Cloud, CloudUpload, Settings, LoaderCircle, LogOut, RotateCcw, Upload, X } from "lucide-react";
import { useCloudSaves } from "@/lib/cloudSaves";
import { useScreenKind } from "@/lib/uiChrome";
import type { SaveFileData } from "@/lib/localSaves";
import { validateCareerSave } from "@shared/cloudSave";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";

const panelAppearance = {
  ...clerkAppearance,
  elements: { ...clerkAppearance.elements, rootBox: "w-full", cardBox: "w-full shadow-none" },
};
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const control = "inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-[#68604d] bg-[#282722] px-3 text-xs font-extrabold uppercase tracking-[.08em] text-[#eee7d9] transition-colors hover:border-[#d9a441] hover:bg-[#373328] hover:text-[#f4c866] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d9a441] disabled:cursor-not-allowed disabled:opacity-45";
const dangerControl = "inline-flex min-h-10 items-center justify-center gap-2 rounded-md border border-[#a84b3f] bg-[#9c3d32] px-3 text-xs font-extrabold uppercase tracking-[.08em] text-white transition-colors hover:bg-[#b64c3d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f08b72] disabled:cursor-not-allowed disabled:opacity-45";

export default function CloudAccountPanel() {
  const [open, setOpen] = useState(false);
  const [dialog, setDialog] = useState<"replace" | "final" | "conflict" | null>(null);
  const [importData, setImportData] = useState<SaveFileData | null>(null);
  const [fileError, setFileError] = useState("");
  const [actionError, setActionError] = useState("");
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { isLoaded, isSignedIn, user } = useUser();
  const { signOut } = useClerk();
  const [, setLocation] = useLocation();
  const cloud = useCloudSaves();
  const inPlay = useScreenKind() === "play";
  // Fights and minigames own the screen; the corner gear steps away and closes.
  useEffect(() => { if (inPlay) setOpen(false); }, [inPlay]);
  const ready = isLoaded && isSignedIn && cloud.status !== "loading";
  const saving = busy || cloud.status === "saving";
  // Signing in from the panel finishes in place; close it once the account is live.
  const wasSignedIn = useRef(isSignedIn);
  useEffect(() => {
    if (isSignedIn && wasSignedIn.current === false) setOpen(false);
    wasSignedIn.current = isSignedIn;
  }, [isSignedIn]);
  useEffect(() => {
    const importFile = (event: Event) => {
      setOpen(true);
      void readFile((event as CustomEvent<File>).detail);
    };
    window.addEventListener("handz-cloud-import", importFile);
    return () => window.removeEventListener("handz-cloud-import", importFile);
  });

  const chooseFile = () => {
    setFileError("");
    setActionError("");
    inputRef.current?.click();
  };

  const readFile = async (file?: File) => {
    if (!file) return;
    setFileError("");
    setImportData(null);
    if (cloud.status === "loading" || !isLoaded || !isSignedIn) return;
    if (!file.name.toLowerCase().endsWith(".json")) {
      setFileError("Choose a .json career file.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setFileError("File is larger than the 20 MB limit.");
      return;
    }
    try {
      const data = JSON.parse(await file.text()) as SaveFileData;
      if (!validateCareerSave(data)) throw new Error("This file is not a valid HANDZ career save.");
      setImportData(data);
      setDialog("replace");
    } catch (error) {
      setFileError(error instanceof Error ? error.message : "Could not read this career file.");
    }
    if (inputRef.current) inputRef.current.value = "";
  };

  const replaceCareer = async () => {
    if (!importData || saving) return;
    setBusy(true);
    setActionError("");
    try {
      await cloud.replaceFromFile(importData);
      setDialog(null);
      setOpen(false);
      setLocation("/play");
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The career could not be replaced.");
      setDialog(null);
    } finally {
      setBusy(false);
    }
  };

  const saveNow = async () => {
    setActionError("");
    try { await cloud.saveNow(); }
    catch (error) { setActionError(error instanceof Error ? error.message : "Cloud save failed. Try again."); }
  };

  const reloadCloud = async () => {
    setBusy(true);
    setActionError("");
    try {
      await cloud.reloadCloud();
      setDialog(null);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Cloud career could not be reloaded.");
      setDialog(null);
    } finally {
      setBusy(false);
    }
  };

  const logout = async () => {
    setBusy(true);
    setActionError("");
    try {
      await cloud.prepareSignOut();
      await signOut({ redirectUrl: "/" });
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Cloud changes could not be saved. You are still signed in.");
    } finally {
      setBusy(false);
    }
  };

  const statusLabel = cloud.status === "saving" || saving
    ? "Saving career…"
    : cloud.status === "error" ? "Cloud save needs attention"
      : cloud.status === "conflict" ? "Save conflict"
        : cloud.status === "ready" ? "Career synced"
          : cloud.status === "loading" ? "Loading account…"
            : "Cloud career";
  const importedName = importData?.fighter?.name || "Unknown fighter";

  return (
    <>
      {!inPlay && (
        <button type="button" aria-label="Open account and cloud saves" title="Account & settings" aria-expanded={open} onClick={() => setOpen((value) => !value)}
          className="fixed bottom-2 right-2 z-[60] flex h-9 w-9 items-center justify-center rounded-full border border-[#76613a]/70 bg-[#171714]/85 text-[#e2b657] shadow-lg backdrop-blur-sm transition-colors hover:border-[#e2b657] hover:bg-[#28251d] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e2b657]">
          <Settings className="h-4 w-4" />
        </button>
      )}
      {open && !inPlay && (
        <section aria-label="Account and cloud saves" className={`fixed bottom-14 right-2 z-[60] max-h-[calc(100dvh-5rem)] overflow-y-auto ${isLoaded && !isSignedIn ? "w-[min(26rem,calc(100vw-1.5rem))]" : "w-[min(22rem,calc(100vw-1.5rem))]"} rounded-lg border border-[#64563a] bg-[#171816] p-4 text-[#eee9df] shadow-2xl`}>
          <div className="mb-4 flex items-start justify-between gap-3 border-b border-[#37362f] pb-3">
            <div>
              <p className="text-[10px] font-black uppercase tracking-[.2em] text-[#d9a441]">HANDZ corner</p>
              <h2 className="mt-1 text-lg font-extrabold">{!isLoaded ? "Account" : isSignedIn ? (user?.fullName || user?.primaryEmailAddress?.emailAddress || "Fighter account") : "Guest play"}</h2>
            </div>
            <button type="button" aria-label="Close account panel" onClick={() => setOpen(false)} className="rounded p-1 text-[#9b968a] hover:bg-[#302f29] hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d9a441]"><X className="h-4 w-4" /></button>
          </div>
          {!isLoaded ? <div className="h-20 animate-pulse rounded bg-[#282923]" aria-label="Loading account" /> :
            !isSignedIn ? (
              <div className="flex justify-center">
                <SignIn routing="hash" withSignUp forceRedirectUrl="/play" signUpForceRedirectUrl="/play" appearance={panelAppearance} />
              </div>
            ) : (
              <div className="space-y-3">
                <div className={`flex items-center gap-2 rounded border px-3 py-2 text-xs font-bold ${cloud.status === "error" || cloud.status === "conflict" ? "border-[#91483e] bg-[#321f1c] text-[#f0a194]" : "border-[#444239] bg-[#20211e] text-[#d2c9b8]"}`}>
                  {cloud.status === "saving" || cloud.status === "loading" ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Cloud className={`h-4 w-4 ${cloud.status === "ready" ? "text-[#a7c989]" : "text-[#d9a441]"}`} />}
                  <span>{statusLabel}</span>
                </div>
                {cloud.cloudFighterName && <p className="text-sm text-[#c7c0b3]">Career: <strong className="text-[#f0e6d2]">{cloud.cloudFighterName}</strong></p>}
                {cloud.lastSavedAt && <p className="text-[11px] text-[#8f8b80]">Last saved {new Date(cloud.lastSavedAt).toLocaleString()}</p>}
                {(cloud.error || actionError) && <p role="alert" className="rounded border border-[#8e4a3f] bg-[#321f1c] px-3 py-2 text-xs text-[#ffb6a8]">{actionError || cloud.error}</p>}
                {fileError && <p role="alert" className="rounded border border-[#8e4a3f] bg-[#321f1c] px-3 py-2 text-xs text-[#ffb6a8]">{fileError}</p>}
                {cloud.status === "loading" || !cloud.gameReady ? (
                  <button type="button" disabled={saving || cloud.status === "loading"} onClick={() => void reloadCloud()} className={`${control} w-full`}><RotateCcw className="h-4 w-4" />Retry loading career</button>
                ) : cloud.status === "conflict" ? (
                  <button type="button" disabled={!ready || saving} onClick={() => setDialog("conflict")} className={`${control} w-full`}><RotateCcw className="h-4 w-4" />Reload cloud career</button>
                ) : (
                  <button type="button" disabled={!ready || saving} onClick={saveNow} className={`${control} w-full`}><CloudUpload className="h-4 w-4" />{cloud.status === "error" ? "Retry cloud save" : "Save now"}</button>
                )}
                <input ref={inputRef} type="file" accept=".json,application/json" className="sr-only" aria-label="Choose career save file" onChange={(event) => void readFile(event.currentTarget.files?.[0])} />
                <button type="button" disabled={!ready || saving} onClick={chooseFile} className={`${control} w-full`}><Upload className="h-4 w-4" />Import career file</button>
                <button type="button" disabled={saving} onClick={() => void logout()} className={`${control} w-full`}><LogOut className="h-4 w-4" />Sign out</button>
              </div>
            )}
        </section>
      )}

      <Dialog open={dialog === "replace"} onOpenChange={(value) => !value && setDialog(null)}>
        <DialogContent className="border-[#685639] bg-[#191a17] text-[#eee9df]">
          <DialogHeader><DialogTitle className="text-[#f0c461]">Replace account career?</DialogTitle></DialogHeader>
          <div className="space-y-2 rounded border border-[#454239] bg-[#22231f] p-3 text-sm">
            <p>Current account career: <strong className="text-[#f3e7ce]">{cloud.cloudFighterName || "No career"}</strong></p>
            <p>Imported fighter: <strong className="text-[#f3e7ce]">{importedName}</strong></p>
          </div>
          <DialogFooter className="gap-2">
            <button type="button" className={control} onClick={() => { setDialog(null); setImportData(null); }}>Cancel</button>
            <button type="button" className={dangerControl} disabled={!ready || saving} onClick={() => setDialog("final")}>Continue</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === "final"} onOpenChange={(value) => !value && setDialog(null)}>
        <DialogContent className="border-[#a84b3f] bg-[#191a17] text-[#eee9df]">
          <DialogHeader><DialogTitle className="text-[#ff9b86]">Final confirmation</DialogTitle><DialogDescription className="text-[#d3c2b8]">This permanently replaces the account career. This cannot be undone.</DialogDescription></DialogHeader>
          <div className="space-y-2 rounded border border-[#70443b] bg-[#2a201d] p-3 text-sm">
            <p>Current account career: <strong className="text-[#f3e7ce]">{cloud.cloudFighterName || "No career"}</strong></p>
            <p>Incoming career: <strong className="text-[#f3e7ce]">{importedName}</strong></p>
          </div>
          {actionError && <p role="alert" className="text-sm text-[#ffb6a8]">{actionError}</p>}
          <DialogFooter className="gap-2">
            <button type="button" className={control} disabled={saving} onClick={() => setDialog(null)}>Cancel</button>
            <button type="button" className={dangerControl} disabled={!ready || saving} onClick={() => void replaceCareer()}>{saving ? "Replacing…" : "Permanently replace"}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={dialog === "conflict"} onOpenChange={(value) => !value && setDialog(null)}>
        <DialogContent className="border-[#a84b3f] bg-[#191a17] text-[#eee9df]">
          <DialogHeader><DialogTitle className="text-[#ff9b86]">Reload cloud career?</DialogTitle><DialogDescription className="text-[#d3c2b8]">Reloading discards unsynced local career progress and replaces it with the cloud copy.</DialogDescription></DialogHeader>
          <p className="rounded border border-[#454239] bg-[#22231f] p-3 text-sm">Cloud career: <strong>{cloud.cloudFighterName || "Career"}</strong></p>
          {actionError && <p role="alert" className="text-sm text-[#ffb6a8]">{actionError}</p>}
          <DialogFooter className="gap-2">
            <button type="button" className={control} disabled={busy} onClick={() => setDialog(null)}>Keep local career</button>
            <button type="button" className={dangerControl} disabled={!ready || busy} onClick={() => void reloadCloud()}>{busy ? "Reloading…" : "Discard local and reload"}</button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
