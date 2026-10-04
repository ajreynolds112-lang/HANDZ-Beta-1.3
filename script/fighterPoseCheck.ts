/**
 * 3D fighter pose checks: punches target what the engine scores (head vs body)
 * and gloves physically reach the opponent at the real hit range, for both
 * stances, both corners and both rigs (Tripo GLB and the code fallback).
 *
 * Run: npx tsx --import ./script/lib/registerAssetStub.mjs script/fighterPoseCheck.ts
 */
import { readFileSync } from "node:fs";
import * as THREE from "three";

// ── headless shims: serve /models/* from client/public, and the DOM bits GLTFLoader touches ──
const realFetch = globalThis.fetch;
(globalThis as any).ProgressEvent ??= class extends Event {
  constructor(t: string, o: Record<string, unknown> = {}) { super(t); Object.assign(this, o); }
};
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest {
  constructor(input: any, init?: any) { super(typeof input === "string" && input.startsWith("/") ? "http://local" + input : input, init); }
} as typeof Request;
globalThis.fetch = (async (url: any, init?: any) => {
  const u = typeof url === "string" ? url : url.url;
  const m = /^(?:http:\/\/local)?(\/models\/.*)$/.exec(u);
  if (m) return new Response(readFileSync("client/public" + m[1]));
  return realFetch(url, init);
}) as typeof fetch;

const { createInitialState, getPunchReachPx } = await import("../client/src/game/engine");
const { Fighter3D } = await import("../client/src/game/three/fighterModel");
const { punchHitsHead } = await import("../client/src/game/three/fighterPose");
const { ensureFighterAssets, fighterAssetEpoch } = await import("../client/src/game/three/fighterRig");
const { PX_PER_UNIT, MAT_HEIGHT } = await import("../client/src/game/three/worldMapping");
type FS = import("../client/src/game/types").FighterState;
type PT = import("../client/src/game/types").PunchType;

let failed = 0, passed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) passed++; else { failed++; console.log(`  FAIL ${msg}`); }
}

// ── 1. head/body selection mirrors tryHit ──
console.log("1. head/body selection mirrors the engine");
{
  const f = createInitialState().player;
  f.defenseState = "none" as FS["defenseState"];
  f.punchAimsHead = false;
  ok(punchHitsHead(f, "jab"), "standing jab with the aim flag off still goes to the head");
  ok(punchHitsHead(f, "cross"), "standing cross goes to the head");
  ok(punchHitsHead(f, "leftHook"), "standing hook goes to the head");
  f.punchAimsHead = true;
  ok(!punchHitsHead(f, "leftUppercut"), "uppercut is a body shot even with the aim flag on");
  ok(!punchHitsHead(f, "rightUppercut"), "rear uppercut is a body shot too");
  f.defenseState = "duck" as FS["defenseState"];
  ok(punchHitsHead(f, "jab"), "ducking jab aimed high goes to the head");
  ok(!punchHitsHead(f, "rightUppercut"), "ducking uppercut aimed high is still a body shot");
  f.punchAimsHead = false;
  ok(!punchHitsHead(f, "jab"), "ducking jab aimed low goes to the body");
  ok(!punchHitsHead(f, "rightHook"), "ducking hook aimed low goes to the body");
}

// ── 2. gloves reach the opponent at the real hit range ──
const PUNCHES: PT[] = ["jab", "cross", "leftHook", "rightHook", "leftUppercut", "rightUppercut"];
const LEFT = new Set<PT>(["jab", "leftHook", "leftUppercut"]);

function reachCase(rigLabel: string, stance: "orthodox" | "southpaw", corner: "player" | "enemy", punch: PT, ducking: boolean, angle: number) {
  const st = createInitialState();
  const att = corner === "player" ? st.player : st.enemy;
  const def = corner === "player" ? st.enemy : st.player;
  // Arms never stretch, so the glove only lands where the target is within arm's
  // length; test at a close-range distance inside every punch's real hit range.
  const D = Math.min(getPunchReachPx(att, punch), 40);
  att.x = 400; att.z = 300;
  att.facingAngle = angle;
  def.x = att.x + Math.cos(angle) * D;
  def.z = att.z + Math.sin(angle) * D;
  def.facingAngle = angle + Math.PI;
  att.boxingStance = stance as FS["boxingStance"];
  att.defenseState = (ducking ? "duck" : "none") as FS["defenseState"];
  att.punchAimsHead = !ducking;
  att.isPunching = true;
  att.currentPunch = punch;
  att.punchPhase = "contact" as FS["punchPhase"];
  att.punchProgress = 0.5;
  att.isFeinting = false;

  const fig = new Fighter3D() as any;
  ok(fig.kind === rigLabel, `${rigLabel} rig built`);
  fig.mem.stanceBlend = stance === "southpaw" ? 1 : 0;
  fig.update(att, st.playerColors, def, st, 1);
  fig.root.updateMatrixWorld(true);
  const left = LEFT.has(punch);
  const glove = (left ? fig.rig.gloveCenter.left : fig.rig.gloveCenter.right).getWorldPosition(new THREE.Vector3());
  const defPos = new THREE.Vector3(def.x / PX_PER_UNIT, 0, def.z / PX_PER_UNIT);
  // toSceneX/Z are offset from the ring centre; compare relative to the attacker instead.
  const attPos = fig.root.position.clone();
  const rel = new THREE.Vector3(glove.x - attPos.x, glove.y - MAT_HEIGHT, glove.z - attPos.z);
  const want = defPos.clone().sub(new THREE.Vector3(att.x / PX_PER_UNIT, 0, att.z / PX_PER_UNIT));
  const head = punchHitsHead(att, punch);
  const surface = head ? 0.14 : 0.2;
  const dims = fig.dims;
  const wantY = head ? dims.headY - 0.05 : dims.chest.y - 0.18;
  const gap = Math.hypot(want.x - rel.x, want.z - rel.z);
  const tag = `${rigLabel} ${stance} ${corner} ${punch}${ducking ? " (ducking)" : ""} @${angle.toFixed(2)}`;
  ok(Math.abs(gap - surface) < 0.07, `${tag}: glove ${gap.toFixed(2)}m from the opponent's centre, want ${surface}`);
  ok(Math.abs(rel.y - wantY) < 0.08, `${tag}: glove at ${rel.y.toFixed(2)}m, want ${head ? "head" : "body"} height ${wantY.toFixed(2)}`);
  // At the far end of the real range the arm goes straight but never stretches.
  def.x = att.x + Math.cos(angle) * getPunchReachPx(att, punch) * 1.5;
  def.z = att.z + Math.sin(angle) * getPunchReachPx(att, punch) * 1.5;
  fig.update(att, st.playerColors, def, st, 1);
  fig.root.updateMatrixWorld(true);
  const s = left ? "Left" : "Right";
  if (fig.bind) for (const b of [`${s}ForeArm`, `${s}Hand`]) {
    const bb = fig.bind[b];
    ok(bb.bone.position.distanceTo(bb.localPos) < 1e-6, `${tag}: ${b} keeps its bind length at long range`);
  }
  fig.dispose();
}

function reachSuite(rigLabel: string) {
  console.log(`2. gloves land in arm range, arms never stretch (${rigLabel} rig)`);
  for (const stance of ["orthodox", "southpaw"] as const)
    for (const corner of ["player", "enemy"] as const)
      for (const punch of PUNCHES)
        for (const angle of corner === "player" ? [0, 0.6] : [Math.PI, Math.PI + 0.6])
          reachCase(rigLabel, stance, corner, punch, false, angle);
  for (const punch of ["jab", "cross"] as PT[]) reachCase(rigLabel, "orthodox", "player", punch, true, 0);
}

reachSuite("code");

// ── 3. knockdown staging: down on the canvas, a knee stays up, get-up returns to standing ──
const { KD_FALL_DURATION } = await import("../client/src/game/types");
let fakeNow = 1000;
const realPerfNow = performance.now.bind(performance);
function kdSuite(rigLabel: string) {
  console.log(`3. knockdown poses (${rigLabel} rig)`);
  performance.now = () => fakeNow;
  const step = (fig: any, st: any, f: any, opp: any, secs: number) => {
    for (let t = 0; t < secs; t += 1 / 60) { fakeNow += 1000 / 60; fig.update(f, st.playerColors, opp, st, 1, 7); }
    fig.root.updateMatrixWorld(true);
    return fig.headWorld(new THREE.Vector3()).y - MAT_HEIGHT;
  };
  for (const kind of ["head", "body", "knee"] as const) {
    const st = createInitialState();
    const f = st.player, opp = st.enemy;
    f.x = 400; f.z = 300; opp.x = 470; opp.z = 300; f.facingAngle = 0; opp.facingAngle = Math.PI;
    const fig = new Fighter3D() as any;
    const standing = step(fig, st, f, opp, 0.2);
    ok(standing > 1.5, `${rigLabel} ${kind}: standing head at ${standing.toFixed(2)}m`);
    f.isKnockedDown = true;
    st.knockdownActive = true;
    st.kdFallTimer = 0;
    st.kdIsBodyShot = kind !== "head";
    st.kdTakeKnee = kind === "knee";
    // Engine fall timer drives the fall.
    st.kdFallTimer = KD_FALL_DURATION * 0.3;
    const early = step(fig, st, f, opp, 1 / 60);
    ok(early > 0.8, `${rigLabel} ${kind}: early in the fall the head is still up (${early.toFixed(2)}m)`);
    st.kdFallTimer = KD_FALL_DURATION;
    const down = step(fig, st, f, opp, 1.2);
    if (kind === "knee") ok(down > 0.7 && down < 1.45, `${rigLabel} knee: head at ${down.toFixed(2)}m, kneeling height`);
    else ok(down < 0.5 && down > 0.0, `${rigLabel} ${kind}: head on the canvas (${down.toFixed(2)}m)`);
    // A KO: fight over, still down.
    st.knockdownActive = false;
    st.phase = "fightEnd" as any;
    const ko = step(fig, st, f, opp, 1.0);
    if (kind !== "knee") ok(ko < 0.5, `${rigLabel} ${kind}: KO stays down (${ko.toFixed(2)}m)`);
    // Get-up.
    st.phase = "fighting" as any;
    f.isKnockedDown = false;
    const mid = step(fig, st, f, opp, kind === "knee" ? 0.2 : 0.45);
    ok(mid < standing - 0.1, `${rigLabel} ${kind}: get-up plays out (${mid.toFixed(2)}m mid-rise)`);
    const up = step(fig, st, f, opp, 1.0);
    ok(Math.abs(up - standing) < 0.05, `${rigLabel} ${kind}: back to standing (${up.toFixed(2)}m vs ${standing.toFixed(2)}m)`);
    fig.dispose();
  }
  // Immediate TKO: engine leaves knockdownActive on with the fall timer frozen at 0.
  for (const body of [false, true]) {
    const st = createInitialState();
    const f = st.player, opp = st.enemy;
    f.x = 400; f.z = 300; opp.x = 470; opp.z = 300; f.facingAngle = 0; opp.facingAngle = Math.PI;
    const fig = new Fighter3D() as any;
    step(fig, st, f, opp, 0.2);
    f.isKnockedDown = true; st.knockdownActive = true; st.kdFallTimer = 0; st.kdIsBodyShot = body;
    st.phase = "fightEnd" as any; st.refStoppageActive = true;
    const h = step(fig, st, f, opp, 2.0);
    ok(h < 0.5, `${rigLabel} immediate TKO (${body ? "body" : "head"}): falls with a frozen engine timer (${h.toFixed(2)}m)`);
    fig.dispose();
  }
  // Referee: counting bends over, wave-off raises the hands overhead.
  const st = createInitialState();
  const ref = new Fighter3D() as any;
  const refFrame = (secs: number) => {
    for (let t = 0; t < secs; t += 1 / 60) { fakeNow += 1000 / 60; ref.updateReferee(400, 300, 0, st, st.playerColors, 1); }
    ref.root.updateMatrixWorld(true);
  };
  st.knockdownActive = true; st.knockdownRefCount = 3; st.knockdownCountdown = 2.95;
  refFrame(0.5);
  const countHead = ref.headWorld(new THREE.Vector3()).y - MAT_HEIGHT;
  st.knockdownActive = false; st.knockdownRefCount = 0; st.refStoppageActive = true;
  refFrame(0.5);
  const hand = ref.rig.gloveCenter.right.getWorldPosition(new THREE.Vector3()).y - MAT_HEIGHT;
  const refHead = ref.headWorld(new THREE.Vector3()).y - MAT_HEIGHT;
  ok(countHead < refHead - 0.08, `${rigLabel} referee bends over to count (${countHead.toFixed(2)} vs ${refHead.toFixed(2)})`);
  ok(hand > refHead - 0.05, `${rigLabel} referee waves off with hands overhead (${hand.toFixed(2)}m)`);
  ref.dispose();
  performance.now = realPerfNow;
}
kdSuite("code");

{
  console.log("4. towel flies in on the stoppage timer");
  const { FightEffects3D } = await import("../client/src/game/three/effects3d");
  const { toSceneX, toSceneZ } = await import("../client/src/game/three/worldMapping");
  const fx = new FightEffects3D() as any;
  const st: any = createInitialState();
  st.towelActive = true; st.towelTimer = 1; st.refStoppageActive = true;
  st.towelStartX = 250; st.towelStartY = 420; st.towelEndX = 415; st.towelEndY = 300;
  const heads = [{ x: 0, z: 0, head: new THREE.Vector3() }, { x: 0, z: 0, head: new THREE.Vector3() }];
  st.refStoppageTimer = 1.0; fx.update(st, heads);
  const start = fx.towel.position.clone();
  st.refStoppageTimer = 0.1; fx.update(st, heads);
  const late = fx.towel.position.clone();
  const end = new THREE.Vector3(toSceneX(415), 0, toSceneZ(300));
  ok(Math.hypot(start.x - end.x, start.z - end.z) > 2, `towel starts at the corner (${Math.hypot(start.x - end.x, start.z - end.z).toFixed(2)}m away)`);
  ok(Math.hypot(late.x - end.x, late.z - end.z) < 0.6, `towel reaches the fighters late in the stoppage (${Math.hypot(late.x - end.x, late.z - end.z).toFixed(2)}m away)`);
  fx.dispose();
}
ensureFighterAssets(() => false);
for (let i = 0; i < 200 && fighterAssetEpoch() === 0; i++) await new Promise(r => setTimeout(r, 50));
ok(fighterAssetEpoch() > 0, "Tripo assets loaded");
reachSuite("tripo");
kdSuite("tripo");

// ── 4. punches are smooth: no glove or body teleport, even on a re-punch ──
console.log("4. smooth punches (tripo rig)");
{
  const st = createInitialState();
  const att = st.player, def = st.enemy;
  att.x = 400; att.z = 300; att.facingAngle = 0;
  def.x = att.x + getPunchReachPx(att, "cross"); def.z = 300; def.facingAngle = Math.PI;
  const fig = new Fighter3D() as any;
  performance.now = () => fakeNow;
  const hipsPos = () => fig.rig.bones.Hips.getWorldPosition(new THREE.Vector3());
  const glovePos = () => fig.rig.gloveCenter.right.getWorldPosition(new THREE.Vector3());
  const tick = () => { fakeNow += 1000 / 60; fig.update(att, st.playerColors, def, st, 1); fig.root.updateMatrixWorld(true); };
  tick();
  let g0 = glovePos(), h0 = hipsPos(), maxG = 0, maxH = 0;
  const frame = () => { tick(); const g = glovePos(), h = hipsPos(); maxG = Math.max(maxG, g.distanceTo(g0)); maxH = Math.max(maxH, h.distanceTo(h0)); g0 = g; h0 = h; };
  // Engine: a cross snaps to full extension in one tick, holds, then a re-punch restarts it from guard.
  const set = (punching: boolean, phase?: string) => {
    att.isPunching = punching; att.currentPunch = punching ? "cross" : null as any; att.punchPhase = phase as any; att.punchProgress = 0.5;
  };
  for (let n = 0; n < 5; n++) frame();
  set(true, "contact"); for (let n = 0; n < 20; n++) frame();
  set(true, "launchDelay"); for (let n = 0; n < 3; n++) frame();
  set(true, "contact"); for (let n = 0; n < 20; n++) frame();
  set(false); for (let n = 0; n < 30; n++) frame();
  ok(maxG < 0.3, `glove never jumps more than 0.3m in a frame (max ${maxG.toFixed(3)}m)`);
  ok(maxH < 0.06, `hips never jump more than 0.06m in a frame (max ${maxH.toFixed(3)}m)`);
  // Tripo body wears no added gear: its own hands/feet carry the glove/shoe colours.
  let skinned: any; fig.rig.body.traverse((o: any) => { if (o.isSkinnedMesh) skinned = o; });
  const mats = skinned.material as THREE.Material[];
  const groupCount = (m: THREE.Material) => skinned.geometry.groups.filter((gr: any) => mats[gr.materialIndex] === m && gr.count > 0).length;
  ok(groupCount(fig.rig.materials.glove) === 1, "Tripo hands are tinted with the glove colour");
  ok(groupCount(fig.rig.materials.shoe) === 1, "Tripo feet are tinted with the shoe colour");
  let extraMeshes = 0;
  fig.rig.body.traverse((o: any) => { if (o.isMesh && !o.isSkinnedMesh && !fig.glow.includes(o) && o !== fig.rig.headgear && !fig.rig.eyes.includes(o)) extraMeshes++; });
  ok(extraMeshes === 0, `no extra gear meshes on the Tripo body (${extraMeshes})`);
  performance.now = realPerfNow;
  fig.dispose();
}

console.log(failed === 0 ? `\nAll ${passed} fighter pose checks passed.` : `\n${failed} of ${passed + failed} fighter pose checks FAILED.`);
process.exit(failed === 0 ? 0 : 1);
