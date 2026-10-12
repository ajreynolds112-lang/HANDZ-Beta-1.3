import type { CustomDecal, CustomDecalLayer } from "@shared/schema";

/**
 * Twenty ready-made gear decals. The player can buy a copy for PREMADE_DECAL_COST
 * diamonds; roster fighters wear the originals (one each, fixed per fighter id).
 * Ids are permanent — saves and roster colours reference them.
 */
export const PREMADE_DECAL_COST = 1;
export const PREMADE_DECAL_PREFIX = "pm_";

// Design space is 512 × 288 (DECAL_W × DECAL_H), hardcoded to avoid an import cycle.
const CX = 256, CY = 144;

type Extra = Partial<CustomDecalLayer>;
let n = 0;
const base = (): Omit<CustomDecalLayer, "kind" | "x" | "y" | "w" | "h" | "color"> =>
  ({ id: `pml${n++}`, rotation: 0, skewX: 0, skewY: 0, opacity: 1 });
const sh = (shape: string, x: number, y: number, w: number, h: number, color: string, e: Extra = {}): CustomDecalLayer =>
  ({ ...base(), kind: "shape", shape, x, y, w, h, color, ...e });
const tx = (text: string, font: string, x: number, y: number, w: number, h: number, color: string, e: Extra = {}): CustomDecalLayer =>
  ({ ...base(), kind: "text", text, font, fontSize: 96, bold: false, italic: false, arc: 0, x, y, w, h, color, ...e });

const decal = (key: string, name: string, background: string | null, layers: CustomDecalLayer[]): CustomDecal =>
  ({ id: PREMADE_DECAL_PREFIX + key, name, background, layers, updatedAt: 1, purchased: true });

export const PREMADE_DECALS: CustomDecal[] = [
  decal("champ", "Gold Champ", "#ffffff", [
    sh("star", CX, 120, 150, 150, "#f5c518", { strokeColor: "#14213d", strokeWidth: 5 }),
    tx("CHAMP", "Varsity Team", CX, 238, 300, 70, "#14213d", { arc: 20 }),
  ]),
  decal("ko", "Knockout", "#c1121f", [
    sh("chevron", CX, 70, 420, 60, "#ffffff", { opacity: 0.25 }),
    tx("K.O.", "Freshman", CX, 160, 380, 170, "#ffffff", { strokeColor: "#000000", strokeWidth: 6 }),
  ]),
  decal("thunder", "Thunder", "#ffffff", [
    sh("parallelogram", 180, 100, 180, 40, "#ffd60a", { rotation: -20, strokeColor: "#111111", strokeWidth: 4 }),
    sh("parallelogram", 330, 100, 180, 40, "#ffd60a", { rotation: 20, strokeColor: "#111111", strokeWidth: 4 }),
    tx("THUNDER", "Sports World", CX, 205, 440, 90, "#111111"),
  ]),
  decal("heart", "Heartbreaker", "#ffffff", [
    sh("heart", CX, 110, 150, 140, "#d00000"),
    tx("HEARTBREAKER", "College Bold", CX, 238, 460, 60, "#d00000"),
  ]),
  decal("guard", "Hex Guard", "#ffffff", [
    sh("hexagon", CX, CY, 260, 260, "#95d5b2", { opacity: 0.5 }),
    sh("ring", CX, CY, 230, 230, "#1b4332"),
    tx("GUARD", "College Slab", CX, CY, 260, 80, "#1b4332"),
  ]),
  decal("target", "Bullseye", "#ffffff", [
    sh("ring", CX, 120, 200, 200, "#e63946"),
    sh("ellipse", CX, 120, 70, 70, "#e63946"),
    tx("TARGET", "Jersey Letters", CX, 252, 300, 54, "#1d3557"),
  ]),
  decal("royal", "Royal Diamond", "#ffffff", [
    sh("diamond", CX, 115, 170, 170, "#9d4edd", { strokeColor: "#5a189a", strokeWidth: 5 }),
    tx("ROYAL", "Allstar", CX, 245, 300, 64, "#5a189a"),
  ]),
  decal("south", "Southside", "#f77f00", [
    sh("line", CX, 60, 440, 8, "#ffffff"),
    sh("line", CX, 228, 440, 8, "#ffffff"),
    tx("SOUTHSIDE", "Pop Warner", CX, CY, 440, 110, "#ffffff", { strokeColor: "#000000", strokeWidth: 4, arc: -18 }),
  ]),
  decal("phoenix", "Phoenix", "#ffffff", [
    sh("triangle", 200, 110, 90, 150, "#ffba08", { rotation: -18 }),
    sh("triangle", CX, 95, 110, 180, "#e85d04"),
    sh("triangle", 312, 110, 90, 150, "#ffba08", { rotation: 18 }),
    tx("PHOENIX", "Nebraska", CX, 245, 380, 70, "#6a040f"),
  ]),
  decal("mercy", "No Mercy", "#212529", [
    sh("roundRect", CX, CY, 470, 250, "#212529", { strokeColor: "#ffffff", strokeWidth: 8 }),
    tx("NO", "Bascula College", CX, 95, 160, 80, "#ffffff"),
    tx("MERCY", "Bascula College", CX, 190, 380, 100, "#e5383b"),
  ]),
  decal("ironjaw", "Iron Jaw", "#ffffff", [
    sh("rect", CX, CY, 480, 120, "#111111"),
    sh("line", CX, 66, 480, 6, "#111111"),
    sh("line", CX, 222, 480, 6, "#111111"),
    tx("IRON JAW", "Sports Jersey", CX, CY, 430, 90, "#ffffff"),
  ]),
  decal("king", "Crown", "#ffffff", [
    sh("triangle", 196, 80, 70, 90, "#f5c518"),
    sh("triangle", CX, 70, 80, 110, "#f5c518"),
    sh("triangle", 316, 80, 70, 90, "#f5c518"),
    sh("rect", CX, 140, 200, 36, "#f5c518"),
    tx("KING", "FM University", CX, 230, 280, 80, "#111111"),
  ]),
  decal("lucky", "Lucky Seven", "#ffffff", [
    sh("ellipse", CX, 115, 170, 170, "#2d6a4f"),
    tx("7", "Freshman", CX, 115, 90, 140, "#ffffff"),
    tx("LUCKY", "Varsity Team", CX, 250, 280, 60, "#2d6a4f"),
  ]),
  decal("hurricane", "Hurricane", "#ffffff", [
    sh("ring", CX, 110, 190, 190, "#0077b6"),
    sh("ring", CX, 110, 120, 120, "#00b4d8"),
    sh("ellipse", CX, 110, 44, 44, "#03045e"),
    tx("HURRICANE", "Station 232", CX, 248, 440, 60, "#03045e"),
  ]),
  decal("ice", "Ice Cold", "#ffffff", [
    sh("diamond", 150, 95, 70, 110, "#90e0ef"),
    sh("diamond", CX, 85, 90, 140, "#48cae4"),
    sh("diamond", 362, 95, 70, 110, "#90e0ef"),
    tx("ICE COLD", "Graduate Shades", CX, 230, 420, 80, "#0077b6"),
  ]),
  decal("brawler", "Brawler", "#ffffff", [
    sh("chevron", CX, 60, 300, 50, "#d00000"),
    sh("chevron", CX, 110, 300, 50, "#d00000", { opacity: 0.6 }),
    tx("BRAWLER", "Hollywood Hills", CX, 215, 440, 100, "#111111"),
  ]),
  decal("spartan", "Spartan", "#ffffff", [
    sh("parallelogram", CX, 62, 440, 26, "#8b0000"),
    sh("parallelogram", CX, 226, 440, 26, "#8b0000"),
    tx("SPARTAN", "FM College Team", CX, CY, 440, 110, "#8b0000"),
  ]),
  decal("viper", "Viper", "#ffffff", [
    sh("triangle", CX, 85, 120, 100, "#2d6a4f", { rotation: 180 }),
    sh("line", CX, 160, 380, 6, "#2d6a4f"),
    tx("VIPER", "Emilio 20", CX, 225, 340, 90, "#1b4332"),
  ]),
  decal("midnight", "Midnight", "#0d1b2a", [
    sh("star", 130, 80, 50, 50, "#e0e1dd"),
    sh("star", CX, 60, 70, 70, "#e0e1dd"),
    sh("star", 382, 80, 50, 50, "#e0e1dd"),
    tx("MIDNIGHT", "Allstar", CX, 190, 440, 90, "#e0e1dd"),
  ]),
  decal("spots", "Spotlight", "#ffffff", [
    sh("ellipse", CX, CY, 460, 230, "#111111", { opacity: 0.08 }),
    tx("SPOTLIGHT", "Dalmation", CX, CY, 440, 110, "#111111"),
  ]),
];

const BY_ID = new Map(PREMADE_DECALS.map(d => [d.id, d]));
export function premadeDecal(id: string): CustomDecal | undefined {
  return BY_ID.get(id);
}

/** The premade decal a roster fighter wears — fixed per id, spread across all of them. */
export function premadeDecalForRoster(rosterId: number): CustomDecal {
  const h = Math.imul(rosterId + 1, 2654435761) >>> 0;
  return PREMADE_DECALS[(h >>> 7) % PREMADE_DECALS.length];
}
