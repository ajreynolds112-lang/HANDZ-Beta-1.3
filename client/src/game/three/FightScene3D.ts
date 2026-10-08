/**
 * The 3D fight view. `render(state)` is the WebGL counterpart of renderGame's
 * world pass: arena, ring, fighters and referee from the live GameState, seen
 * through the broadcast camera. The HUD stays on the 2D canvas layered above.
 *
 * Strictly read-only on GameState: nothing here assigns to the state or calls
 * an engine function that does, so a bout plays out identically in either view.
 */
import * as THREE from "three";
import type { FighterColors, GameState } from "../types";
import { getCameraResetEpoch } from "../renderer";
import { Arena3D } from "./arena3d";
import { BroadcastCamera, CAMERA_ASPECT } from "./broadcastCamera";
import { FightEffects3D, type EffectFighter } from "./effects3d";
import { Fighter3D } from "./fighterModel";
import { ensureFighterAssets } from "./fighterRig";
import { loadGeneratedProps } from "./props3d";
import { GymEnvironment3D } from "./gym3d";
import { type GymZone3D, makeGymHomeCamera, poseGymHomeCamera } from "./gymLayout";
import { MAT_HEIGHT, toSceneLen, toSceneX, toSceneZ } from "./worldMapping";

const SCREEN_W = 800;
const SCREEN_H = 600;

/** The gym home screen: fixed camera, hover highlight, the idle player rig. */
export interface GymHomeView {
  hovered: GymZone3D | null;
  night: boolean;
  /** The player's fighter idling by the bench (its own state, not the sparring sim). */
  idle: { fighter: GameState["player"]; state: GameState; colors: FighterColors } | null;
  /** Fight week: an empty ring, no sparring fighters or referee. */
  hideFighters: boolean;
}

export interface FightSceneRenderOptions {
  gymHome?: GymHomeView;
  /** An empty ring: no fighters or referee (the idle ring behind career screens). */
  hideFighters?: boolean;
}

export interface FightSceneOptions {
  /**
   * Match the camera to the canvas's own shape instead of the fight's fixed 4:3
   * frame. For full-screen backdrops (menu fight, idle ring) that have no HUD
   * to line up with; a wider screen just sees more of the arena.
   */
  fillAspect?: boolean;
}

const ARENA_BG = "#07050c";
const GYM_BG = "#16110d";
/** Warm dusty haze: gives the long gym depth from the low home camera. */
const GYM_HAZE = "#3a2f26";

const REF_COLORS: FighterColors = {
  gloves: "#d4a574",
  gloveTape: "#c49468",
  trunks: "#16161a",
  shoes: "#101012",
  skin: "#d4a574",
  shirt: "#f2f2ee",
};

export class FightScene3D {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private cam = new BroadcastCamera();
  private arena = new Arena3D();
  private gym = new GymEnvironment3D();
  private arenaLights = new THREE.Group();
  private homeCam = makeGymHomeCamera();
  private activeCam: THREE.PerspectiveCamera = this.cam.camera;
  private idleFighter: Fighter3D | null = null;
  private venue: "arena" | "gym" | null = null;
  private fighters: Fighter3D[] = [];
  private frame = 0;
  private referee = new Fighter3D();
  private effects = new FightEffects3D();
  private effFighters: EffectFighter[] = [
    { x: 0, z: 0, head: new THREE.Vector3() },
    { x: 0, z: 0, head: new THREE.Vector3() },
  ];
  private disposed = false;
  private lastW = 0;
  private lastH = 0;
  private projVec = new THREE.Vector3();

  private fillAspect: boolean;

  constructor(private canvas: HTMLCanvasElement, options: FightSceneOptions = {}) {
    this.fillAspect = options.fillAspect === true;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: "high-performance" });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = new THREE.Color(ARENA_BG);
    this.scene.fog = new THREE.Fog(ARENA_BG, 22, 48);
    this.scene.add(this.arena.group, this.gym.group, this.arenaLights);
    this.buildLights();
    this.scene.add(this.referee.root);
    this.scene.add(this.effects.group);

    void loadGeneratedProps(this.arena.props, () => this.disposed);
    void loadGeneratedProps(this.gym.props, () => this.disposed);
    ensureFighterAssets(() => this.disposed);
  }

  private buildLights(): void {
    // Dim fill for the stands; the ring gets the spotlights.
    this.arenaLights.add(new THREE.HemisphereLight("#7a86a8", "#120e18", 0.35));

    // Main key light straight down on the ring, the only shadow caster.
    const key = new THREE.SpotLight("#fff1d6", 5.5, 0, THREE.MathUtils.degToRad(34), 0.45, 0);
    key.position.set(0, MAT_HEIGHT + 13, 0);
    key.target.position.set(0, MAT_HEIGHT, 0);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 6;
    key.shadow.camera.far = 20;
    key.shadow.bias = -0.0005;
    this.arenaLights.add(key, key.target);

    // Four angled rig spots from the truss corners for broadcast-style modelling.
    const coneTex = makeConeAlphaTexture();
    const coneMat = new THREE.MeshBasicMaterial({
      color: "#ffe2a8",
      alphaMap: coneTex,
      transparent: true,
      opacity: 0.07,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });
    const lampMat = new THREE.MeshBasicMaterial({ color: "#fff6dd", fog: false });
    const lampGeo = new THREE.CircleGeometry(0.16, 12);
    for (const [x, z] of [[-4.5, -3.4], [4.5, -3.4], [-4.5, 3.4], [4.5, 3.4]]) {
      const top = new THREE.Vector3(x, MAT_HEIGHT + 7.0, z);
      const aim = new THREE.Vector3(x * 0.15, MAT_HEIGHT, z * 0.15);
      const spot = new THREE.SpotLight("#ffe0b0", 2.2, 0, THREE.MathUtils.degToRad(30), 0.6, 0);
      spot.position.copy(top);
      spot.target.position.copy(aim);
      this.arenaLights.add(spot, spot.target);

      // Visible light shaft.
      const len = top.distanceTo(aim);
      const coneGeo = new THREE.CylinderGeometry(0.15, Math.tan(THREE.MathUtils.degToRad(24)) * len, len, 20, 1, true);
      coneGeo.translate(0, -len / 2, 0);
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.copy(top);
      cone.quaternion.setFromUnitVectors(new THREE.Vector3(0, -1, 0), aim.clone().sub(top).normalize());
      this.arenaLights.add(cone);

      const lamp = new THREE.Mesh(lampGeo, lampMat);
      lamp.position.copy(top);
      lamp.lookAt(aim);
      this.arenaLights.add(lamp);
    }
  }

  /** Engine point (px floor + px height) → 800x600 screen point, for HUD text. */
  project = (wx: number, wz: number, heightPx: number): { sx: number; sy: number } | null => {
    const v = this.projVec.set(toSceneX(wx), MAT_HEIGHT + toSceneLen(heightPx), toSceneZ(wz));
    v.project(this.activeCam);
    if (v.z > 1) return null;
    return { sx: (v.x * 0.5 + 0.5) * SCREEN_W, sy: (-v.y * 0.5 + 0.5) * SCREEN_H };
  };

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === this.lastW && h === this.lastH) return;
    this.lastW = w;
    this.lastH = h;
    if (w > 0 && h > 0) this.renderer.setSize(w, h, false);
    const aspect = this.fillAspect && w > 0 && h > 0 ? w / h : CAMERA_ASPECT;
    this.cam.camera.aspect = aspect;
    this.cam.camera.updateProjectionMatrix();
    this.homeCam.aspect = aspect;
    this.homeCam.updateProjectionMatrix();
  }

  private syncFighters(state: GameState): void {
    type F = GameState["player"];
    const list: { f: F; colors: FighterColors; opp: F }[] = [
      { f: state.player, colors: state.playerColors, opp: state.enemy },
      { f: state.enemy, colors: state.enemyColors, opp: state.player },
    ];
    if (state.nightmareMode) {
      // Each extra wears the kit it spawned in; enemyColors belongs to the current target only.
      for (const extra of state.nightmareEnemies ?? []) list.push({ f: extra, colors: extra.colors ?? state.enemyColors, opp: state.player });
    }
    this.frame++;
    const epoch = getCameraResetEpoch();
    while (this.fighters.length < list.length) {
      const fig = new Fighter3D();
      this.fighters.push(fig);
      this.scene.add(fig.root);
    }
    this.fighters.forEach((fig, i) => {
      const entry = list[i];
      fig.root.visible = !!entry;
      if (entry) fig.update(entry.f, entry.colors, entry.opp, state, this.frame, epoch);
    });

    this.referee.root.visible = state.refereeVisible;
    if (state.refereeVisible) {
      const down = state.player.isKnockedDown ? state.player : state.enemy.isKnockedDown ? state.enemy : null;
      // Face the fighter on the canvas; on a stoppage, face the fighters' midpoint.
      const tx = down ? down.x : (state.player.x + state.enemy.x) / 2;
      const tz = down ? down.z : (state.player.z + state.enemy.z) / 2;
      const dx = tx - state.refX, dz = tz - state.refZ;
      const facing = Math.hypot(dx, dz) > 4 ? Math.atan2(dz, dx) : Math.atan2(state.player.z - state.refZ, state.player.x - state.refX) + Math.PI / 2;
      this.referee.updateReferee(state.refX, state.refZ, facing, state, REF_COLORS, this.frame);
    }
  }

  private syncEffects(state: GameState): void {
    const mains = [state.player, state.enemy];
    for (let i = 0; i < 2; i++) {
      const e = this.effFighters[i];
      e.x = mains[i].x;
      e.z = mains[i].z;
      this.fighters[i]?.headWorld(e.head);
    }
    this.effects.update(state, this.effFighters);
    if (this.effects.kick > 0) this.cam.kick(this.effects.kick);
  }

  /**
   * Arena for career/quick bouts; the gym for every sparring mode (the 2D view
   * draws its gym around exactly these bouts) and for the gym home screen.
   */
  private setVenue(venue: "arena" | "gym"): void {
    if (venue === this.venue) return;
    this.venue = venue;
    const gym = venue === "gym";
    this.arena.setVenue(venue);
    this.gym.group.visible = gym;
    this.arenaLights.visible = !gym;
    const bg = gym ? GYM_BG : ARENA_BG;
    this.scene.background = new THREE.Color(bg);
    this.scene.fog = gym ? new THREE.Fog(GYM_HAZE, 20, 62) : new THREE.Fog(bg, 22, 48);
  }

  private syncIdle(home: GymHomeView | undefined): void {
    const idle = home?.idle ?? null;
    if (!idle) {
      if (this.idleFighter) this.idleFighter.root.visible = false;
      return;
    }
    if (!this.idleFighter) {
      this.idleFighter = new Fighter3D();
      this.scene.add(this.idleFighter.root);
    }
    this.idleFighter.root.visible = true;
    this.idleFighter.update(idle.fighter, idle.colors, null, idle.state, this.frame, 0);
    // Stands on the gym floor, not the ring mat.
    this.idleFighter.root.position.y = 0;
  }

  /** The live home-screen camera (it drifts), for picking and tag placement. */
  get homeCamera(): THREE.PerspectiveCamera {
    return this.homeCam;
  }

  render(state: GameState, opts?: FightSceneRenderOptions): void {
    if (this.disposed) return;
    this.resize();
    const home = opts?.gymHome;
    this.setVenue(home || (state.sparringMode && !state.tutorialMode) ? "gym" : "arena");
    if (home) {
      poseGymHomeCamera(this.homeCam, performance.now() / 1000);
      this.activeCam = this.homeCam;
    } else {
      this.cam.update(state, getCameraResetEpoch());
      this.activeCam = this.cam.camera;
    }
    this.arena.update(state, performance.now());
    if (this.venue === "gym") this.gym.update({ night: home ? home.night : state.importSparring === true, hovered: home?.hovered ?? null, home: !!home });
    this.syncFighters(state);
    if (home?.hideFighters || opts?.hideFighters) {
      for (const f of this.fighters) f.root.visible = false;
      this.referee.root.visible = false;
    }
    this.syncIdle(home);
    this.syncEffects(state);
    this.renderer.render(this.scene, this.activeCam);
  }

  dispose(): void {
    this.disposed = true;
    this.arena.dispose();
    this.gym.dispose();
    this.idleFighter?.dispose();
    for (const f of this.fighters) f.dispose();
    this.referee.dispose();
    this.effects.dispose();
    this.scene.traverse(obj => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
    });
    this.renderer.dispose();
  }
}

/** Vertical fade for the light shafts: bright at the lamp, gone at the floor. */
function makeConeAlphaTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 4;
  c.height = 128;
  const ctx = c.getContext("2d")!;
  const g = ctx.createLinearGradient(0, 0, 0, 128);
  g.addColorStop(0, "#ffffff");
  g.addColorStop(1, "#000000");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 128);
  return new THREE.CanvasTexture(c);
}
