import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { GUARD_STANCE_LABELS, loadGuardStanceAssign, setGuardStanceAssign } from "@/game/three/poseOffsets";

const RANDOM = "random";

/** Edit Roster: this opponent's starting full-guard stance. Saves immediately. */
export default function GuardStanceAssignCard({ rosterId }: { rosterId: number }) {
  const [val, setVal] = useState(() => {
    const a = loadGuardStanceAssign()[rosterId];
    return a === 0 || a === 1 || a === 2 ? String(a) : RANDOM;
  });
  return (
    <Card className="p-3 w-full flex items-center gap-2" data-testid="card-guard-stance">
      <span className="text-sm font-semibold mr-auto">Stance</span>
      <Select value={val} onValueChange={v => { setGuardStanceAssign(rosterId, v === RANDOM ? null : Number(v)); setVal(v); }}>
        <SelectTrigger className="h-7 text-xs w-52" data-testid="select-guard-stance"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={RANDOM}>Random</SelectItem>
          {GUARD_STANCE_LABELS.map((l, i) => <SelectItem key={i} value={String(i)}>{l}</SelectItem>)}
        </SelectContent>
      </Select>
    </Card>
  );
}
