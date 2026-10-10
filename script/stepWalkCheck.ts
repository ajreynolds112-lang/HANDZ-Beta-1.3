/**
 * Player steps: a tap is one small step, a hold grows it big, holding chains
 * continuous walking, releasing finishes the step and plants; the rhythm marker
 * rides the step cycle (front foot at a step's ends, back foot halfway).
 *
 * Run: npx tsx --import ./script/lib/registerAssetStub.mjs script/stepWalkCheck.ts
 */
const { createInitialState, startFight, updateGame, handleKeyDown, handleKeyUp, STEP_SMALL_M, STEP_BIG_M } = await import("../client/src/game/engine");

let passed = 0, failed = 0;
const ok = (c: boolean, m: string) => { c ? passed++ : failed++; if (!c) console.log("  FAIL " + m); };
const ev = (key: string) => ({ key, code: "", repeat: false, preventDefault() {} }) as unknown as KeyboardEvent;
const dt = 1 / 60;

function fresh() {
  let s = startFight(createInitialState(), "BoxerPuncher", 1, 1);
  s.phase = "fighting"; s.dummyEnemy = true; s.isPaused = false;
  s.enemy.x = s.player.x + 400; // well out of contact
  return s;
}
function run(s: any, sec: number, each?: (s: any) => void) {
  for (let t = 0; t < sec; t += dt) { s = updateGame(s, dt); each?.(s); }
  return s;
}

// Tap: one small step, then planted on a whole cycle.
{
  let s = fresh();
  const x0 = s.player.x, c0 = s.player.walkCycle ?? 0;
  handleKeyDown(ev("ArrowRight")); s = run(s, 0.05); handleKeyUp(ev("ArrowRight"));
  ok(s.player.stepActive === true, "a tap's step keeps going after the key is released");
  s = run(s, 2);
  const moved = (s.player.x - x0) / 50;
  ok(!s.player.stepActive && (s.player.walkStride ?? 0) === 0, "tap: feet planted after the step");
  ok(Math.abs(moved - STEP_SMALL_M) < 0.02, `tap: one small step (${moved.toFixed(3)}m, want ${STEP_SMALL_M})`);
  ok((s.player.walkCycle ?? 0) - c0 === 1, "tap: exactly one step cycle");
  ok(s.player.swayOffset > 4.5, "tap: rhythm back on the front foot when planted");
}
// Hold under 0.3s: one big step.
{
  let s = fresh();
  const x0 = s.player.x;
  handleKeyDown(ev("ArrowRight")); s = run(s, 0.2); handleKeyUp(ev("ArrowRight"));
  s = run(s, 2);
  const moved = (s.player.x - x0) / 50;
  ok(Math.abs(moved - STEP_BIG_M) < 0.02, `short hold: one big step (${moved.toFixed(3)}m, want ${STEP_BIG_M})`);
}
// Long hold: continuous walking, rhythm follows the feet, then plants on release.
{
  let s = fresh();
  let backFoot = false, frontFoot = false;
  handleKeyDown(ev("ArrowRight"));
  s = run(s, 1.5, st => { if (st.player.swayOffset < -4) backFoot = true; if (st.player.swayOffset > 4) frontFoot = true; });
  const cycles = s.player.walkCycle ?? 0;
  ok(cycles > 2, `held: steps chain into continuous walking (${cycles.toFixed(2)} cycles)`);
  ok(backFoot && frontFoot, "held: rhythm swings front foot ↔ back foot with the steps");
  handleKeyUp(ev("ArrowRight"));
  s = run(s, 2);
  const c = s.player.walkCycle ?? 0;
  ok(!s.player.stepActive && c === Math.round(c), "release: finishes the step in hand and plants");
}

console.log(failed === 0 ? `All ${passed} step checks passed.` : `${failed} of ${passed + failed} step checks FAILED.`);
process.exit(failed === 0 ? 0 : 1);
