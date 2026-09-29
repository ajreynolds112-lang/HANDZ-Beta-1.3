/**
 * "Push to GitHub" at the top of the Neural Network screen: commits the
 * workspace's source files to the HANDZ repo (server/githubPush.ts).
 * Enabled only while online — the browser must be online and the server must
 * reach GitHub — and only in the workspace, never on the published site.
 */
import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Github, Loader2, WifiOff } from "lucide-react";

type Status = { available: boolean; online: boolean; reason?: string };

export default function GithubPushCard() {
  const [status, setStatus] = useState<Status | null>(null);
  const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
  const [message, setMessage] = useState("");
  const [pushing, setPushing] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string; url?: string } | null>(null);

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
          {pushing ? "Pushing…" : "Push to GitHub"}
        </Button>
      </div>
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
