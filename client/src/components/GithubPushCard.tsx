/**
 * "Push to GitHub" / "Import from GitHub" at the top of the Neural Network
 * screen: sync the workspace's source files with the HANDZ repo
 * (server/githubPush.ts). Import previews first and applies only on confirm.
 * Enabled only while online — the browser must be online and the server must
 * reach GitHub — and only in the workspace, never on the published site.
 */
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Github, Loader2, WifiOff } from "lucide-react";

type Status = { available: boolean; online: boolean; reason?: string };
type ImportPlan = { updated: string[]; added: string[]; deleted: string[]; commit?: string };

export default function GithubPushCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [message, setMessage] = useState("");
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; url?: string } | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);

  const check = useCallback(async () => {
    if (!navigator.onLine) { setStatus({ available: true, online: false, reason: "No internet connection" }); return; }
    try {
      const res = await fetch("/api/github/status");
      setStatus(await res.json());
    } catch {
      setStatus({ available: true, online: false, reason: "Can't reach the game server" });
    }
  }, []);

  useEffect(() => {
    void check();
    const on = () => { setBrowserOnline(true); void check(); };
    const off = () => setBrowserOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
  }, [check]);

  if (status && !status.available) return null;
  const online = browserOnline && !!status?.online;

  const push = async () => {
    setPushing(true);
    setResult(null);
    try {
      const res = await fetch("/api/github/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Push failed (${res.status})`);
      setResult(data.changed === 0 && data.deleted === 0
        ? { ok: true, text: "Already up to date." }
        : { ok: true, text: `Pushed ${data.changed} changed, ${data.deleted} deleted — commit ${data.commit}.`, url: data.url });
      setMessage("");
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
      void check();
    } finally {
      setPushing(false);
    }
  };

  const runImport = async (dryRun: boolean) => {
    setPushing(true);
    setResult(null);
    try {
      const res = await fetch("/api/github/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dryRun }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Import failed (${res.status})`);
      const total = data.updated.length + data.added.length + data.deleted.length;
      if (dryRun) {
        if (total === 0) setResult({ ok: true, text: "Workspace already matches GitHub." });
        else setPlan(data);
        return;
      }
      setPlan(null);
      const notes = [
        data.installed === false ? "npm install failed — run it manually." : data.installed ? "Packages reinstalled." : "",
        data.serverChanged ? "Server files changed — restart the app to load them." : "",
      ].filter(Boolean).join(" ");
      setResult({ ok: true, text: `Imported commit ${data.commit}: ${data.updated.length} updated, ${data.added.length} added, ${data.deleted.length} deleted. ${notes}`.trim() });
    } catch (err) {
      setResult({ ok: false, text: err instanceof Error ? err.message : String(err) });
      void check();
    } finally {
      setPushing(false);
    }
  };

  return (
    <Card className="p-3 w-full space-y-2" style={{ background: "#0a0a0f" }} data-testid="card-github-push">
      <div className="flex gap-2 w-full">
        <input
          className="flex-1 min-w-0 rounded-md border px-2 text-sm bg-transparent"
          placeholder="What changed? (optional commit message)"
          value={message}
          maxLength={300}
          onChange={e => setMessage(e.target.value)}
          disabled={!online || pushing}
          data-testid="input-github-message"
        />
        <Button className="gap-2" onClick={push} disabled={!online || pushing} data-testid="button-push-github">
          {pushing ? <Loader2 className="w-4 h-4 animate-spin" /> : online ? <Github className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
          {pushing ? "Working…" : "Push to GitHub"}
        </Button>
      </div>
      <Button
        variant="outline"
        className="w-full gap-2"
        onClick={() => runImport(true)}
        disabled={!online || pushing || !!plan}
        data-testid="button-import-github"
      >
        <Download className="w-4 h-4" /> Import from GitHub
      </Button>
      {plan && (
        <div className="rounded-md border p-2 space-y-2 text-[11px]" style={{ borderColor: "#a86" }} data-testid="panel-import-confirm">
          <p>
            Replace workspace files with GitHub commit {plan.commit}: <b>{plan.updated.length}</b> updated,{" "}
            <b>{plan.added.length}</b> added, <b>{plan.deleted.length}</b> deleted. Local changes to these files are lost.
          </p>
          <ul className="max-h-32 overflow-auto font-mono text-muted-foreground">
            {plan.updated.map(p => <li key={"u" + p}>~ {p}</li>)}
            {plan.added.map(p => <li key={"a" + p}>+ {p}</li>)}
            {plan.deleted.map(p => <li key={"d" + p} style={{ color: "#ff9999" }}>− {p}</li>)}
          </ul>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" className="flex-1" onClick={() => runImport(false)} disabled={pushing} data-testid="button-import-confirm">
              {pushing ? "Importing…" : "Import"}
            </Button>
            <Button size="sm" variant="outline" className="flex-1" onClick={() => setPlan(null)} disabled={pushing} data-testid="button-import-cancel">
              Cancel
            </Button>
          </div>
        </div>
      )}
      {!online && status && (
        <p className="text-[11px] text-muted-foreground" data-testid="text-github-offline">
          Offline — {browserOnline ? status.reason || "GitHub unreachable" : "No internet connection"}.{" "}
          <button className="underline" onClick={() => void check()}>Retry</button>
        </p>
      )}
      {result && (
        <p className="text-[11px]" style={{ color: result.ok ? "#9fdf9f" : "#ff9999" }} data-testid="text-github-result">
          {result.text}{" "}
          {result.url && <a className="underline" href={result.url} target="_blank" rel="noreferrer">View</a>}
        </p>
      )}
    </Card>
  );
}
