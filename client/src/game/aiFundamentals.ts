/**
 * Boxing fundamentals — the genome the AI training ring evolves.
 *
 * A fundamental is a named boxing principle with three parts: numeric parameters
 * the AI reads when it decides what to do, an *opportunity* test (the situation
 * arose) and a *success* test (the principle was actually carried out). Evolution
 * moves the parameters; the two tests are fixed, and their ratio is the score.
 *
 * Two rules hold this together:
 *
 *  - Parameters are expressed in the same 0..1 currency the neural editor already
 *    uses, and every default is anchored to the shipped Champion value of the knob
 *    it feeds. A fresh seed therefore boxes like the current champion, and a
 *    generation measures deviation from that baseline rather than from noise.
 *  - Nothing here reaches the AI directly. `deriveNeuralState` folds a seed back
 *    down onto the 24 existing neural parameters, so an evolved boxer drives the
 *    same machinery a hand-tuned one does. There is no second behaviour system to
 *    keep in sync.
 *
 * Ids are the numbers from the fundamentals sheet and are load-bearing: seeds are
 * stored by key, so entries may be appended but never renumbered or removed.
 */

/** Mirrors the shipped Champion neural set. Parameter defaults are anchored to
 *  these so a starting seed reproduces champion behaviour. Kept as literals
 *  rather than imported: the neural view sits in an import cycle with the engine,
 *  and reading it at module-init time is how that cycle turns into `undefined`. */
const CHAMP = {
  aggression: 0.93, guardParanoia: 0.55, feintiness: 0.37, cleanHitsVsVolume: 0.68,
  stateThinkSpeed: 0.95, moveThinkSpeed: 0.95, attackInterval: 0.85,
  perfectReactChance: 0.95, defenseCycleSpeed: 0.90, headCondThreshold: 0.22, bodyCondThreshold: 0.25,
  rhythmCutCommit: 0.83, rhythmCutAggression: 0.80, chargedPunchChance: 0.74,
  comboCommitChance: 0.95, executionIntensity: 1.0, rhythmSwayAdapt: 0.90,
  ringCutoff: 0.80, ropeEscapeAwareness: 0.80, lateralStrength: 0.65,
  kdRecovery1: 1.0, kdRecovery2: 1.0, kdRecovery3: 1.0, survivalInstinct: 0.90,
} as const;

/** A seed must carry out each fundamental on at least this share of the chances
 *  it gets. Below it, the seed is failing that fundamental. */
export const EXEC_FLOOR = 0.03;

/** Synthetic roster ids for training seeds, above every real roster id. Lives
 *  here rather than with the tournament because the AI module needs it to skip
 *  the champion brain redirect, and importing the tournament from there would
 *  close a cycle. */
export const TRAINING_ROSTER_BASE = 900000;

export const isTrainingRosterId = (id?: number | null): boolean =>
  id != null && id >= TRAINING_ROSTER_BASE;

export interface FundamentalParam {
  key: string;
  label: string;
  def: number;
  min: number;
  max: number;
}

export interface Fundamental {
  id: number;
  key: string;
  label: string;
  /** What the AI is trying to do, in boxing terms. */
  meaning: string;
  /** What counts as the situation arising. */
  opportunity: string;
  /** What counts as pulling it off. */
  success: string;
  params: FundamentalParam[];
  /** "basics" marks the beginner-technique layer (stance, the punches, slipping,
   *  rolling, blocking). Absent means the advanced set. */
  layer?: "basics";
}

const p = (key: string, label: string, def: number, min = 0, max = 1): FundamentalParam =>
  ({ key, label, def, min, max });

export const FUNDAMENTALS: Fundamental[] = [
  // ---- Tier 1: governing fight philosophy (1-8). The broadest principles, so
  // their opportunity tests are mostly time-sampled rather than event-driven —
  // "was this true over the last second" rather than "did this one punch land".
  {
    id: 1, key: "continuous_advantage", label: "Continuous Advantage",
    meaning: "Every action should gain position, information, initiative, stamina or damage. There is no neutral action.",
    opportunity: "Sampled every second the fight is live.",
    success: "That second bought something: a landing, a miss forced, ground taken or the opponent moved.",
    params: [
      p("neutralLimit", "How long to tolerate nothing happening", 0.35),
      p("gainThreshold", "How much counts as a gain", 0.40),
      p("initiativeWeight", "Value initiative over damage", CHAMP.aggression * 0.7),
    ],
  },
  {
    id: 2, key: "defensive_responsibility", label: "Defensive Responsibility",
    meaning: "Offense never abandons defense, distance or awareness of the return shot.",
    opportunity: "A punch was thrown.",
    success: "Nothing came back through it.",
    params: [
      p("guardWhilePunching", "Keep the guard through the punch", CHAMP.guardParanoia),
      p("rangeDiscipline", "Punch only from a range you can leave", 0.55),
      p("returnAwareness", "Weight given to the return shot", 0.50),
    ],
  },
  {
    id: 3, key: "pressure_decision_quality", label: "Decision Quality Under Pressure",
    meaning: "Choose the highest-value action while threatened, tired, hurt or rushed.",
    opportunity: "Acting while low on stamina or while under fire.",
    success: "The action was a considered one rather than a wild throw.",
    params: [
      p("composureUnderFire", "Hold shape while being hit", 0.60),
      p("simplifyWhenTired", "Fewer, better actions when empty", 0.55),
      p("panicResist", "Resist the wild answer", CHAMP.survivalInstinct),
    ],
  },
  {
    id: 4, key: "combat_composure", label: "Combat Composure",
    meaning: "Calmness improves perception, timing, patience and opportunity recognition.",
    opportunity: "Sampled every second.",
    success: "Busy without spraying: something happened, but not at panic rate.",
    params: [
      p("calmBase", "Baseline composure", 0.65),
      p("recoverRate", "How fast composure returns", 0.50),
      p("rushResist", "Resist being hurried", 0.45),
    ],
  },
  {
    id: 5, key: "constraint_control", label: "Constraint Control",
    meaning: "Control grows as the opponent loses viable options: movement, rhythm, timing, safe exits.",
    opportunity: "Sampled every second inside working range.",
    success: "The opponent's options shrank — they stopped moving freely or stopped throwing.",
    params: [
      p("optionDenial", "Take away their choices", 0.50),
      p("exitDenial", "Take away the way out", CHAMP.ringCutoff),
      p("rhythmDenial", "Take away their timing", 0.45),
    ],
  },
  {
    id: 6, key: "active_patience", label: "Active Patience",
    meaning: "Patience is not inactivity: create reactions, gather information, threaten, and wait for a commitment.",
    opportunity: "A stretch of not punching.",
    success: "The wait was worked — feints, movement or position — rather than standing still.",
    params: [
      p("waitLength", "How long to wait", 0.40),
      p("threatWhileWaiting", "Stay threatening while waiting", CHAMP.feintiness),
      p("commitTrigger", "What it takes to finally go", 0.55),
    ],
  },
  {
    id: 7, key: "style_plasticity", label: "Style Plasticity",
    meaning: "Be able to change style rather than stay permanently aggressive, defensive or evasive.",
    opportunity: "Sampled once per fifteen-second block.",
    success: "This block's balance of attack and defense differed from the last one.",
    params: [
      p("switchRate", "How readily to change style", 0.35),
      p("styleRange", "How far the style can swing", 0.50),
      p("commitToStyle", "Stay with a style long enough to work", 0.60),
    ],
  },
  {
    id: 8, key: "layered_adaptation", label: "Layered Adaptation",
    meaning: "Adjust continuously, and when the opponent adapts, answer with several interacting changes rather than one.",
    opportunity: "Something stopped working — a run of misses or hits taken.",
    success: "More than one thing changed afterwards: range, punch selection and defensive method.",
    params: [
      p("adjustRate", "How often to adjust", 0.45),
      p("layerCount", "How many things to change at once", 0.50),
      p("readWindow", "How long before deciding it failed", CHAMP.stateThinkSpeed * 0.6),
    ],
  },

  // ---- Tier 2: fight intelligence and prediction (9-16).
  {
    id: 9, key: "information_harvesting", label: "Information Harvesting",
    meaning: "Early actions should reveal range, reactions, habits and defensive preferences.",
    opportunity: "Throwing in the first third of the round.",
    success: "The early work was varied rather than one punch repeated.",
    params: [
      p("probeRate", "How much to probe early", 0.50),
      p("earlyWindow", "How long the reading phase lasts", 0.35),
      p("varietyDemand", "How much variety the probing needs", 0.55),
    ],
  },
  {
    id: 10, key: "predictive_timing", label: "Predictive Timing",
    meaning: "Timing is pattern recognition plus prediction — know when they are about to commit.",
    opportunity: "The opponent started a punch.",
    success: "This fighter was already moving or defending before it arrived, not after.",
    params: [
      p("leadTime", "How early to act on the read", CHAMP.stateThinkSpeed * 0.7),
      p("patternWeight", "Trust in the pattern", 0.55),
      p("commitConfidence", "Confidence needed to act on it", 0.50),
    ],
  },
  {
    id: 11, key: "habit_exploitation", label: "Habit Exploitation",
    meaning: "Detect repeated behaviour, bad habits and overcommitments, and build punishments for them.",
    opportunity: "The opponent repeated the same punch back to back.",
    success: "The repeat was made to pay — landed on, or avoided cleanly.",
    params: [
      p("repeatMemory", "How long a habit is remembered", 0.50),
      p("punishChance", "How hard to punish it", CHAMP.perfectReactChance * 0.7),
      p("confirmCount", "How many repeats before acting", 0.40),
    ],
  },
  {
    id: 12, key: "threat_assumption", label: "Threat Assumption",
    meaning: "Behave as though the opponent is always setting a counter or a trap until evidence says otherwise.",
    opportunity: "An inviting opening: in range with their guard down.",
    success: "It was taken with defense intact, or declined without being countered.",
    params: [
      p("suspicion", "How much to distrust an opening", 0.50),
      p("verifyDemand", "How much proof before trusting it", 0.45),
      p("safeEntry", "Enter behind cover", CHAMP.guardParanoia),
    ],
  },
  {
    id: 13, key: "impact_diagnosis", label: "Impact Diagnosis",
    meaning: "After being hit, identify the cause — range, timing, careless offense, wrong defense — and change.",
    opportunity: "A hit was taken.",
    success: "Behaviour actually changed afterwards rather than repeating into it.",
    params: [
      p("diagnoseWindow", "How long to spend working it out", 0.50),
      p("changeMagnitude", "How much to change in response", 0.50),
      p("repeatTolerance", "How often to accept the same mistake", 0.30),
    ],
  },
  {
    id: 14, key: "defense_vulnerability_model", label: "Defense Vulnerability Modeling",
    meaning: "Every defensive system exposes something; identify what the opponent's choice gives up.",
    opportunity: "The opponent settled into a defensive shape.",
    success: "The attack went where that shape is open — body against a high guard, head against a duck.",
    params: [
      p("readDefense", "Read what they are giving up", 0.55),
      p("targetSwitch", "Switch target to the opening", 0.50),
      p("exploitChance", "How hard to attack it", CHAMP.cleanHitsVsVolume),
    ],
  },
  {
    id: 15, key: "counter_threat_mapping", label: "Counter-Threat Mapping",
    meaning: "Predict which counter your intended punch invites, and pick the defense for it in advance.",
    opportunity: "Throwing at close range, where the counter is live.",
    success: "The counter did not land.",
    params: [
      p("threatWeight", "How dangerous to assume the counter is", 0.55),
      p("preDefend", "Defense set before the punch", CHAMP.guardParanoia * 0.9),
      p("punchChoiceSafety", "Prefer punches that invite less", 0.50),
    ],
  },
  {
    id: 16, key: "counter_expected_value", label: "Risk-Reward Counter Selection",
    meaning: "Prefer counters that maximize damage and position relative to the danger accepted.",
    opportunity: "A counter chance opened — the opponent just missed.",
    success: "Taken and landed, or declined and stayed clean. Taken and missed is the failure.",
    params: [
      p("riskTolerance", "How much danger to accept", 0.50),
      p("rewardWeight", "How much reward is needed", CHAMP.cleanHitsVsVolume),
      p("declineChance", "How readily to pass on it", 0.35),
    ],
  },

  // ---- Tier 3: strategic control of the fight (17-24).
  {
    id: 17, key: "initiative_priority", label: "Initiative Priority",
    meaning: "Being ready to attack or defend before the opponent gives control over what happens next.",
    opportunity: "A neutral moment in range with neither fighter committed.",
    success: "This fighter acted first.",
    params: [
      p("readyBias", "Stay loaded rather than resting", 0.55),
      p("firstActChance", "How readily to move first", CHAMP.aggression * 0.6),
      p("neutralPatience", "How long to hold the neutral", 0.40),
    ],
  },
  {
    id: 18, key: "ring_generalship", label: "Ring Generalship",
    meaning: "Control when and where exchanges happen rather than merely winning individual punch trades.",
    opportunity: "An exchange started.",
    success: "It happened on this fighter's terms — they came forward, or it was at their range.",
    params: [
      p("placeControl", "Choose where it happens", CHAMP.ringCutoff),
      p("timeControl", "Choose when it happens", 0.50),
      p("centreBias", "Hold the middle of the ring", 0.55),
    ],
  },
  {
    id: 19, key: "tempo_control", label: "Tempo Control",
    meaning: "Control the speed and intensity moment to moment rather than synchronizing to the opponent.",
    opportunity: "Sampled every two seconds.",
    success: "This fighter's rate changed independently of the opponent's.",
    params: [
      p("tempoOwn", "Set your own pace", 0.55),
      p("changeRate", "How often to change pace", 0.45),
      p("syncResist", "Resist matching their pace", 0.50),
    ],
  },
  {
    id: 20, key: "momentum_management", label: "Momentum Management",
    meaning: "Recognize and compound favourable sequences while interrupting the opponent's.",
    opportunity: "Either fighter landed twice in a row.",
    success: "Ours was extended, or theirs was broken up.",
    params: [
      p("compoundChance", "Press a good run", CHAMP.comboCommitChance * 0.7),
      p("interruptChance", "Break up theirs", 0.55),
      p("streakMemory", "How long a run stays live", 0.45),
    ],
  },
  {
    id: 21, key: "responsible_pressure", label: "Pressure With Responsibility",
    meaning: "Pressure should disrupt without advancing faster than the fighter can safely defend.",
    opportunity: "Advancing on the opponent.",
    success: "Ground was taken without shipping anything on the way in.",
    params: [
      p("advanceRate", "How fast to come forward", 0.55),
      p("safetyMargin", "How much cover to keep while advancing", 0.50),
      p("pressureHold", "How long to sustain it", 0.45),
    ],
  },
  {
    id: 22, key: "reset_advantage", label: "Reset Advantage",
    meaning: "Position is partly who needs less time to be fully live again. Reset before the opponent does.",
    opportunity: "An exchange finished with both fighters out of it.",
    success: "This fighter was set again first.",
    params: [
      p("resetSpeed", "How fast to become live again", CHAMP.defenseCycleSpeed),
      p("resetPriority", "Reset before doing anything else", 0.50),
      p("exploitTheirs", "Use the time their reset costs", 0.50),
    ],
  },
  {
    id: 23, key: "reset_exploitation", label: "Reset Exploitation",
    meaning: "Attack the instant the opponent believes the exchange is over.",
    opportunity: "The opponent stopped and stood off after an exchange.",
    success: "Something landed in that transition.",
    params: [
      p("readEndOfExchange", "Spot the moment they switch off", 0.50),
      p("strikeChance", "How readily to go then", CHAMP.aggression * 0.6),
      p("strikeDelay", "How long to let them settle first", 0.30),
    ],
  },
  {
    id: 24, key: "advantage_window", label: "Advantage Window Exploitation",
    meaning: "Enter, capitalize, and leave before the opponent recovers enough to retaliate.",
    opportunity: "A punch landed, opening the window.",
    success: "It was followed up and left before anything came back.",
    params: [
      p("windowLength", "How long the window is worth", 0.45),
      p("punchBudget", "How much to spend in it", 0.50),
      p("exitOnTime", "Leave before it closes", 0.50),
    ],
  },

  // ---- Tier 4: position, distance and exchange structure (25-36).
  {
    id: 25, key: "range_elasticity", label: "Range Elasticity",
    meaning: "Distance control is the ability to enter and leave range faster than the opponent can respond.",
    opportunity: "Entered punching range.",
    success: "Left it again quickly without being caught inside.",
    params: [
      p("entrySpeed", "How fast to get in", CHAMP.moveThinkSpeed * 0.6),
      p("exitSpeed", "How fast to get out", 0.55),
      p("dwellLimit", "How long to stay in range", 0.40),
    ],
  },
  {
    id: 26, key: "step_timing", label: "Step Timing",
    meaning: "Time the opponent's foot movement to manipulate distance, rather than reading range statically.",
    opportunity: "The opponent stepped.",
    success: "This fighter's own distance change was timed to that step.",
    params: [
      p("stepRead", "Read their feet", 0.50),
      p("timingOffset", "When to move against the step", 0.45),
      p("matchChance", "How often to time it rather than just hold range", 0.50),
    ],
  },
  {
    id: 27, key: "angle_dominance", label: "Angle Dominance",
    meaning: "Seek positions where your attack is reliable and theirs is mechanically disadvantaged.",
    opportunity: "At punching range.",
    success: "This fighter changed angle and the opponent had not corrected for it.",
    params: [
      p("angleSeek", "How much to hunt the angle", 0.50),
      p("angleHold", "How long to keep it", 0.45),
      p("angleSize", "How far off-line to go", 0.40),
    ],
  },
  {
    id: 28, key: "lead_hand_dominance", label: "Lead-Hand Dominance",
    meaning: "Treat control of the opponent's lead hand as a positional and information advantage.",
    opportunity: "At lead-hand range.",
    success: "The lead was busy and theirs did not come back through it.",
    params: [
      p("leadActivity", "How busy the lead hand is", 0.55),
      p("controlRange", "The range to fight the lead at", 0.50),
      p("followThrough", "Build off the lead", 0.45),
    ],
  },
  {
    id: 29, key: "ring_interception", label: "Ring Interception",
    meaning: "Cut the ring by moving to where they are going, rather than following where they have been.",
    opportunity: "The opponent moved off laterally.",
    success: "This fighter headed them off instead of chasing behind them.",
    params: [
      p("cutChance", "How often to cut rather than follow", CHAMP.ringCutoff),
      p("projectAhead", "How far ahead of them to aim", 0.50),
      p("lateralBias", "Preference for side-on movement", CHAMP.lateralStrength),
    ],
  },
  {
    id: 30, key: "balance_integrity", label: "Balance Integrity",
    meaning: "Stay in a state from which offense, defense, movement or exit can immediately continue.",
    opportunity: "A punch landed.",
    success: "The fighter could carry straight on — another punch, a step or a defense, with no dead beat.",
    params: [
      p("balanceKeep", "Stay over your feet", 0.60),
      p("overreachLimit", "How far to reach for a shot", 0.45),
      p("recoverSpeed", "How fast to get set again", 0.55),
    ],
  },
  {
    id: 31, key: "post_action_positioning", label: "Post-Action Positioning",
    meaning: "Judge punches, steps and defensive actions partly by where they leave the fighter afterwards.",
    opportunity: "An action finished.",
    success: "It ended somewhere useful — at range or off-line, not parked in front of them.",
    params: [
      p("endPositionWeight", "How much the finishing spot matters", 0.50),
      p("preferredEnd", "Where actions should end", 0.50),
      p("adjustAfter", "Fix the position afterwards", 0.45),
    ],
  },
  {
    id: 32, key: "functional_punch_effect", label: "Functional Punch Effect",
    meaning: "A punch can succeed without landing: it can force a reset, move them, change their guard or open the next one.",
    opportunity: "A punch was thrown that did not land.",
    success: "It still did work — moved them, put their guard up, or set up the next punch.",
    params: [
      p("effectWeight", "Value effect over clean landing", 0.50),
      p("pushChance", "Throw to move them", 0.45),
      p("chainAfter", "Build off the non-landing punch", 0.50),
    ],
  },
  {
    id: 33, key: "positional_shot_selection", label: "Positional Shot Selection",
    meaning: "Accuracy is choosing punches suited to travel distance, opening and position, not just aiming correctly.",
    opportunity: "A punch was thrown.",
    success: "The punch suited the range — straight shots long, hooks and uppercuts short.",
    params: [
      p("rangeMatch", "Match the punch to the distance", 0.60),
      p("openingMatch", "Match the punch to the opening", 0.50),
      p("wrongShotResist", "Refuse the shot that does not fit", 0.50),
    ],
  },
  {
    id: 34, key: "exchange_cycle", label: "Exchange Cycle",
    meaning: "Model combat as Entry, Attack, Transition, Exit rather than as independent punches.",
    opportunity: "An exchange started.",
    success: "All four phases were present, not just the attack.",
    params: [
      p("entryWeight", "Effort spent on the way in", 0.50),
      p("transitionWeight", "Effort spent on the turn", 0.50),
      p("exitWeight", "Effort spent on the way out", 0.50),
    ],
  },
  {
    id: 35, key: "combat_state_transition", label: "Combat State Transition",
    meaning: "Switch offense to defense to recovery to offense while keeping balance and position.",
    opportunity: "A change between attacking and defending.",
    success: "The switch happened without a dead gap in between.",
    params: [
      p("switchSpeed", "How fast to change state", CHAMP.defenseCycleSpeed),
      p("deadTimeLimit", "How much dead time to allow", 0.35),
      p("carryBalance", "Keep position through the change", 0.50),
    ],
  },
  {
    id: 36, key: "exit_to_reentry", label: "Exit-to-Reentry Chaining",
    meaning: "An exit should also position the fighter for the next exchange, ideally where they can reset first.",
    opportunity: "The fighter left an exchange.",
    success: "They came back in off the exit rather than resetting to neutral first.",
    params: [
      p("reentrySpeed", "How fast to come back", 0.50),
      p("exitAngle", "Leave on an angle rather than straight back", 0.45),
      p("resetFirst", "Be set before re-entering", 0.50),
    ],
  },

  // ---- Tier 5: defensive and counterpunching architecture (37-49).
  {
    id: 37, key: "active_defense", label: "Active Defense",
    meaning: "Defense should change position, distance, angle, rhythm or initiative rather than standing still and absorbing.",
    opportunity: "Defending while the opponent was punching.",
    success: "The defense moved, turned or answered instead of only covering.",
    params: [
      p("moveShare", "Answer with movement rather than cover", CHAMP.lateralStrength),
      p("answerChance", "Answer with a punch", CHAMP.perfectReactChance * 0.8),
      p("stillnessLimit", "How long to stay planted", 0.35),
    ],
  },
  {
    id: 38, key: "distance_first_defense", label: "Distance-First Defense",
    meaning: "Distance is the first defensive layer; blocking and slipping matter more once position has already failed.",
    opportunity: "The opponent threw.",
    success: "Range had already answered it, or the guard did once range had not.",
    params: [
      p("rangeKeep", "Preferred working distance", 0.55),
      p("guardWhenClose", "Fall back on the guard up close", CHAMP.guardParanoia),
      p("layerOrder", "How strongly distance comes first", 0.60),
    ],
  },
  {
    id: 39, key: "integrated_evasion", label: "Integrated Evasion",
    meaning: "Defense belongs before, during and after offense; head movement and punching are one action, not two.",
    opportunity: "A punch was thrown.",
    success: "Defense sat either side of it rather than the punch standing alone.",
    params: [
      p("defendWhilePunching", "Keep defending through the punch", 0.45),
      p("preDefend", "Set up behind defense", 0.40),
      p("postDefend", "Close behind defense", 0.50),
    ],
  },
  {
    id: 40, key: "return_fire_expectation", label: "Return-Fire Expectation",
    meaning: "As an attack finishes, the opponent's counter window is already opening.",
    opportunity: "The opponent fired back after this fighter's attack.",
    success: "The return fire found guard, movement or nothing at all.",
    params: [
      p("anticipation", "How early to expect the return", 0.50),
      p("recoverGuard", "Guard back up on the way out", CHAMP.guardParanoia),
      p("exitAfter", "Leave the exchange rather than trade", 0.40),
    ],
  },
  {
    id: 41, key: "dead_zone_avoidance", label: "Dead-Zone Avoidance",
    meaning: "The spot an attack just finished from is dangerous: move, defend, counter, or use it as bait on purpose.",
    opportunity: "An attack finished inside range.",
    success: "The spot was vacated or covered.",
    params: [
      p("exitChance", "Leave the spot", 0.55),
      p("exitDistance", "How far to clear it", 0.45),
      p("baitInstead", "Stay on it deliberately as bait", 0.25),
    ],
  },
  {
    id: 42, key: "counter_window_recognition", label: "Counter Window Recognition",
    meaning: "An opponent's punch opens a counter window that shrinks as their hand and guard come back.",
    opportunity: "The opponent threw.",
    success: "A counter landed while the window was still open.",
    params: [
      p("windowRead", "Recognise the window", CHAMP.perfectReactChance),
      p("reactSpeed", "Get the counter off in time", CHAMP.perfectReactChance),
      p("windowDecay", "How fast the chance is written off", 0.50),
    ],
  },
  {
    id: 43, key: "counter_window_creation", label: "Counter Window Creation",
    meaning: "Do not only wait for counter chances; manufacture them with feints and bait.",
    opportunity: "A feint or bait was offered in range.",
    success: "It drew a punch and the counter landed.",
    params: [
      p("baitRate", "How often to bait", CHAMP.feintiness * 0.9),
      p("baitCommit", "How convincing the bait is", CHAMP.rhythmCutCommit),
      p("punishReady", "Be loaded for the response", CHAMP.perfectReactChance * 0.9),
    ],
  },
  {
    id: 44, key: "defensive_variation", label: "Defensive Variation",
    meaning: "After repeated defensive actions, change movement, range, counter or method so the defense is not itself predictable.",
    opportunity: "A run of defensive actions of the same kind.",
    success: "The method changed before the run got long.",
    params: [
      p("switchRate", "How readily the method changes", CHAMP.defenseCycleSpeed),
      p("runLimit", "Repeats tolerated before switching", 0.40),
      p("methodSpread", "How wide the mix of methods is", 0.50),
    ],
  },
  {
    id: 45, key: "counter_variation", label: "Counter Variation",
    meaning: "Rotate counter types, because a predictable counter is itself something to trap.",
    opportunity: "A counter landed.",
    success: "It was not the same counter as last time.",
    params: [
      p("rotateChance", "Rotate the counter", CHAMP.rhythmCutAggression),
      p("typeSpread", "How wide the rotation goes", 0.50),
      p("repeatLimit", "Tolerance for repeating one", 0.35),
    ],
  },
  {
    id: 46, key: "commitment_evasion", label: "Commitment Evasion",
    meaning: "Movement is worth most once the opponent has committed to a punch or to coming forward.",
    opportunity: "The opponent committed to a punch or an advance.",
    success: "This fighter was moving or slipping while they were committed.",
    params: [
      p("moveChance", "Move on their commitment", CHAMP.lateralStrength),
      p("stepSize", "How far the step goes", 0.45),
      p("readCommit", "Read the commitment early", 0.50),
    ],
  },
  {
    id: 47, key: "make_miss_pay_exit", label: "Make-Miss-Pay-Exit",
    meaning: "Head movement is unfinished until the miss becomes a counter and the counter is followed by leaving.",
    opportunity: "A punch was evaded at close quarters.",
    success: "A counter landed and the fighter then got out.",
    params: [
      p("counterChance", "Cash the miss in", CHAMP.perfectReactChance),
      p("exitDistance", "How far to leave afterwards", 0.50),
      p("exitDelay", "How long to stay before leaving", 0.35),
    ],
  },
  {
    id: 48, key: "front_time_limit", label: "Front-Time Limit",
    meaning: "Taking several unanswered punches means staying directly in front for too long: counter, angle off, or get out.",
    opportunity: "Two punches taken with nothing sent back.",
    success: "The fighter answered, angled or disengaged.",
    params: [
      p("hitLimit", "Punches tolerated before reacting", 0.40),
      p("answerChance", "Answer rather than absorb", CHAMP.perfectReactChance * 0.85),
      p("disengage", "Break off instead of trading", 0.45),
    ],
  },
  {
    id: 49, key: "punch_neutralization", label: "Punch Neutralization",
    meaning: "Kill a specific punch with timing, distance and angle together rather than with one defensive move.",
    opportunity: "The opponent threw inside range.",
    success: "It did not land, and more than one layer was doing the work.",
    params: [
      p("layerBlend", "How many layers to use at once", 0.55),
      p("timingWeight", "Weight on timing over cover", 0.50),
      p("precision", "How finely the answer is measured", 0.45),
    ],
  },
  {
    id: 50, key: "reaction_engineering", label: "Reaction Engineering",
    meaning: "Feints and setup punches exist to cause a predictable reaction that the AI can exploit.",
    opportunity: "A feint or setup was offered in range.",
    success: "It pulled a defensive reaction out of the opponent.",
    params: [
      p("setupShare", "Share of work spent setting up", CHAMP.feintiness),
      p("readWindow", "How long to watch for the reaction", 0.45),
      p("exploitChance", "Commit to the read", CHAMP.rhythmCutCommit * 0.7),
    ],
  },
  {
    id: 51, key: "feint_conversion", label: "Feint Conversion",
    meaning: "A feint should lead to a real punch or positional change; otherwise it becomes an empty threat.",
    opportunity: "A feint was thrown.",
    success: "A real punch or a change of position followed inside the window.",
    params: [
      p("convertWindow", "Conversion window", 0.40),
      p("convertChance", "Chance of converting", CHAMP.comboCommitChance * 0.7),
      p("moveInstead", "Convert into movement rather than a punch", 0.35),
    ],
  },
  {
    id: 52, key: "feint_credibility", label: "Feint Credibility",
    meaning: "A successful real attack makes its future feint believable; repeated success can therefore become the foundation of deception.",
    opportunity: "A feint thrown while real work had recently landed.",
    success: "The opponent respected it.",
    params: [
      p("credibilityGain", "Credit earned per landed punch", 0.45),
      p("decay", "How fast credibility fades", 0.30),
      p("minLandings", "Landed work banked before feinting on it", 0.25),
    ],
  },
  {
    id: 53, key: "misdirection", label: "Misdirection",
    meaning: "Establish the expectation of one action and deliberately produce another.",
    opportunity: "A pattern had been established by repetition.",
    success: "The pattern was broken and the different action landed.",
    params: [
      p("patternLength", "Repeats before breaking", 0.40),
      p("switchChance", "Chance of breaking it", CHAMP.rhythmCutAggression * 0.6),
      p("targetSwitch", "Switch head and body", 0.45),
    ],
  },
  {
    id: 54, key: "trap_engineering", label: "Trap Engineering",
    meaning: "Exploit existing habits or deliberately display a fake vulnerability while remaining prepared to punish the expected response.",
    opportunity: "An opening was shown in range and the opponent went for it.",
    success: "The expected response was punished.",
    params: [
      p("baitFrequency", "How often to bait", 0.30),
      p("openingSize", "Size of the opening shown", 0.35),
      p("punishReadiness", "Readiness to punish", CHAMP.perfectReactChance),
    ],
  },
  {
    id: 55, key: "throwaway_setup", label: "Throwaway Setup",
    meaning: "Use a low-commitment punch primarily to capture attention or elicit a defensive reaction for the real attack.",
    opportunity: "A light punch was thrown without scoring.",
    success: "The real punch landed behind it.",
    params: [
      p("throwawayShare", "Share of punches thrown away", 0.35),
      p("commitLevel", "Commitment on the throwaway", 0.25),
      p("followWindow", "Window for the real punch", 0.50),
    ],
  },
  {
    id: 56, key: "setup_distraction_finish", label: "Three-Layer Combination",
    meaning: "Structure combinations as setup → distraction/reaction → intended scoring punch.",
    opportunity: "A combination reached a second punch.",
    success: "A third punch in the same chain scored.",
    params: [
      p("threeLayerChance", "Chance of going three deep", CHAMP.comboCommitChance * 0.6),
      p("layerGap", "Gap between layers", 0.35),
      p("finishPower", "Power held back for the finish", CHAMP.executionIntensity * 0.7),
    ],
  },
  {
    id: 57, key: "angular_combination_chaining", label: "Angular Combination Chaining",
    meaning: "Combination design should include positional and angular changes instead of being only a sequence of punches.",
    opportunity: "A combination of two or more punches.",
    success: "Position or angle changed inside the chain.",
    params: [
      p("angleChance", "Chance of stepping off inside a combination", CHAMP.lateralStrength * 0.7),
      p("angleSize", "How far to step", 0.40),
      p("midComboMove", "Move between punches rather than after", 0.45),
    ],
  },
  {
    id: 58, key: "layered_entry", label: "Layered Entry",
    meaning: "Work into range using combinations of feints, setups, explosive attacks, lead-hand control, counters, and angles.",
    opportunity: "Closing from outside into punching range.",
    success: "Got in behind a setup and scored without being caught on the way.",
    params: [
      p("entryVariety", "Layers used on the way in", 0.45),
      p("explosiveShare", "Explosive entries", CHAMP.aggression * 0.6),
      p("entryPatience", "Patience before entering", 0.40),
    ],
  },
  {
    id: 59, key: "rhythm_variability", label: "Rhythm Variability",
    meaning: "Prevent the opponent from knowing when punches, steps, combinations, or exits begin and end.",
    opportunity: "Sampled across a stretch of sustained work.",
    success: "The timing of that work varied instead of settling into a beat.",
    params: [
      p("tempoRange", "Spread of tempo", 0.45),
      p("pauseChance", "Chance of breaking off", 0.30),
      p("exitVariety", "Variety of exits", CHAMP.rhythmSwayAdapt * 0.6),
    ],
  },
  {
    id: 60, key: "opening_calibration", label: "Opening Calibration",
    meaning: "Use early punches partly to establish range and observe defensive reactions.",
    opportunity: "A punch is thrown inside the opening window of the round.",
    success: "It was thrown from reach and drew a defensive reaction that got recorded.",
    params: [
      p("probeShare", "Probe share of early punches", 0.35),
      p("windowSec", "Opening window (fraction of round)", 0.25),
      p("readWeight", "Weight of observed reactions", CHAMP.stateThinkSpeed * 0.7),
    ],
  },
  {
    id: 61, key: "finish_discipline", label: "Finish Discipline",
    meaning: "When the opponent is hurt, increase exploitation without abandoning defense or blindly rushing.",
    opportunity: "The opponent is hurt.",
    success: "Output rose while guard stayed above the floor and no counter landed.",
    params: [
      p("hurtThreshold", "Hurt trigger", CHAMP.headCondThreshold),
      p("aggressionGain", "Aggression gain", CHAMP.aggression),
      p("guardFloor", "Guard floor held", CHAMP.guardParanoia),
      p("overcommitCap", "Overcommit ceiling", CHAMP.cleanHitsVsVolume),
    ],
  },
  {
    id: 62, key: "recovery_jab", label: "Reset Jab",
    meaning: "When tired, use the jab as a distance-management action that can create Reset time.",
    opportunity: "Own Reset is active or energy is low.",
    success: "A long-range jab bought Reset time without being countered.",
    params: [
      p("resetTrigger", "Energy trigger", 0.30),
      p("jabShare", "Jab share while resetting", 0.45),
      p("minRange", "Minimum range to jab from", CHAMP.ropeEscapeAwareness),
    ],
  },
  {
    id: 63, key: "miss_recovery", label: "Miss Reset",
    meaning: "Treat a missed punch as a positional error requiring immediate Reset, defense, or movement.",
    opportunity: "Own punch missed.",
    success: "Defence, Reset or movement started inside the window before being hit.",
    params: [
      p("reactWindow", "Reaction window", 0.35),
      p("defenseVsMove", "Defence vs movement bias", 0.50),
      p("resetChance", "Reset likelihood", 0.30),
    ],
  },
  {
    id: 64, key: "back_foot_invitation", label: "Back-Foot Invitation",
    meaning: "Yield apparent initiative to encourage the opponent forward, then exploit their commitment.",
    opportunity: "The opponent is advancing.",
    success: "Ground was given, then a counter landed on their forward commitment.",
    params: [
      p("yieldDistance", "Ground given", 0.55),
      p("inviteDuration", "How long to invite", 0.40),
      p("counterTrigger", "Commitment trigger", CHAMP.lateralStrength),
    ],
  },
  {
    id: 65, key: "double_jab_disruption", label: "Double-Jab Disruption",
    meaning: "First jab provokes the defense, second exploits the reaction and disturbs rhythm.",
    opportunity: "A jab was thrown.",
    success: "A second jab followed inside the gap and landed or disturbed the guard.",
    params: [
      p("doubleChance", "Double-up chance", 0.50),
      p("gap", "Inter-jab gap", 0.30),
      p("targetShift", "Target shift on the second", 0.35),
    ],
  },
  {
    id: 66, key: "check_hook_intercept", label: "Check-Hook Intercept",
    meaning: "Punish careless forward rushing before the opponent reaches smothering range.",
    opportunity: "The opponent is rushing in and still outside smothering range.",
    success: "A hook landed before they closed.",
    params: [
      p("rushTrigger", "Rush-speed trigger", 0.60),
      p("interceptRange", "Intercept range", 0.55),
      p("commitChance", "Commit chance", CHAMP.rhythmCutCommit * 0.55),
    ],
  },
  {
    id: 67, key: "close_miss_countering", label: "Close-Miss Countering",
    meaning: "Evade by the minimum distance needed so the fighter stays close enough to counter.",
    opportunity: "An incoming punch was evaded.",
    success: "A counter landed before the attacking hand recovered.",
    params: [
      p("evadeMargin", "Minimum evade margin", 0.25),
      p("counterWindow", "Counter window", CHAMP.perfectReactChance * 0.55),
    ],
  },
  {
    id: 68, key: "lead_hand_occupation", label: "Lead-Hand Occupation",
    meaning: "Manipulate or occupy the opponent's lead hand to remove it as an option.",
    opportunity: "In range of the opponent's lead hand.",
    success: "The lead hand was occupied and a follow-up landed.",
    params: [
      p("targetShare", "Work aimed at the lead hand", 0.30),
      p("range", "Working range", 0.60),
      p("followUp", "Follow-up chance", 0.45),
    ],
  },
  {
    id: 69, key: "hand_check_disruption", label: "Hand-Check Rhythm Disruption",
    meaning: "Feinted glove contact from range interrupts timing while staying defensively responsible.",
    opportunity: "At hand-check range.",
    success: "A feinted contact broke their timing while guard held.",
    params: [
      p("checkRange", "Check range", 0.55),
      p("checkRate", "Check rate", CHAMP.feintiness),
      p("guardKeep", "Guard kept while checking", CHAMP.guardParanoia),
    ],
  },
  {
    id: 70, key: "pull_counter", label: "Pull Counter",
    meaning: "Bait the straight, evade backward at commitment, fire the cross during recovery, then roll out.",
    opportunity: "The opponent threw a straight while baited.",
    success: "Pulled back, cross landed during their recovery, then rolled or exited.",
    params: [
      p("baitDistance", "Bait distance", 0.60),
      p("pullTrigger", "Pull trigger", CHAMP.perfectReactChance),
      p("crossDelay", "Cross delay", 0.30),
      p("exitChance", "Exit after countering", CHAMP.rhythmSwayAdapt * 0.6),
    ],
  },
  {
    id: 71, key: "attrition_targeting", label: "Attrition Targeting",
    meaning: "Target the body or shoulders when the goal is degrading stamina or defense, not immediate damage.",
    opportunity: "Choosing a target.",
    success: "Body or shoulder work measurably cut their stamina or guard.",
    params: [
      p("bodyShare", "Share aimed at the body", 0.40),
      p("staminaWeight", "Weight on the stamina goal", 0.55),
      p("switchThreshold", "Switch back to the head at", CHAMP.bodyCondThreshold),
    ],
  },
  {
    id: 72, key: "emergency_blocking", label: "Emergency Blocking",
    meaning: "Blocking is the fallback once distance positioning has already failed.",
    opportunity: "An incoming punch with no positional escape left.",
    success: "The block held.",
    params: [
      p("failTrigger", "Position-failed trigger", 0.35),
      p("blockCommit", "Block commitment", CHAMP.guardParanoia * 1.2),
    ],
  },
  {
    id: 73, key: "forced_readjustment", label: "Forced Readjustment",
    meaning: "Favor attacks that force the opponent to reposition, re-guard, or reset before acting again.",
    opportunity: "Choosing a punch.",
    success: "The chosen punch forced them to reposition or re-guard before acting.",
    params: [
      p("preferenceWeight", "Preference weight", 0.45),
      p("minDisplacement", "Displacement that counts", 0.35),
    ],
  },

  // ---- Basics (74-84): beginner technique from Coach Anthony's playlist
  // (`.agents/skills/neural-networks/references/boxing-basics.md`). These come
  // underneath everything above: a boxer who leans in, leaves the hand out or
  // stands on the centre line loses the exchange before strategy matters. The
  // defensive ones replace the fixed-odds reflex pick with an answer per kind of
  // punch, so which defence the AI uses against what is learned in training.
  {
    id: 74, layer: "basics", key: "basics_balanced_range", label: "Punch From Balance",
    meaning: "Throw from your stance at a distance the punch can reach, instead of leaning over the front knee to chase it.",
    opportunity: "Threw a punch.",
    success: "The opponent was inside that punch's reach, short of full stretch, when it was thrown.",
    params: [
      p("rangeDiscipline", "Wait until in range", 0.55),
      p("weightBack", "Weight kept on the back foot", 0.50),
    ],
  },
  {
    id: 75, layer: "basics", key: "basics_hands_home", label: "Hands Back Home",
    meaning: "Bring the hand straight back to the chin after every punch, chin tucked behind the shoulder.",
    opportunity: "Threw a punch.",
    success: "Not hit while the punch was coming back.",
    params: [
      p("guardReturn", "Speed of the guard coming back", CHAMP.guardParanoia),
    ],
  },
  {
    id: 76, layer: "basics", key: "basics_one_two", label: "The 1-2",
    meaning: "As the jab lands, the cross is already on its way.",
    opportunity: "Threw a jab.",
    success: "A cross followed straight behind it.",
    params: [
      p("followChance", "Cross behind the jab", CHAMP.comboCommitChance * 0.8),
    ],
  },
  {
    id: 77, layer: "basics", key: "basics_hook_off_straight", label: "Hook Off the Right Hand",
    meaning: "The cross loads the lead hook: weight shifts to the front foot and the hook comes back the other way.",
    opportunity: "Threw a cross.",
    success: "A lead hook followed and landed.",
    params: [
      p("hookChance", "Hook after the cross", CHAMP.comboCommitChance * 0.6),
    ],
  },
  {
    id: 78, layer: "basics", key: "basics_head_off_line", label: "Head Off the Centre Line",
    meaning: "Hit and don't get hit: when the punches stop, the head moves off the centre line instead of staying where it was.",
    opportunity: "Finished throwing with the opponent in range.",
    success: "Slipped or rolled right away and was not hit.",
    params: [
      p("moveAfter", "Move the head after punching", 0.45),
    ],
  },
  {
    id: 79, layer: "basics", key: "basics_slip_straight", label: "Slip the Straight",
    meaning: "A jab or cross to the head is answered by a small slip to the side, staying close enough to counter.",
    opportunity: "A straight punch to the head was coming.",
    success: "Slipped or ducked it and it missed.",
    params: [
      p("slipChoice", "Slip rather than block", 0.40),
    ],
  },
  {
    id: 80, layer: "basics", key: "basics_roll_hook", label: "Roll Under the Hook",
    meaning: "A hook to the head is beaten by bobbing under it (the U-shaped roll), which also gets the head to the safe side.",
    opportunity: "A hook to the head was coming.",
    success: "Rolled under it and it missed.",
    params: [
      p("rollChoice", "Roll rather than block", 0.40),
    ],
  },
  {
    id: 81, layer: "basics", key: "basics_guard_uppercut", label: "Don't Duck the Uppercut",
    meaning: "An uppercut comes up the middle, so dropping into it is the worst answer; keep the guard tight or step back.",
    opportunity: "An uppercut was coming.",
    success: "It missed or was blocked, without ducking into it.",
    params: [
      p("guardChoice", "Guard or step back rather than duck", 0.60),
    ],
  },
  {
    id: 82, layer: "basics", key: "basics_elbows_body", label: "Elbows In for the Body",
    meaning: "Body shots are caught on the elbows and forearms; slipping the head does nothing for the body.",
    opportunity: "A body shot was coming.",
    success: "It was blocked or missed.",
    params: [
      p("elbowChoice", "Elbow block rather than evade", 0.55),
    ],
  },
  {
    id: 83, layer: "basics", key: "basics_tight_counter", label: "Tight Defence, Quick Counter",
    meaning: "Keep slips and rolls small so the hands are free to answer straight away.",
    opportunity: "Made a punch miss by slipping or ducking.",
    success: "Landed a counter right after.",
    params: [
      p("counterChance", "Counter after a slip or roll", CHAMP.perfectReactChance * 0.6),
    ],
  },
  {
    id: 84, layer: "basics", key: "basics_cutoff_body_hook", label: "Body Hook Cut-Off",
    meaning: "The rear hook to the body, thrown from the middle without leaning, cuts off an opponent circling away.",
    opportunity: "The opponent moved sideways or away at close range.",
    success: "A rear hook to the body landed.",
    params: [
      p("cutoffChance", "Body hook on the escape", CHAMP.ringCutoff * 0.6),
    ],
  },
  // ---- Basics, second batch: fight scenarios (hit-and-not-get-hit, boxing a
  // pressure fighter, rolling off the hook, the jab, the three ranges, the
  // double jab, setting up the knockout).
  {
    id: 85, layer: "basics", key: "basics_catch_return_jab", label: "Catch and Return the Jab",
    meaning: "Rear hand home at the chin catches their jab; the jab goes straight back before they reset.",
    opportunity: "Blocked an incoming straight with the guard.",
    success: "Threw a jab back within 0.5 s.",
    params: [
      p("returnJab", "Jab back after catching a straight", 0.35),
    ],
  },
  {
    id: 86, layer: "basics", key: "basics_catch_hook_fire_back", label: "Catch the Hook, Fire Back",
    meaning: "Catch their hook and answer between their shots with a real power punch, so pressure has a price.",
    opportunity: "Blocked an incoming hook, uppercut or body shot with the guard.",
    success: "Threw a cross, hook or uppercut back within 0.6 s.",
    params: [
      p("fireBack", "Power punch back after catching a hook", 0.3),
    ],
  },
  {
    id: 87, layer: "basics", key: "basics_slip_and_rip", label: "Slip and Rip",
    meaning: "Slip the right hand that comes back after your hook, and rip a body shot from down there.",
    opportunity: "Slipped or ducked a straight to the head without being hit.",
    success: "A body punch landed within 0.8 s.",
    params: [
      p("ripChance", "Body shot off the slip", 0.3),
    ],
  },
  {
    id: 88, layer: "basics", key: "basics_double_hook", label: "Double Up the Hook",
    meaning: "Hook blocked and nothing came back? Roll with it and throw the hook again.",
    opportunity: "Own hook was blocked.",
    success: "Threw another hook within 0.7 s without getting hit in between.",
    params: [
      p("doubleChance", "Second hook after a blocked one", 0.3),
    ],
  },
  {
    id: 89, layer: "basics", key: "basics_jab_and_exit", label: "Jab and Get Out",
    meaning: "Step in, land the jab, step back out of range. Don't stay in the house when you don't want to fight there.",
    opportunity: "Landed a jab.",
    success: "Out of the opponent's reach within 0.6 s and not hit.",
    params: [
      p("exitChance", "Step out after the jab", CHAMP.ropeEscapeAwareness),
    ],
  },
  {
    id: 90, layer: "basics", key: "basics_inside_work", label: "Inside Work",
    meaning: "At close range it's hooks to the body and uppercuts up the middle, not long straights.",
    opportunity: "Threw a punch at close range.",
    success: "It was a body punch or an uppercut.",
    params: [
      p("insideChance", "Body or uppercut when inside", 0.4),
    ],
  },
  {
    id: 91, layer: "basics", key: "basics_off_the_ropes", label: "Off the Ropes",
    meaning: "Backed to the ropes: circle out straight away instead of covering up there.",
    opportunity: "Near the ropes with the opponent close.",
    success: "Back off the ropes within 1.5 s, taking fewer than two punches.",
    params: [
      p("escapeChance", "Circle off the ropes", CHAMP.ropeEscapeAwareness),
    ],
  },
  {
    id: 92, layer: "basics", key: "basics_circle_off", label: "Circle, Don't Back Up Straight",
    meaning: "Against a fighter walking you down, move left or right, not straight back in front of them.",
    opportunity: "The opponent advanced at mid range.",
    success: "Moved more sideways than straight back over the next 0.6 s.",
    params: [
      p("circleChance", "Circle against pressure", CHAMP.lateralStrength),
    ],
  },
  {
    id: 93, layer: "basics", key: "basics_body_then_head", label: "Downstairs, Then Upstairs",
    meaning: "Body shots pull the elbows down; the hook to the chin goes in as they drop.",
    opportunity: "Landed a body punch.",
    success: "A head punch landed within 1 s.",
    params: [
      p("upstairsChance", "Head shot after the body", 0.35),
    ],
  },
  {
    id: 94, layer: "basics", key: "basics_mix_levels", label: "Mix Head and Body",
    meaning: "Don't repeat the same target: switching between head and body stops them timing you.",
    opportunity: "Every fourth punch thrown.",
    success: "The last four punches went to both head and body.",
    params: [
      p("mixChance", "Switch target level", 0.35),
    ],
  },
];

/** Close range ("zone 1") for the Basics layer, centre to centre in px.
 *  Shared by the AI's inside-work bias and the training observer. */
export const BASICS_INSIDE_PX = 80;

/** The Basics layer's four kinds of incoming punch. Shared by the AI's answer
 *  pick and the training observer so both classify a punch the same way.
 *  Body = not aimed at the head, the same bit hit resolution reads. */
export type BasicsPunchClass = "straight" | "hook" | "uppercut" | "body";
export function basicsPunchClass(f: { currentPunch: string | null; punchAimsHead: boolean }): BasicsPunchClass | null {
  const p = f.currentPunch;
  if (!p) return null;
  if (!f.punchAimsHead) return "body";
  if (p === "jab" || p === "cross") return "straight";
  if (p === "leftHook" || p === "rightHook") return "hook";
  return "uppercut";
}

export const FUNDAMENTAL_BY_KEY: Record<string, Fundamental> =
  Object.fromEntries(FUNDAMENTALS.map(f => [f.key, f]));

/** Namespaced parameter id, e.g. `pull_counter.crossDelay`. */
export function paramId(fundKey: string, paramKey: string): string {
  return `${fundKey}.${paramKey}`;
}

export interface FundStat { attempts: number; successes: number; }

export interface FundamentalSeed {
  id: number;
  name: string;
  /** Generation the seed was born in. */
  gen: number;
  /** Namespaced parameter id -> value. */
  params: Record<string, number>;
  /** Fundamental key -> tally for the current generation. Cleared at the cut,
   *  because the cut ranks on what the seed is doing now. */
  stats: Record<string, FundStat>;
  /** The same tally, never cleared. Follows the slot across generations, so it
   *  spans both the seeds that survived a cut and the ones that replaced them. */
  lifetime: Record<string, FundStat>;
  wins: number;
  losses: number;
  bouts: number;
  /** Seed ids this one was bred from, null for a founder. */
  parents: [number, number] | null;
  /** Fundamentals carried over intact because this seed's ancestor out-executed
   *  the champion on them. Purely informational. */
  salvaged: string[];
}

export function emptyStats(): Record<string, FundStat> {
  const out: Record<string, FundStat> = {};
  for (const f of FUNDAMENTALS) out[f.key] = { attempts: 0, successes: 0 };
  return out;
}

export function defaultParams(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of FUNDAMENTALS) {
    for (const pr of f.params) out[paramId(f.key, pr.key)] = pr.def;
  }
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Backfills any parameter or tally added since the seed was saved. */
function normalizeStats(src: Record<string, FundStat> | undefined): Record<string, FundStat> {
  const out = { ...emptyStats(), ...(src || {}) };
  for (const f of FUNDAMENTALS) {
    const s = out[f.key];
    out[f.key] = {
      attempts: Number.isFinite(s?.attempts) ? s.attempts : 0,
      successes: Number.isFinite(s?.successes) ? s.successes : 0,
    };
  }
  return out;
}

export function normalizeSeed(seed: FundamentalSeed): FundamentalSeed {
  const params = { ...defaultParams(), ...(seed.params || {}) };
  for (const f of FUNDAMENTALS) {
    for (const pr of f.params) {
      const id = paramId(f.key, pr.key);
      const v = Number(params[id]);
      params[id] = Number.isFinite(v) ? clamp(v, pr.min, pr.max) : pr.def;
    }
  }
  return {
    ...seed,
    params,
    stats: normalizeStats(seed.stats),
    // Absent on every save written before lifetime totals existed. Seeding it
    // from the current generation is the closest true figure available; zeroing
    // it would throw away the only record there is.
    lifetime: normalizeStats(seed.lifetime || seed.stats),
    wins: seed.wins || 0,
    losses: seed.losses || 0,
    bouts: seed.bouts || 0,
    salvaged: Array.isArray(seed.salvaged) ? seed.salvaged : [],
  };
}

export function makeFounder(id: number, name: string, scatter: number, rand: () => number): FundamentalSeed {
  const params = defaultParams();
  // Founders are champion-anchored but never identical, or the first generation
  // has nothing to select between.
  for (const f of FUNDAMENTALS) {
    for (const pr of f.params) {
      const key = paramId(f.key, pr.key);
      params[key] = clamp(params[key] + (rand() * 2 - 1) * scatter, pr.min, pr.max);
    }
  }
  return { id, name, gen: 0, params, stats: emptyStats(), lifetime: emptyStats(), wins: 0, losses: 0, bouts: 0, parents: null, salvaged: [] };
}

export function executionRate(seed: FundamentalSeed, fundKey: string): number {
  const s = seed.stats[fundKey];
  if (!s || s.attempts <= 0) return 0;
  return s.successes / s.attempts;
}

/** The same rate over every generation this slot has run. */
export function lifetimeRate(seed: FundamentalSeed, fundKey: string): number {
  const s = seed.lifetime?.[fundKey];
  if (!s || s.attempts <= 0) return 0;
  return s.successes / s.attempts;
}

/** Fundamentals this seed is executing below the floor. A seed with any of these
 *  is failing and cannot become a parent. Fundamentals that never came up are not
 *  counted against it. */
export function failedFundamentals(seed: FundamentalSeed): string[] {
  return FUNDAMENTALS
    .filter(f => (seed.stats[f.key]?.attempts ?? 0) > 0 && executionRate(seed, f.key) < EXEC_FLOOR)
    .map(f => f.key);
}

export function winRate(seed: FundamentalSeed): number {
  return seed.bouts > 0 ? seed.wins / seed.bouts : 0;
}

/** Total opportunities credited to a seed across every fundamental. Zero means
 *  the seed has no evidence either way, which is not the same as being clean. */
export function totalAttempts(seed: FundamentalSeed): number {
  let n = 0;
  for (const f of FUNDAMENTALS) n += seed.stats[f.key]?.attempts ?? 0;
  return n;
}

/** Has evidence, and nothing in it is below the floor. */
export function isProvenClean(seed: FundamentalSeed): boolean {
  return totalAttempts(seed) > 0 && failedFundamentals(seed).length === 0;
}

/**
 * Rank for parent selection: win rate first, with seeds that are failing a
 * fundamental pushed below every clean seed. A generation where everyone is
 * failing still has to produce two parents, so this orders rather than excludes.
 */
export function rankSeeds(pop: FundamentalSeed[]): FundamentalSeed[] {
  return [...pop].sort((a, b) => {
    // Clean requires evidence. A seed credited with nothing has no failures to
    // show, and without this it would sort above seeds that are demonstrably
    // competent — which is reachable now that evidence is only awarded for
    // winning a series, so a seed can end a generation with none at all.
    const ca = isProvenClean(a), cb = isProvenClean(b);
    if (ca !== cb) return ca ? -1 : 1;
    const wr = winRate(b) - winRate(a);
    if (Math.abs(wr) > 1e-9) return wr;
    return failedFundamentals(a).length - failedFundamentals(b).length;
  });
}

/** A seed drawn fresh across the whole parameter space rather than bred from
 *  anything. Used to replace the bottom half of a generation. */
export function makeRandomSeed(id: number, name: string, gen: number, rand: () => number): FundamentalSeed {
  const params: Record<string, number> = {};
  for (const f of FUNDAMENTALS) {
    for (const pr of f.params) params[paramId(f.key, pr.key)] = pr.min + rand() * (pr.max - pr.min);
  }
  return { id, name, gen, params, stats: emptyStats(), lifetime: emptyStats(), wins: 0, losses: 0, bouts: 0, parents: null, salvaged: [] };
}

export interface EvolveResult {
  next: FundamentalSeed[];
  /** Ids that survived the cut, best first. */
  survivors: number[];
  /** Ids that were thrown out and drawn again. */
  replaced: number[];
  /** Replaced seed id -> fundamentals its successor inherited anyway. */
  salvageLog: Record<number, string[]>;
}

/**
 * Close a generation.
 *
 * The top half is kept exactly as it boxed — a seed that won its 1000 fights has
 * already been selected for, and re-rolling it would throw that away. The bottom
 * half is not bred from the survivors, it is discarded and drawn fresh across the
 * whole parameter space, which is what keeps the search exploring instead of
 * converging on small variations of the first thing that worked.
 *
 * The salvage rule is the exception. A fundamental that a discarded seed executed
 * more often than *every* surviving opponent is carried into its replacement
 * untouched. Losing overall does not mean every part of a boxer was wrong, and
 * this stops a genuinely strong habit from being thrown out with the seed that
 * happened to be carrying it. Untouched is deliberate: re-rolling or scattering
 * those parameters would undo the thing that earned the carry-over.
 */
export function evolveNextGeneration(
  pop: FundamentalSeed[],
  gen: number,
  rand: () => number,
  /** Builds the replacements for the emptied slots (in population order).
   *  Absent: every replacement is drawn from the whole space. */
  replace?: (slots: { id: number; name: string }[], gen: number) => FundamentalSeed[],
): EvolveResult {
  const ranked = rankSeeds(pop);
  const keep = Math.ceil(ranked.length / 2);
  const survivors = ranked.slice(0, keep);
  const cut = ranked.slice(keep);
  const survivorIds = new Set(survivors.map(s => s.id));
  const salvageLog: Record<number, string[]> = {};
  const emptied = pop.filter(p => !survivorIds.has(p.id)).map(p => ({ id: p.id, name: p.name }));
  const built = replace ? replace(emptied, gen) : [];
  const builtById = new Map(built.map(b => [b.id, b]));

  const next = pop.map(prev => {
    if (survivorIds.has(prev.id)) {
      // Kept whole; only the tallies start again.
      return { ...prev, gen, stats: emptyStats(), wins: 0, losses: 0, bouts: 0, salvaged: [] } satisfies FundamentalSeed;
    }

    const salvaged = FUNDAMENTALS
      .filter(f => {
        const mine = prev.stats[f.key]?.successes ?? 0;
        return mine > 0 && survivors.every(s => mine > (s.stats[f.key]?.successes ?? 0));
      })
      .map(f => f.key);
    if (salvaged.length > 0) salvageLog[prev.id] = salvaged;

    const fresh = builtById.get(prev.id) ?? makeRandomSeed(prev.id, prev.name, gen, rand);
    // The lifetime tally belongs to the slot, not the individual, so it crosses
    // the replacement intact — that is the whole point of it never resetting.
    fresh.lifetime = prev.lifetime;
    for (const key of salvaged) {
      for (const pr of FUNDAMENTAL_BY_KEY[key].params) {
        const id = paramId(key, pr.key);
        fresh.params[id] = clamp(prev.params[id] ?? pr.def, pr.min, pr.max);
      }
    }
    fresh.salvaged = salvaged;
    return fresh;
  });

  return { next, survivors: survivors.map(s => s.id), replaced: cut.map(s => s.id), salvageLog };
}

// --------------------------------------------------------- behaviour mapping

const lerp = (a: number, b: number, t: number) => a + (b - a) * clamp(t, 0, 1);

/**
 * Fold a seed's fundamentals down onto the 24 neural parameters the AI already
 * reads. Each knob is a blend of the fundamentals that speak to it, so moving a
 * fundamental moves real behaviour and the tuning screen keeps working unchanged.
 */
/** Takes anything carrying a parameter map, so a set assembled on the fly — the
 *  champion with one fundamental's remembered block swapped in — derives the
 *  same way a whole seed does. */
export function deriveNeuralState(seed: { params: Record<string, number> }): Record<string, number> {
  const g = (fund: string, param: string, fallback = 0.5): number => {
    const v = seed.params[paramId(fund, param)];
    return Number.isFinite(v) ? v : fallback;
  };
  const avg = (...xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

  const out: Record<string, number> = {
    aggression: avg(g("finish_discipline", "aggressionGain"), g("check_hook_intercept", "commitChance"), g("layered_entry", "explosiveShare"), 1 - g("back_foot_invitation", "yieldDistance"),
      g("active_defense", "answerChance"), g("front_time_limit", "answerChance"),
      g("continuous_advantage", "initiativeWeight"), g("counter_expected_value", "riskTolerance"),
      g("initiative_priority", "firstActChance"), g("responsible_pressure", "advanceRate"),
      g("reset_exploitation", "strikeChance"), g("balance_integrity", "overreachLimit"),
      g("functional_punch_effect", "pushChance")),
    guardParanoia: avg(g("basics_hands_home", "guardReturn"), g("finish_discipline", "guardFloor"), g("hand_check_disruption", "guardKeep"), g("emergency_blocking", "blockCommit"), 1 - g("trap_engineering", "openingSize"),
      g("distance_first_defense", "guardWhenClose"), g("return_fire_expectation", "recoverGuard"), g("integrated_evasion", "preDefend"),
      g("defensive_responsibility", "guardWhilePunching"), g("threat_assumption", "suspicion"),
      g("threat_assumption", "safeEntry"), g("counter_threat_mapping", "threatWeight"),
      g("counter_threat_mapping", "preDefend"), g("responsible_pressure", "safetyMargin")),
    feintiness: avg(g("hand_check_disruption", "checkRate"), g("lead_hand_occupation", "targetShare"), g("pull_counter", "baitDistance"),
      g("reaction_engineering", "setupShare"), g("feint_conversion", "convertChance"), g("feint_credibility", "credibilityGain"),
      g("trap_engineering", "baitFrequency"), g("throwaway_setup", "throwawayShare"),
      g("counter_window_creation", "baitRate"), g("dead_zone_avoidance", "baitInstead"),
      g("active_patience", "threatWhileWaiting"), g("information_harvesting", "probeRate"),
      g("lead_hand_dominance", "leadActivity")),
    cleanHitsVsVolume: avg(g("basics_balanced_range", "rangeDiscipline"), g("opening_calibration", "probeShare"), g("finish_discipline", "overcommitCap"), g("lead_hand_occupation", "followUp"),
      g("feint_credibility", "minLandings"), 1 - g("throwaway_setup", "commitLevel"),
      g("punch_neutralization", "precision"), g("counter_variation", "typeSpread"),
      g("continuous_advantage", "gainThreshold"), g("pressure_decision_quality", "simplifyWhenTired"),
      g("habit_exploitation", "confirmCount"), g("threat_assumption", "verifyDemand"),
      g("defense_vulnerability_model", "exploitChance"), g("counter_threat_mapping", "punchChoiceSafety"),
      g("counter_expected_value", "rewardWeight"), 1 - g("functional_punch_effect", "effectWeight"),
      g("positional_shot_selection", "rangeMatch"), g("positional_shot_selection", "openingMatch"),
      g("positional_shot_selection", "wrongShotResist")),

    stateThinkSpeed: avg(g("opening_calibration", "readWeight"), g("close_miss_countering", "counterWindow"), g("reaction_engineering", "readWindow"),
      g("counter_window_recognition", "windowRead"), g("return_fire_expectation", "anticipation"), g("commitment_evasion", "readCommit"),
      g("defensive_responsibility", "returnAwareness"), g("combat_composure", "calmBase"),
      g("layered_adaptation", "readWindow"), g("predictive_timing", "leadTime"),
      g("habit_exploitation", "repeatMemory"), g("impact_diagnosis", "diagnoseWindow"),
      g("defense_vulnerability_model", "readDefense"), g("initiative_priority", "readyBias"),
      g("momentum_management", "streakMemory"), g("reset_exploitation", "readEndOfExchange")),
    moveThinkSpeed: avg(g("miss_recovery", "defenseVsMove"), g("back_foot_invitation", "inviteDuration"),
      g("angular_combination_chaining", "midComboMove"), g("layered_entry", "entryPatience"),
      g("commitment_evasion", "moveChance"), g("dead_zone_avoidance", "exitChance"), g("integrated_evasion", "defendWhilePunching"),
      g("range_elasticity", "entrySpeed"), g("range_elasticity", "exitSpeed"),
      g("step_timing", "stepRead"), g("step_timing", "timingOffset"),
      g("ring_interception", "projectAhead"), g("post_action_positioning", "endPositionWeight"),
      g("post_action_positioning", "adjustAfter"), g("exchange_cycle", "entryWeight"),
      g("combat_state_transition", "carryBalance"), g("exit_to_reentry", "reentrySpeed")),
    attackInterval: avg(g("double_jab_disruption", "doubleChance"), 1 - g("double_jab_disruption", "gap"),
      1 - g("setup_distraction_finish", "layerGap"), g("rhythm_variability", "tempoRange"),
      g("counter_variation", "repeatLimit"), g("make_miss_pay_exit", "exitDelay"),
      g("continuous_advantage", "neutralLimit"), g("combat_composure", "rushResist"),
      g("active_patience", "waitLength"), g("information_harvesting", "earlyWindow"),
      g("counter_expected_value", "declineChance"), g("initiative_priority", "neutralPatience"),
      g("tempo_control", "tempoOwn"), g("reset_exploitation", "strikeDelay")),

    perfectReactChance: avg(g("basics_tight_counter", "counterChance"), g("pull_counter", "pullTrigger"), g("close_miss_countering", "counterWindow"), g("check_hook_intercept", "rushTrigger"), g("trap_engineering", "punishReadiness"),
      g("counter_window_recognition", "reactSpeed"), g("make_miss_pay_exit", "counterChance"), g("counter_window_creation", "punishReady"),
      g("predictive_timing", "patternWeight"), g("habit_exploitation", "punishChance"),
      g("momentum_management", "interruptChance"), g("reset_advantage", "exploitTheirs")),
    defenseCycleSpeed: avg(g("miss_recovery", "reactWindow"), g("emergency_blocking", "failTrigger"), g("close_miss_countering", "evadeMargin"),
      g("defensive_variation", "switchRate"), g("punch_neutralization", "layerBlend"), g("counter_window_recognition", "windowDecay"),
      g("distance_first_defense", "layerOrder"), g("integrated_evasion", "postDefend"),
      g("combat_composure", "recoverRate"), g("style_plasticity", "switchRate"),
      g("layered_adaptation", "layerCount"), g("reset_advantage", "resetSpeed"),
      g("reset_advantage", "resetPriority"), g("balance_integrity", "balanceKeep"),
      g("balance_integrity", "recoverSpeed"), g("exchange_cycle", "transitionWeight"),
      g("combat_state_transition", "switchSpeed"), 1 - g("combat_state_transition", "deadTimeLimit"),
      g("exit_to_reentry", "resetFirst")),
    /**
     * Intentional perfect block — how readily this seed loads a timed block
     * *before* the punch, rather than reacting to one already in flight (that is
     * perfectReactChance, which folds the counter fundamentals).
     *
     * The one knob here with no counterpart in the shipped Champion set, and
     * deliberately so: only a seed produces it, so a hand-tuned neural override
     * never carries the field and career opponents keep their difficulty-and-rank
     * baseline. The AI blocks on purpose only when it is actually running
     * fundamentals. Every param below is about being loaded for a punch that
     * hasn't landed yet, which is exactly what the mechanic rewards.
     */
    perfectBlockIntent: avg(g("emergency_blocking", "blockCommit"), g("emergency_blocking", "failTrigger"),
      g("punch_neutralization", "timingWeight"), g("integrated_evasion", "preDefend"),
      g("counter_threat_mapping", "preDefend"), g("defensive_responsibility", "guardWhilePunching"),
      g("distance_first_defense", "guardWhenClose"), g("return_fire_expectation", "anticipation"),
      g("threat_assumption", "suspicion")),
    headCondThreshold: g("finish_discipline", "hurtThreshold"),
    bodyCondThreshold: avg(g("attrition_targeting", "switchThreshold"), g("misdirection", "targetSwitch")),

    rhythmCutCommit: avg(g("check_hook_intercept", "commitChance"), g("forced_readjustment", "preferenceWeight"), g("reaction_engineering", "exploitChance"),
      g("counter_window_creation", "baitCommit"),
      g("active_patience", "commitTrigger"), g("predictive_timing", "commitConfidence"),
      g("ring_generalship", "timeControl")),
    rhythmCutAggression: avg(g("double_jab_disruption", "targetShift"), g("hand_check_disruption", "checkRate"),
      g("misdirection", "switchChance"), g("rhythm_variability", "pauseChance"),
      g("counter_variation", "rotateChance"), g("defensive_variation", "methodSpread"),
      g("constraint_control", "rhythmDenial"), g("information_harvesting", "varietyDemand"),
      g("defense_vulnerability_model", "targetSwitch"), g("tempo_control", "changeRate")),
    rhythmSwayAdapt: avg(g("basics_head_off_line", "moveAfter"), g("pull_counter", "exitChance"), g("opening_calibration", "readWeight"),
      g("rhythm_variability", "exitVariety"), g("rhythm_variability", "tempoRange"),
      g("defensive_variation", "runLimit"), g("active_defense", "stillnessLimit"),
      g("style_plasticity", "styleRange"), g("layered_adaptation", "adjustRate"),
      g("impact_diagnosis", "changeMagnitude"), 1 - g("impact_diagnosis", "repeatTolerance"),
      g("tempo_control", "syncResist")),
    chargedPunchChance: avg(g("forced_readjustment", "minDisplacement"), g("attrition_targeting", "staminaWeight"), g("setup_distraction_finish", "finishPower"),
      g("punch_neutralization", "timingWeight")),
    comboCommitChance: avg(g("basics_one_two", "followChance"), g("basics_hook_off_straight", "hookChance"), g("double_jab_disruption", "doubleChance"), g("finish_discipline", "aggressionGain"), g("lead_hand_occupation", "followUp"),
      g("setup_distraction_finish", "threeLayerChance"), g("misdirection", "patternLength"),
      g("style_plasticity", "commitToStyle"), g("momentum_management", "compoundChance"),
      g("advantage_window", "windowLength"), g("advantage_window", "punchBudget"),
      g("lead_hand_dominance", "followThrough"), g("functional_punch_effect", "chainAfter")),
    executionIntensity: avg(g("finish_discipline", "aggressionGain"), g("pull_counter", "crossDelay"), g("attrition_targeting", "bodyShare"),
      g("setup_distraction_finish", "finishPower")),

    ringCutoff: avg(g("basics_cutoff_body_hook", "cutoffChance"), g("forced_readjustment", "preferenceWeight"), g("layered_entry", "entryVariety"), 1 - g("back_foot_invitation", "yieldDistance"),
      1 - g("distance_first_defense", "rangeKeep"),
      g("constraint_control", "optionDenial"), g("constraint_control", "exitDenial"),
      g("ring_generalship", "placeControl"), g("ring_generalship", "centreBias"),
      g("responsible_pressure", "pressureHold"), g("lead_hand_dominance", "controlRange"),
      g("ring_interception", "cutChance")),
    ropeEscapeAwareness: avg(g("basics_jab_and_exit", "exitChance"), g("basics_off_the_ropes", "escapeChance"), g("recovery_jab", "minRange"), g("miss_recovery", "resetChance"), g("feint_conversion", "moveInstead"),
      g("return_fire_expectation", "exitAfter"), g("front_time_limit", "disengage"),
      g("defensive_responsibility", "rangeDiscipline"), g("advantage_window", "exitOnTime"),
      g("range_elasticity", "dwellLimit"), g("exchange_cycle", "exitWeight")),
    lateralStrength: avg(g("basics_circle_off", "circleChance"), g("back_foot_invitation", "counterTrigger"), g("check_hook_intercept", "interceptRange"),
      g("angular_combination_chaining", "angleChance"), g("angular_combination_chaining", "angleSize"),
      g("active_defense", "moveShare"), g("commitment_evasion", "stepSize"), g("make_miss_pay_exit", "exitDistance"),
      g("dead_zone_avoidance", "exitDistance"),
      g("step_timing", "matchChance"), g("angle_dominance", "angleSeek"),
      g("angle_dominance", "angleHold"), g("angle_dominance", "angleSize"),
      g("ring_interception", "lateralBias"), g("post_action_positioning", "preferredEnd"),
      g("exit_to_reentry", "exitAngle")),

    // Getting up is not a fundamental in this set, so these stay at the champion
    // values rather than drifting on unrelated genes.
    kdRecovery1: CHAMP.kdRecovery1,
    kdRecovery2: CHAMP.kdRecovery2,
    kdRecovery3: CHAMP.kdRecovery3,
    survivalInstinct: avg(g("basics_balanced_range", "weightBack"), g("recovery_jab", "resetTrigger"), g("emergency_blocking", "blockCommit"), g("miss_recovery", "resetChance"),
      g("front_time_limit", "hitLimit"),
      g("pressure_decision_quality", "composureUnderFire"), g("pressure_decision_quality", "panicResist")),
    // Basics: which answer to pick against each kind of incoming punch, plus
    // moving the head after punching. Seed-only knobs (not in the admin
    // registry), so only fundamentals-driven AIs read them.
    basicsSlipStraight: g("basics_slip_straight", "slipChoice"),
    basicsRollHook: g("basics_roll_hook", "rollChoice"),
    basicsGuardUppercut: g("basics_guard_uppercut", "guardChoice"),
    basicsGuardBody: g("basics_elbows_body", "elbowChoice"),
    basicsHeadOffLine: g("basics_head_off_line", "moveAfter"),
    basicsReturnJab: g("basics_catch_return_jab", "returnJab"),
    basicsFireBack: g("basics_catch_hook_fire_back", "fireBack"),
    basicsSlipRip: g("basics_slip_and_rip", "ripChance"),
    basicsDoubleHook: g("basics_double_hook", "doubleChance"),
    basicsBodyHead: g("basics_body_then_head", "upstairsChance"),
    basicsInsideWork: g("basics_inside_work", "insideChance"),
    basicsLevelMix: g("basics_mix_levels", "mixChance"),
  };

  for (const k of Object.keys(out)) out[k] = clamp(out[k], 0, 1);
  // Body work is the one fundamental that reads better as a bias than a blend:
  // a seed that never goes downstairs should still hunt the head normally.
  out.bodyCondThreshold = lerp(CHAMP.bodyCondThreshold, out.bodyCondThreshold, 0.8);
  return out;
}
