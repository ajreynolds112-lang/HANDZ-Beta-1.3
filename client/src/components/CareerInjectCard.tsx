import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import * as localSaves from "@/lib/localSaves";
import type { Fighter } from "@shared/schema";

export const MAX_INJECT = 999_999_999_999;

type Currency = "diamonds" | "force" | "shards";
const CURRENCIES: { key: Currency; label: string; color: string }[] = [
  { key: "diamonds", label: "Diamonds", color: "#aad4ff" },
  { key: "force", label: "Force", color: "#ffcc88" },
  { key: "shards", label: "Shards", color: "#d4aaff" },
];

/**
 * Admin currency injects for the career the Neural screen was opened from.
 * Every amount is written straight onto that career's fighter record — never
 * into player-level config — so deleting the career deletes it, and a new
 * career (fresh id) never starts with it.
 */
export default function CareerInjectCard({
  fighterId,
  onInjected,
}: {
  fighterId: string;
  onInjected?: (fighter: Fighter) => void;
}) {
  const [amounts, setAmounts] = useState<Record<Currency, string>>({ diamonds: "", force: "", shards: "" });
  const [pending, setPending] = useState<{ key: Currency; amount: number } | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const fighter = localSaves.getFighter(fighterId);
  if (!fighter) return null;

  const name = [fighter.firstName, fighter.lastName].filter(Boolean).join(" ") || "this career";
  const parse = (text: string) => {
    const n = Math.floor(Number(text));
    return Number.isFinite(n) && n >= 1 && n <= MAX_INJECT ? n : null;
  };
  const labelOf = (key: Currency) => CURRENCIES.find(c => c.key === key)!.label;

  const inject = () => {
    if (!pending) return;
    // Read the balance fresh at write time so nothing stale is added onto.
    const fresh = localSaves.getFighter(fighterId);
    if (!fresh) return;
    const { key, amount } = pending;
    const updated = localSaves.updateFighter(fighterId, { [key]: ((fresh[key] as number | null) ?? 0) + amount });
    if (updated) {
      onInjected?.(updated);
      setStatus(`Injected ${amount.toLocaleString()} ${labelOf(key)}. Balance: ${((updated[key] as number | null) ?? 0).toLocaleString()}`);
      setAmounts(prev => ({ ...prev, [key]: "" }));
    }
    setPending(null);
  };

  return (
    <Card className="p-3 w-full space-y-2" style={{ background: "#0a0f1a", border: "1px solid #1a2f4a" }} data-testid="card-career-inject">
      <div>
        <span className="text-xs font-semibold block" style={{ color: "#aad4ff" }}>Career Injects</span>
        <span className="text-[10px] block" style={{ color: "#6688aa" }}>
          Adds to {name} only. Up to {MAX_INJECT.toLocaleString()} per inject. Removed with the career; new careers start without it.
        </span>
      </div>
      {CURRENCIES.map(({ key, label, color }) => {
        const text = amounts[key];
        const amount = parse(text);
        return (
          <div key={key} className="space-y-1">
            <div className="flex gap-2 items-center">
              <span className="text-xs w-24 shrink-0" style={{ color }}>
                {label}
                <span className="block text-[10px]" style={{ color: "#6688aa" }}>{((fighter[key] as number | null) ?? 0).toLocaleString()}</span>
              </span>
              <Input
                type="number"
                min={1}
                max={MAX_INJECT}
                step={1}
                value={text}
                placeholder="Amount"
                onChange={(e) => { const v = e.target.value; setAmounts(prev => ({ ...prev, [key]: v })); setStatus(null); }}
                data-testid={`input-inject-${key}`}
              />
              <Button variant="outline" disabled={amount == null} onClick={() => amount != null && setPending({ key, amount })} data-testid={`button-inject-${key}`}>
                Inject
              </Button>
            </div>
            {text !== "" && amount == null && (
              <p className="text-[10px]" style={{ color: "#ff9999" }}>Enter a whole number from 1 to {MAX_INJECT.toLocaleString()}.</p>
            )}
          </div>
        );
      })}
      {status && <p className="text-[10px]" style={{ color: "#88ddaa" }} data-testid="text-inject-status">{status}</p>}
      <AlertDialog open={pending != null} onOpenChange={(open) => { if (!open) setPending(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Inject {pending ? labelOf(pending.key) : ""}?</AlertDialogTitle>
            <AlertDialogDescription>
              Add {pending ? pending.amount.toLocaleString() : 0} {pending ? labelOf(pending.key) : ""} to {name}. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-inject-cancel">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={inject} data-testid="button-inject-confirm">Inject</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
