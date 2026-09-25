// Verifies the rewired curve: defaults must reproduce the old /99 behaviour
// exactly, and raising the top level must spread growth linearly to 1000.
const store: Record<string, string> = {};
(globalThis as any).localStorage = {
  getItem: (k: string) => (k in store ? store[k] : null),
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
};

import {
  levelScale, setRampMaxLevel, reloadScaling, getScaling,
  setRampField, resetScaling, LEVEL_RAMP_DEFS, POINT_COEF_DEFS,
} from "../client/src/lib/scalingConfig";

let fails = 0;
const near = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
function ok(name: string, cond: boolean, extra = "") {
  if (!cond) { fails++; console.log("  FAIL " + name + " " + extra); }
  else console.log("  ok   " + name);
}

const legacy = (lv: number, a: number, b: number) => {
  const t = Math.max(0, Math.min(1, (lv - 1) / 99));
  return a + (b - a) * t;
};

console.log("1. defaults reproduce the historical /99 curve");
for (const lv of [1, 2, 37, 50, 99, 100, 250, 1000]) {
  ok(`damage @L${lv}`, near(levelScale(lv, 1, 3.5, "damageMult"), legacy(lv, 1, 3.5)));
}
ok("L100 === L1000 today", near(levelScale(100, 1, 3.5, "damageMult"), levelScale(1000, 1, 3.5, "damageMult")));

console.log("\n2. every ramp id resolves to its declared endpoints");
for (const d of LEVEL_RAMP_DEFS) {
  const at1 = levelScale(1, 0, 0, d.id);
  const atTop = levelScale(100, 0, 0, d.id);
  if (!near(at1, d.min) || !near(atTop, d.max)) {
    fails++; console.log(`  FAIL ${d.id}: got ${at1}..${atTop} want ${d.min}..${d.max}`);
  }
}
ok("all " + LEVEL_RAMP_DEFS.length + " ramps resolve", true);

console.log("\n3. raising the top level linearises to 1000");
setRampMaxLevel(1000);
ok("L1 unchanged", near(levelScale(1, 1, 3.5, "damageMult"), 1));
ok("L1000 hits the end value", near(levelScale(1000, 1, 3.5, "damageMult"), 3.5));
ok("L100 is now only ~9.9% along", near(levelScale(100, 1, 3.5, "damageMult"), 1 + 2.5 * (99 / 999)));
ok("L500 beats L100", levelScale(500, 1, 3.5, "damageMult") > levelScale(100, 1, 3.5, "damageMult"));
ok("growth is monotonic 100->1000",
  levelScale(1000, 1, 3.5, "damageMult") > levelScale(750, 1, 3.5, "damageMult") &&
  levelScale(750, 1, 3.5, "damageMult") > levelScale(500, 1, 3.5, "damageMult"));

console.log("\n4. edits persist and reload from storage");
setRampField("damageMult", "max", 7);
ok("edit is live immediately", near(levelScale(1000, 1, 3.5, "damageMult"), 7));
reloadScaling();
ok("edit survives a cache drop", near(levelScale(1000, 1, 3.5, "damageMult"), 7));
ok("top level survived too", getScaling().rampMaxLevel === 1000);

console.log("\n5. an older config missing new keys backfills instead of zeroing");
store["handz_scaling_config"] = JSON.stringify({ rampMaxLevel: 400, ramps: { damageMult: { max: 9 } } });
reloadScaling();
const c = getScaling();
ok("saved field wins", c.ramps.damageMult.max === 9);
ok("absent field keeps its default min", c.ramps.damageMult.min === 1);
ok("absent ramp keeps defaults", c.ramps.maxStamina.max === 10);
ok("absent point coef keeps default", c.points.powerDamage === 15);
ok("absent caps keep defaults", c.caps.maxSp === 1000 && c.caps.speedSoftCap === 220);
ok("garbage rampMaxLevel is rejected", (() => {
  store["handz_scaling_config"] = JSON.stringify({ rampMaxLevel: "nope" });
  reloadScaling();
  return getScaling().rampMaxLevel === 100;
})());

console.log("\n6. stat-point effects read out at 0 and 1000 points");
resetScaling();
const caps = getScaling().caps;
for (const d of POINT_COEF_DEFS) {
  const lo = d.atPoints(d.value, 0, caps);
  const hi = d.atPoints(d.value, 1000, caps);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) { fails++; console.log(`  FAIL ${d.id} produced ${lo}/${hi}`); }
}
ok("all " + POINT_COEF_DEFS.length + " coefficients evaluate", true);
ok("power still reaches 16x", near(POINT_COEF_DEFS.find(d => d.id === "powerDamage")!.atPoints(15, 1000, caps), 16));
ok("speed still caps at 2.57x", near(POINT_COEF_DEFS.find(d => d.id === "speedPunch")!.atPoints(1.427, 1000, caps), 1 + 1.1 * 1.427));
ok("regen still caps at 1.75x", near(POINT_COEF_DEFS.find(d => d.id === "staminaRegen")!.atPoints(0.6, 1000, caps), 1.75));
ok("telegraph-chase speed is uncapped at 7.7x",
  near(POINT_COEF_DEFS.find(d => d.id === "speedChaseOnTelegraph")!.atPoints(0.65, 1000, caps), 7.7));

console.log("\n7. the effects the first review pass missed are on the curve");
ok("guard-raise late ramp is tunable", getScaling().points.defenseAutoGuardRamp === 9);
ok("blink chance ramps 0.75 -> 0.50", near(levelScale(1, 0, 0, "telegraphBlinkChance"), 0.75)
  && near(levelScale(100, 0, 0, "telegraphBlinkChance"), 0.50));
ok("blink chance matches the old inline formula at L50",
  near(levelScale(50, 0, 0, "telegraphBlinkChance"), 0.75 - 0.25 * ((50 - 1) / 99)));

console.log(fails === 0 ? "\nAll scaling config checks passed." : `\n${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
