/** Neural Network → Gym Names: rename the challenger gyms. Blank = stock name. */
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { AWAY_GYMS, GYM_NAME_MAX, applyAwayGymNames, loadAwayGymNames, saveAwayGymNames, stockAwayGymName } from "@/game/gymLook";

export default function GymNamesCard() {
  const [names, setNames] = useState<string[]>(() => {
    // Remounted after a parameter upload: pick up the uploaded names.
    const n = loadAwayGymNames();
    applyAwayGymNames(n);
    return n;
  });
  const set = (i: number, v: string) => {
    const next = AWAY_GYMS.map((_, j) => (j === i ? v.slice(0, GYM_NAME_MAX) : names[j] ?? ""));
    setNames(next);
    saveAwayGymNames(next);
  };
  return (
    <Card className="p-3 w-full space-y-2" style={{ background: "#0a1a0a", border: "1px solid #1a4a1a" }} data-testid="card-gym-names">
      <p className="text-sm font-semibold" style={{ color: "#c8ffaa" }}>Gym Names</p>
      {AWAY_GYMS.map((_, i) => (
        <Input
          key={i}
          value={names[i] ?? ""}
          placeholder={stockAwayGymName(i)}
          maxLength={GYM_NAME_MAX}
          onChange={e => set(i, e.target.value)}
          className="h-7 text-xs"
          data-testid={`input-gym-name-${i}`}
        />
      ))}
    </Card>
  );
}
