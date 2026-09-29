import { useRef, useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Download, Upload, Plus, Trash2 } from "lucide-react";
import { AI_STRINGS } from "@/game/aiStrings";
import { RL_OBS_SIZE } from "@/game/rlObservation";
import { createRlPolicy, rlPolicyToJson, RL_UTILITY_LABELS, RL_UTILITIES } from "@/game/rlPolicy";
import {
  loadRlDeployConfig,
  saveRlDeployConfig,
  rlPolicyDeployProblem,
  RL_DEPLOY_MODES,
  RL_DEPLOY_MODE_LABELS,
  type RlDeployConfig,
  type RlDeployMode,
} from "@/game/rlDeploy";
import type { RlPolicyJson } from "@/game/rlPolicy";

/**
 * Deployment of the RL tactical policy: where it is used, and the weights it
 * runs. Takes effect from the next fight -- brains pick the policy up when
 * they are built.
 */
export function RlPolicyCard() {
  const [cfg, setCfg] = useState<RlDeployConfig>(() => loadRlDeployConfig());
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const write = (next: RlDeployConfig) => {
    setCfg(next);
    saveRlDeployConfig(next);
  };

  const setMode = (mode: RlDeployMode) => write({ ...cfg, mode });

  const download = () => {
    if (!cfg.policy) return;
    const blob = new Blob([JSON.stringify(cfg.policy)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `handz-rl-policy-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const upload = async (file: File) => {
    try {
      const data = JSON.parse(await file.text());
      const problem = rlPolicyDeployProblem(data);
      if (problem) {
        setMsg({ text: problem, bad: true });
        return;
      }
      write({ ...cfg, policy: data as RlPolicyJson });
      setMsg({ text: `Loaded ${file.name}.`, bad: false });
    } catch {
      setMsg({ text: "That file is not valid JSON.", bad: true });
    }
  };

  // The deployed policy is what the next publish ships, so replacing a trained
  // one is confirmed rather than a single stray click.
  const confirmReplaceTrained = (what: string) =>
    !(cfg.policy?.meta?.trainedSteps) ||
    window.confirm(`${what} the trained policy (${cfg.policy.meta.trainedSteps.toLocaleString()} steps)? Your next publish will ship this instead. Deploy from AI Training again to bring the trained one back.`);

  const createUntrained = () => {
    if (!confirmReplaceTrained("Replace")) return;
    const policy = createRlPolicy({
      obsSize: RL_OBS_SIZE,
      stringIds: AI_STRINGS.map((d) => d.id),
      seed: Math.floor(Math.random() * 2 ** 31),
      meta: { note: "untrained" },
    });
    write({ ...cfg, policy: rlPolicyToJson(policy) });
    setMsg({ text: "Created an untrained policy (near-uniform choices).", bad: false });
  };

  const clearPolicy = () => {
    if (!confirmReplaceTrained("Remove")) return;
    write({ ...cfg, policy: null });
    setMsg({ text: "Policy removed.", bad: false });
  };

  const p = cfg.policy;
  const active = cfg.mode !== "off" && !!p;

  return (
    <Card className="p-3 w-full space-y-3" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }} data-testid="card-rl-policy">
      <div>
        <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>RL Tactical Policy</p>
        <p className="text-[10px]" style={{ color: "#66aa66" }}>
          A trained network picks the string, its tempo and a utility ({RL_UTILITIES.map((u) => RL_UTILITY_LABELS[u]).join(", ")}).
          Movement, timing of attacks and defence stay with the normal AI. Applies from the next fight.
        </p>
      </div>

      <div className="flex items-center gap-1" role="radiogroup" aria-label="Use RL policy for">
        {RL_DEPLOY_MODES.map((m) => (
          <Button
            key={m}
            size="sm"
            variant={cfg.mode === m ? "default" : "outline"}
            onClick={() => setMode(m)}
            className="text-xs h-7 px-2"
            role="radio"
            aria-checked={cfg.mode === m}
            data-testid={`button-rl-mode-${m}`}
          >
            {RL_DEPLOY_MODE_LABELS[m]}
          </Button>
        ))}
      </div>

      <div className="text-[11px] space-y-0.5" style={{ color: "#88cc88" }} data-testid="text-rl-policy-status">
        {p ? (
          <>
            <div>
              {p.shape.nStrings} strings · {p.shape.nTempo} tempo bins · {p.shape.hidden1}×{p.shape.hidden2} hidden
            </div>
            <div>
              Trained steps: {p.meta?.trainedSteps ?? 0}
              {p.meta?.note ? ` · ${p.meta.note}` : ""}
              {p.meta?.createdAt ? ` · ${p.meta.createdAt.slice(0, 10)}` : ""}
            </div>
          </>
        ) : (
          <div>No policy loaded.</div>
        )}
        <div style={{ color: active ? "#c8ffaa" : "#66aa66" }}>
          {active
            ? `In use: ${cfg.mode === "champion" ? "Champion difficulty only" : "every AI opponent"}.`
            : cfg.mode !== "off"
              ? "Not in use: load a policy first."
              : "Not in use."}
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        <Button size="sm" variant="outline" className="text-xs h-7 px-2" onClick={download} disabled={!p} data-testid="button-rl-download">
          <Download className="w-3 h-3 mr-1" /> Download
        </Button>
        <Button size="sm" variant="outline" className="text-xs h-7 px-2" onClick={() => fileRef.current?.click()} data-testid="button-rl-upload">
          <Upload className="w-3 h-3 mr-1" /> Upload
        </Button>
        <Button size="sm" variant="outline" className="text-xs h-7 px-2" onClick={createUntrained} data-testid="button-rl-create">
          <Plus className="w-3 h-3 mr-1" /> New untrained
        </Button>
        <Button size="sm" variant="outline" className="text-xs h-7 px-2" onClick={clearPolicy} disabled={!p} data-testid="button-rl-clear">
          <Trash2 className="w-3 h-3 mr-1" /> Remove
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) void upload(f);
          }}
          data-testid="input-rl-upload"
        />
      </div>
      {msg && (
        <p className="text-[10px]" style={{ color: msg.bad ? "#ff8888" : "#88cc88" }} data-testid="text-rl-message">
          {msg.text}
        </p>
      )}
    </Card>
  );
}
