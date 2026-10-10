import type { PunchType } from "./types";

export interface BagSessionPunch {
  type: PunchType;
  head: boolean;
}

const PUNCH_LABELS: Record<PunchType, string> = {
  jab: "Jab",
  cross: "Cross",
  leftHook: "Left Hook",
  rightHook: "Right Hook",
  leftUppercut: "Left Uppercut",
  rightUppercut: "Right Uppercut",
};

export function bagPunchLabel(punch: BagSessionPunch): string {
  return `${punch.head ? "" : "Body "}${PUNCH_LABELS[punch.type]}`;
}

/** Same non-overlapping groups of three used to credit free-bag practice. */
export function getTopBagCombos(punches: readonly BagSessionPunch[]): { label: string; count: number }[] {
  const counts = new Map<string, { label: string; count: number }>();
  for (let i = 0; i + 3 <= punches.length; i += 3) {
    const string = punches.slice(i, i + 3);
    const key = string.map(p => `${p.type}:${p.head ? "head" : "body"}`).join("|");
    const existing = counts.get(key);
    if (existing) existing.count++;
    else counts.set(key, { label: string.map(bagPunchLabel).join(" → "), count: 1 });
  }
  // Stable sorting preserves first occurrence when counts tie.
  return Array.from(counts.values()).sort((a, b) => b.count - a.count).slice(0, 3);
}
