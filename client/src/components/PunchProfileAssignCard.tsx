import { useState } from "react";
import { Shuffle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { PunchType } from "@/game/types";
import {
  PUNCH_ROLES, PUNCH_ROLE_LABEL, loadAssignments, loadProfileStore, randomAssignments, setAssignments,
} from "@/game/three/punchProfiles";

const DEFAULT = "default";

/** Edit Roster: which saved punch-animation profile this opponent wears for each punch. Saves immediately. */
export default function PunchProfileAssignCard({ rosterId }: { rosterId: number }) {
  const store = loadProfileStore();
  const [assign, setAssign] = useState<Partial<Record<PunchType, number>>>(() => ({ ...loadAssignments()[rosterId] }));
  const write = (next: Partial<Record<PunchType, number>>) => {
    setAssignments(rosterId, next);
    setAssign({ ...loadAssignments()[rosterId] });
  };
  const anySaved = PUNCH_ROLES.some(r => store.slots[r].some(Boolean));

  return (
    <Card className="p-3 w-full flex flex-col gap-2" data-testid="card-punch-profiles">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold mr-auto">Punch Animations</span>
        <Button size="sm" variant="outline" className="h-7 text-xs gap-1" disabled={!anySaved}
          onClick={() => write(randomAssignments())} data-testid="button-punch-profiles-random">
          <Shuffle className="w-3 h-3" /> Random
        </Button>
        <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={!Object.keys(assign).length}
          onClick={() => write({})} data-testid="button-punch-profiles-clear">Clear</Button>
      </div>
      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5">
        {PUNCH_ROLES.map(r => {
          const def = store.active[r];
          const defName = def >= 0 ? `Default (#${def + 1} ${store.slots[r][def]?.name || "Untitled"})` : "Default (stock)";
          const val = assign[r] != null && store.slots[r][assign[r]!] ? String(assign[r]) : DEFAULT;
          return (
            <div key={r} className="flex flex-col gap-0.5">
              <span className="text-[11px] text-muted-foreground">{PUNCH_ROLE_LABEL[r]}</span>
              <Select value={val} onValueChange={v => write({ ...assign, [r]: v === DEFAULT ? undefined : Number(v) })}>
                <SelectTrigger className="h-7 text-xs" data-testid={`select-punch-profile-${r}`}><SelectValue /></SelectTrigger>
                <SelectContent className="max-h-72">
                  <SelectItem value={DEFAULT}>{defName}</SelectItem>
                  {store.slots[r].map((p, i) => p && <SelectItem key={i} value={String(i)}>#{i + 1} {p.name || "Untitled"}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          );
        })}
      </div>
      {!anySaved && <p className="text-[11px] text-muted-foreground">No saved profiles yet. Make them in Neural Network → Punch Animation.</p>}
    </Card>
  );
}
