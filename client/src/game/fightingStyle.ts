/**
 * Career fighting style: which base stance (orthodox/southpaw × Standard/Shell/
 * Hitman full guard) a fighter opens in, and which guard's defensive (perfect
 * block / shoulder roll) and punch animations it wears. Styles store guard
 * indices only, so they mirror with the fighter on every stance switch.
 */
import type { FightingStyleSave, SavedFightingStyle } from "@shared/schema";
import type { FighterState } from "./types";

export const STYLE_SLOT_COUNT = 5;
export const STYLE_NAME_MAX = 30;
export const BASE_STANCES = [
  "Standard Orthodox", "Standard Southpaw", "Orthodox Shell", "Southpaw Shell", "Orthodox Hitman", "Southpaw Hitman",
] as const;
export const ANIM_SETS = ["Standard", "Shell", "Hitman"] as const;
export const DEFENSE_COUNT = 8; // PB_VARIANTS
export const PUNCH_COUNT = 6; // PUNCH_ROLES

const idx = (v: unknown, n: number, d = 0) => (Number.isInteger(v) && (v as number) >= 0 && (v as number) < n ? (v as number) : d);
/** Per-animation source guards; an old single-number save fills every slot. */
const guards = (v: unknown, n: number, d: number) => Array.from({ length: n }, (_, i) => idx(Array.isArray(v) ? v[i] : v, 3, d));
/** A style with every animation from the base stance's own guard. */
export const styleForBase = (base: number) => {
  const g = Math.floor(base / 2);
  return { base, defense: Array<number>(DEFENSE_COUNT).fill(g), punches: Array<number>(PUNCH_COUNT).fill(g) };
};

export function cleanStyle(raw: unknown, i: number): SavedFightingStyle | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<SavedFightingStyle>;
  const name = typeof o.name === "string" && o.name.trim() ? o.name.slice(0, STYLE_NAME_MAX) : `Style ${i + 1}`;
  const base = idx(o.base, 6);
  return { name, base, defense: guards(o.defense, DEFENSE_COUNT, Math.floor(base / 2)), punches: guards(o.punches, PUNCH_COUNT, Math.floor(base / 2)) };
}

/** Always STYLE_SLOT_COUNT custom slots; a malformed active pick reads as none. */
export function fightingStyleOf(raw: unknown): FightingStyleSave {
  const o = (raw && typeof raw === "object" ? raw : {}) as Partial<FightingStyleSave>;
  const list = Array.isArray(o.custom) ? o.custom : [];
  const custom = Array.from({ length: STYLE_SLOT_COUNT }, (_, i) => cleanStyle(list[i], i));
  const a = o.active;
  let active: FightingStyleSave["active"] = null;
  if (a && a.kind === "preset" && Number.isInteger(a.index) && a.index >= 0 && a.index < 6) active = { kind: "preset", index: a.index };
  if (a && a.kind === "custom" && Number.isInteger(a.index) && custom[a.index]) active = { kind: "custom", index: a.index };
  return { active, custom };
}

/** Puts the career's style on the player's corner for one bout. No style chosen leaves the fighter untouched. */
export function applyFightingStyle(f: FighterState, raw: unknown): void {
  const s = fightingStyleOf(raw);
  if (!s.active) return;
  const style = s.active.kind === "preset" ? null : s.custom[s.active.index]!;
  const base = style ? style.base : s.active.index;
  f.boxingStance = base % 2 ? "southpaw" : "orthodox";
  f.guardStance = Math.floor(base / 2);
  // Presets keep the old all-in-one guard (Tab cycles it); a custom style is fixed for the bout.
  f.defenseStance = style ? [...style.defense] : undefined;
  f.punchStance = style ? [...style.punches] : undefined;
  f.guardStanceLocked = !!style;
}
