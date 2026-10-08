/**
 * Detailed arena props generated offline with Tripo3D.
 *
 * Pure data, no three.js import: `script/generateTripoAssets.ts` reads the
 * prompts from here, and the client reads the fit sizes. The game never calls
 * Tripo — it loads the committed GLB files from `/models/` listed in the
 * manifest, and falls back to a code-built stand-in for any prop that is
 * missing.
 */

export interface PropSpec {
  /** File stem: the GLB is written to client/public/models/<id>.glb. */
  id: string;
  prompt: string;
  /** Tripo face limit, kept low so the whole arena stays cheap to draw. */
  faceLimit: number;
  /**
   * The loaded model is uniformly scaled so its largest dimension along this
   * axis matches `size` (scene units = metres), then sat on y = 0.
   */
  fitAxis: "x" | "y" | "z";
  size: number;
  /**
   * Yaw (radians, about +y) applied to the raw model before fitting, so its
   * front faces +x like every stand-in. Tripo exports vary per prompt.
   */
  yawOffset?: number;
}

/** Tripo returns gym props with their front on +x; the gym layout wants +z. */
const GYM_FRONT_TO_Z = -Math.PI / 2;

export const PROP_CATALOG: PropSpec[] = [
  {
    id: "turnbuckle",
    prompt: "single boxing ring turnbuckle corner pad, padded leather cushion, rounded rectangular, plain solid colour, low poly game asset",
    faceLimit: 800,
    fitAxis: "y",
    size: 0.3,
  },
  {
    id: "ring_steps",
    prompt: "boxing ring corner stairs, one solid chunky block of three wide steps with black rubber treads and a chrome handrail on each side, simple shape, low poly game asset",
    faceLimit: 1500,
    fitAxis: "y",
    size: 1.0,
    yawOffset: Math.PI / 2,
  },
  {
    id: "ringside_table",
    prompt: "long ringside judges table with black tablecloth skirt, low poly game asset",
    faceLimit: 1000,
    fitAxis: "z",
    size: 2.4,
    yawOffset: Math.PI / 2,
  },
  {
    id: "ringside_chair",
    prompt: "simple black folding chair, low poly game asset",
    faceLimit: 600,
    fitAxis: "y",
    size: 0.9,
  },
  {
    id: "corner_stool",
    prompt: "boxing corner stool, small round seat on four metal legs, low poly game asset",
    faceLimit: 600,
    fitAxis: "y",
    size: 0.6,
  },
  {
    id: "ring_bell",
    prompt: "brass boxing ring bell on a wooden plaque base, low poly game asset",
    faceLimit: 500,
    fitAxis: "y",
    size: 0.3,
  },
  {
    id: "seating_section",
    prompt: "section of stadium arena tiered seating, rows of red plastic seats on concrete steps, low poly game asset",
    faceLimit: 2500,
    fitAxis: "z",
    size: 9,
    yawOffset: -Math.PI / 2,
  },
  {
    id: "lighting_truss",
    prompt: "square aluminium lighting truss frame with stage spotlights hanging underneath, low poly game asset",
    faceLimit: 2000,
    fitAxis: "x",
    size: 10,
    yawOffset: Math.PI / 2,
  },

  // ── Career gym (home screen + sparring venue) ──────────────────────────
  // yawOffsets are set after checking each GLB's facing; the gym places
  // every prop with its front facing +z before turning it to its spot.
  {
    id: "gym_hanging_bag",
    prompt: "long boxing heavy punching bag hanging from a short steel chain with a swivel hook at the top, worn dark red leather with black tape bands, one solid object, low poly game asset",
    faceLimit: 1000,
    fitAxis: "y",
    yawOffset: GYM_FRONT_TO_Z,
    size: 2.2,
  },
  {
    id: "gym_speed_bag",
    prompt: "free-standing boxing speed bag stand, tall black metal post on a flat base holding a round wooden rebound platform with a small brown leather speed bag hanging underneath, low poly game asset",
    faceLimit: 1000,
    fitAxis: "y",
    yawOffset: GYM_FRONT_TO_Z,
    size: 2.3,
  },
  {
    id: "gym_plate_rack",
    prompt: "gym weight plate tree rack loaded with black and red round barbell weight plates, one solid object, low poly game asset",
    faceLimit: 1000,
    fitAxis: "y",
    yawOffset: GYM_FRONT_TO_Z,
    size: 1.25,
  },
  {
    id: "gym_bench_press",
    prompt: "flat weight bench press with red padded bench, two upright black rack posts and a loaded barbell resting on top, low poly game asset",
    faceLimit: 1200,
    fitAxis: "x",
    yawOffset: GYM_FRONT_TO_Z,
    size: 1.9,
  },
  {
    id: "gym_dumbbell_rack",
    prompt: "two tier metal dumbbell rack holding a row of black hex dumbbells, one solid object, low poly game asset",
    faceLimit: 1200,
    fitAxis: "x",
    yawOffset: GYM_FRONT_TO_Z,
    size: 1.7,
  },
  {
    id: "gym_lockers",
    prompt: "row of four tall blue steel gym lockers with vents and handles, one solid block, low poly game asset",
    faceLimit: 1000,
    fitAxis: "x",
    yawOffset: GYM_FRONT_TO_Z,
    size: 2.3,
  },
  {
    id: "gym_wood_bench",
    prompt: "simple wooden locker room bench, one thick plank seat on two wooden legs, low poly game asset",
    faceLimit: 500,
    fitAxis: "x",
    yawOffset: GYM_FRONT_TO_Z,
    size: 1.7,
  },
  {
    id: "gym_office_desk",
    prompt: "wooden office desk with drawers, a computer monitor, a phone and a stack of papers on top, low poly game asset",
    faceLimit: 1200,
    fitAxis: "x",
    yawOffset: GYM_FRONT_TO_Z,
    size: 1.6,
  },
  {
    id: "gym_office_chair",
    prompt: "black office swivel chair with armrests on a five star wheeled base, low poly game asset",
    faceLimit: 800,
    fitAxis: "y",
    yawOffset: GYM_FRONT_TO_Z,
    size: 1.1,
  },
  {
    id: "gym_trophy",
    prompt: "small shiny gold trophy cup with two handles on a square black base, low poly game asset",
    faceLimit: 400,
    fitAxis: "y",
    yawOffset: GYM_FRONT_TO_Z,
    size: 0.26,
  },
  {
    id: "gym_medal",
    prompt: "round silver sports medal hanging from a short red ribbon, flat, low poly game asset",
    faceLimit: 300,
    fitAxis: "y",
    yawOffset: GYM_FRONT_TO_Z,
    size: 0.2,
  },
  {
    id: "gym_door",
    prompt: "single wooden door closed inside its door frame, small square window near the top, brass knob, flat against a wall, low poly game asset",
    faceLimit: 600,
    fitAxis: "y",
    yawOffset: GYM_FRONT_TO_Z,
    size: 2.2,
  },
  {
    id: "gym_water_crate",
    prompt: "blue plastic crate holding six water bottles, one solid object, low poly game asset",
    faceLimit: 600,
    fitAxis: "x",
    yawOffset: GYM_FRONT_TO_Z,
    size: 0.6,
  },
  {
    id: "gym_glove_rack",
    prompt: "wall mounted wooden rack with pairs of red and black boxing gloves hanging from hooks, flat back, low poly game asset",
    faceLimit: 1000,
    fitAxis: "x",
    yawOffset: GYM_FRONT_TO_Z,
    size: 1.4,
  },
];

/** One manifest entry per generated prop. */
export interface PropManifestEntry {
  id: string;
  file: string;
  prompt: string;
  taskId: string;
  faceCount: number | null;
  generatedAt: string;
}

export interface PropManifest {
  generator: "tripo3d";
  assets: PropManifestEntry[];
}

export const PROP_MANIFEST_URL = "/models/manifest.json";
