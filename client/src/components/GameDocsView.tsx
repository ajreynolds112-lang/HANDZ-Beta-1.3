import { useState, useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  ArrowLeft, BookOpen, Gamepad2, Swords, Shield, Activity, Flame, Timer, Scale,
  Trophy, TrendingUp, BarChart3, Dumbbell, Coins, Shirt, Sparkles, Package,
  Skull, Brain, Users, GraduationCap, Code2, Search, Repeat,
} from "lucide-react";
import { FUNDAMENTALS } from "@/game/aiFundamentals";

/* ────────────────────────────────────────────────────────────────────────────
   Documentation content model.

   The docs are data, not JSX, so that sections stay searchable and the
   rendering stays uniform. Each section belongs to a group (the left-hand
   nav) and is a list of typed blocks.
   ──────────────────────────────────────────────────────────────────────── */

type Block =
  | { t: "p"; text: string }
  | { t: "h"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "dl"; rows: [string, string][] }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "note"; text: string }
  | { t: "code"; text: string };

type DocSection = {
  id: string;
  title: string;
  group: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  blurb: string;
  blocks: Block[];
};

const GROUPS = [
  "Overview",
  "In the Ring",
  "Career",
  "The Opponent",
  "Developer Reference",
] as const;

/** Tier headings for the fundamentals list, by id range. The list itself is read
 *  straight from the fundamentals definitions so the docs can never drift from
 *  what the AI actually uses. */
const FUNDAMENTAL_TIERS: [number, number, string][] = [
  [1, 8, "Tier 1 — Governing fight philosophy"],
  [9, 16, "Tier 2 — Fight intelligence and prediction"],
  [17, 24, "Tier 3 — Strategic control of the fight"],
  [25, 36, "Tier 4 — Position, distance and exchange structure"],
  [37, 49, "Tier 5 — Defensive and counterpunching architecture"],
  [50, 58, "Tier 6 — Deception and setups"],
  [59, 73, "Tier 7 — Offensive craft and specialist techniques"],
  [74, Infinity, "Basics — stance, the punches, slipping, rolling, blocking and fight scenarios"],
];

function fundamentalsBlocks(): Block[] {
  const blocks: Block[] = [
    {
      t: "p",
      text:
        `The AI's boxing is organised around ${FUNDAMENTALS.length} fundamentals — named boxing principles. Each one has a few dials the AI reads when it decides what to do, a test for when the situation has arisen, and a test for whether the principle was actually carried out. The training ring scores a fundamental as successes over opportunities and evolves the dials; the two tests never change.`,
    },
    {
      t: "note",
      text:
        "The dials are not a second brain. They fold back down onto the same neural parameters the rest of this screen edits, so an evolved boxer drives exactly the machinery a hand-tuned one does.",
    },
  ];
  for (const [lo, hi, heading] of FUNDAMENTAL_TIERS) {
    const rows = FUNDAMENTALS
      .filter(f => f.id >= lo && f.id <= hi)
      .map((f): [string, string] => [
        `${f.id}. ${f.label}`,
        `${f.meaning} When it applies: ${f.opportunity} Counts as done when: ${f.success} Dials: ${f.params.map(p => p.label).join("; ")}.`,
      ]);
    if (rows.length === 0) continue;
    const last = hi === Infinity ? Math.max(...FUNDAMENTALS.map(f => f.id)) : hi;
    blocks.push({ t: "h", text: `${heading} (${lo}–${last})` }, { t: "dl", rows });
  }
  return blocks;
}

const SECTIONS: DocSection[] = [
  /* ══════════════════════════════ OVERVIEW ══════════════════════════════ */
  {
    id: "premise",
    title: "What HANDZ Is",
    group: "Overview",
    icon: BookOpen,
    blurb: "The premise, and what makes this different from a fighting game.",
    blocks: [
      {
        t: "p",
        text:
          "HANDZ is a boxing simulator, not just a fighting game. There are no special moves, no meters that fill into a cinematic finisher, and no combo strings you buy from a menu. There are six punches, a guard, a duck, a slip, and your own sense of timing. Everything that happens in a bout comes out of those pieces and the order you use them in.",
      },
      {
        t: "p",
        text:
          "Every punch is one deliberate keypress. Nothing auto-chains. If you land four shots in a row it is because you pressed four keys with the right spacing, at the right distance, with enough air in your lungs to pay for them. That is the whole design: the game is difficult in the way boxing is difficult, which is that the correct action is usually obvious and still hard to do on time.",
      },
      { t: "h", text: "The world you drop into" },
      {
        t: "p",
        text:
          "Career mode generates a world of 704 ranked fighters. You start at the bottom — rank 705, rated 900 — and the belt is held at rank 1. Between you and it are seven hundred people who all have their own stats, styles, records, and levels, and who fight each other whether or not you are watching. Your rank moves because of results, not because of a story beat.",
      },
      { t: "h", text: "The part that matters most" },
      {
        t: "p",
        text:
          "Your opponent is not running a difficulty script. It is a simulated brain that watches what you do, records the sequences you repeat, and starts answering them before you finish throwing. If you jab-jab-cross three times in a round, the fourth one gets countered. The single most important habit in HANDZ is to stop being predictable — and the game is built specifically to punish you for it. The Opponent section of these docs explains exactly how that works.",
      },
      {
        t: "note",
        text:
          "Controls are keyboard-only. There is no mouse input during a bout — the mouse is used for menus and the gym minigames only.",
      },
    ],
  },
  {
    id: "first-fight",
    title: "Your First Fight",
    group: "Overview",
    icon: Gamepad2,
    blurb: "The shortest path from a blank save to knowing what you are doing.",
    blocks: [
      { t: "h", text: "Before the bell" },
      {
        t: "ul",
        items: [
          "Create a career fighter and pick a stance. Orthodox is the standard; Southpaw mirrors the punch keys (see Controls).",
          "You begin at rank 705 of 705 with a rating of 900. Everybody on the board near you is beatable.",
          "The Select Opponent board offers you seven fighters, all ranked near you. Pick one and set how many weeks of camp you want.",
        ],
      },
      { t: "h", text: "The five things to learn first" },
      {
        t: "dl",
        rows: [
          ["Distance is the whole game", "You cannot land what you cannot reach, and every punch has its own reach. Missing costs stamina and leaves you open. Use the arrow keys constantly."],
          ["Hold Space", "Guard is a hold, not a toggle. It reduces damage rather than erasing it, and it does not protect you if you punch while holding it."],
          ["Do not empty the tank", "Throwing more than a handful of punches inside one second makes each extra punch cost dramatically more stamina. Four to ten is your free allowance depending on your Stamina stat. Past that the cost multiplies."],
          ["Body shots exist", "Hold Shift while pressing a punch key. Bodywork cannot be slipped, and it drains the other fighter's gas."],
          ["Change your rhythm", "Anything you do three times, the opponent starts to expect. Break your own patterns on purpose."],
        ],
      },
      { t: "h", text: "The first ten seconds" },
      {
        t: "p",
        text:
          "Charged punches are locked for the first ten seconds of every round. Use that window to move, measure the distance, and see whether the opponent comes forward or waits. The AI spends the same window in its own probing phase, so what it shows you early is genuinely informative.",
      },
    ],
  },

  /* ═════════════════════════════ IN THE RING ════════════════════════════ */
  {
    id: "controls",
    title: "Controls",
    group: "In the Ring",
    icon: Gamepad2,
    blurb: "The complete key reference, including the Southpaw remap.",
    blocks: [
      { t: "h", text: "Movement" },
      {
        t: "table",
        head: ["Key", "Action"],
        rows: [
          ["Left / Right Arrow", "Move along the ring horizontally"],
          ["Up / Down Arrow", "Move in depth (toward or away from the camera)"],
          ["Arrows while slipping", "Aim the slip instead of moving — your feet are pinned"],
        ],
      },
      { t: "h", text: "Punches — Orthodox (default)" },
      {
        t: "table",
        head: ["Key", "Punch"],
        rows: [
          ["W", "Jab"],
          ["E", "Cross"],
          ["Q", "Left hook"],
          ["R", "Right hook"],
          ["S", "Left uppercut"],
          ["D", "Right uppercut"],
          ["Shift + any punch key", "Throw that punch to the body"],
        ],
      },
      {
        t: "note",
        text:
          "A punch goes out when you RELEASE its key, not when you press it. The exception is an armed feint (tap F first), which goes out on the press.",
      },
      { t: "h", text: "Punches — Southpaw" },
      {
        t: "p",
        text:
          "Keys always map to the same glove: W/Q/S throw with the left hand, E/R/D with the right. In southpaw your lead hand is the right one, so your jab is on E and your rear-hand cross is on W. You pick a starting stance in setup, but you are not locked into it: you can switch stance freely in the middle of a round.",
      },
      {
        t: "table",
        head: ["Key", "Punch"],
        rows: [
          ["W", "Cross (left hand)"],
          ["E", "Jab (right hand)"],
          ["Q", "Left hook"],
          ["R", "Right hook"],
          ["S", "Left uppercut"],
          ["D", "Right uppercut"],
        ],
      },
      { t: "h", text: "Switching stance mid-bout" },
      {
        t: "table",
        head: ["Key", "Action"],
        rows: [
          ["Right Shift", "Switch between Orthodox and Southpaw. Cannot be used while punching or perfect-blocking"],
        ],
      },
      {
        t: "p",
        text:
          "Switching is free and unlimited, and your choice is remembered for your next bout. It is not risk-free, though: every switch has roughly a coin-flip chance of scrambling where you are in your rhythm cycle, so you can come out of the switch off-beat. The odds shift with the level gap between you and your opponent. Switching stance also re-maps every punch key immediately, so the cost of using it is that your fingers have to follow.",
      },
      { t: "h", text: "Defense" },
      {
        t: "table",
        head: ["Key", "Action"],
        rows: [
          ["Space (hold)", "Full guard"],
          ["Space (double-tap within 0.3s)", "Auto-guard — holds the guard for you until cancelled"],
          ["Space (while auto-guarding)", "Cancel auto-guard"],
          ["Shift (hold)", "Duck — cannot be started while punching; restores your previous guard on release"],
          ["C (hold)", "Slip. Direction comes from the arrow key you are holding, or straight back if none"],
          ["V (hold)", "Perfect block"],
        ],
      },
      { t: "h", text: "Offense modifiers" },
      {
        t: "table",
        head: ["Key", "Action"],
        rows: [
          ["A", "Arm or disarm the charge. The next punch you throw is charged"],
          ["F, then punch key", "Arms a feint for 1 second: the next punch thrown in that window is feinted instead of thrown. It stays out while the punch key is held and snaps back when you let go. No cooldown — tap F again right away for another"],
          ["Punch key during a feint's snap-back", "The same arm turns the feint into the real punch; the other arm abandons it and starts its own"],
        ],
      },
      { t: "h", text: "System" },
      {
        t: "table",
        head: ["Key", "Action"],
        rows: [["Escape", "Pause / overlay"]],
      },
      {
        t: "note",
        text:
          "Fullscreen has no key. Rest the mouse in the very top-left corner of the screen for about three quarters of a second and a Fullscreen button fades in; click it and the whole game — menu, career hub, gym and ring — fills the screen with no browser around it. Hover the same corner again to leave. While fullscreen is on the game keeps Escape for the pause menu, so it no longer drops you out of fullscreen (in browsers that allow that; holding Escape down always exits).",
      },
    ],
  },
  {
    id: "punching",
    title: "Punching",
    group: "In the Ring",
    icon: Swords,
    blurb: "Six punches, body shots, charging, and feints — and what each actually costs.",
    blocks: [
      { t: "h", text: "The six punches" },
      {
        t: "p",
        text:
          "Jab, cross, left hook, right hook, left uppercut, right uppercut. Each has its own reach, speed, stamina cost, damage, and telegraph — the windup that the opponent can see and react to. There is no punch that is simply better than the others; they trade against each other.",
      },
      {
        t: "dl",
        rows: [
          ["Jab", "Fastest and cheapest, shortest telegraph, least damage. Faster still if you throw it standing still. Throwing it while advancing costs you 10% of its power."],
          ["Cross", "Your power straight. If you throw it while advancing it fires immediately rather than winding up — the single best punch for closing distance."],
          ["Hooks", "Short range, heavy. They wind up through a dropping phase, which means they are slower to arrive and more readable. Throwing one while moving makes it 30% slower again."],
          ["Uppercuts", "Close range, heavy, and the answer to a ducking opponent — the punch follows the head down instead of passing over it. Uppercuts cannot be feinted."],
        ],
      },
      { t: "h", text: "Head and body" },
      {
        t: "p",
        text:
          "Hold Shift while pressing a punch key to send it to the body. Body shots cannot be slipped — slipping moves the head off the line and does nothing about the ribs. They also do more to drain the opponent's stamina pool than head shots do. Head punches, by contrast, are the ones that get evaded, and the ones that build toward a stoppage.",
      },
      {
        t: "note",
        text:
          "If you throw while ducking, your targeting changes — a ducked punch reads as bodywork. This matters because the opponent's memory records head-versus-body as part of every punch it logs.",
      },
      { t: "h", text: "Charged punches" },
      {
        t: "ul",
        items: [
          "Tap A to arm the charge. The next punch you throw comes out charged; tap A again to disarm.",
          "Charging is locked for the first ten seconds of every round.",
          "It requires charge meter and costs noticeably more stamina — and consecutive charges cost more still.",
          "The telegraph is longer, so a charged punch is more readable. You are trading visibility for damage.",
          "With the right refinement, a fully charged punch of a matching family can punch straight through an ordinary guard. Perfect block remains the exception — it always stops it.",
        ],
      },
      {
        t: "note",
        text:
          "Arming a charge is visible to the opponent. Good AI reads the charge as a threat before the punch exists and pre-emptively drops into a perfect block, a duck, or steps out of range — because it knows an ordinary guard may not hold.",
      },
      { t: "h", text: "Feints" },
      {
        t: "p",
        text:
          "Tap F to arm a feint, the same way A arms a charge. The next punch you throw within one second is feinted instead of thrown; it comes out as soon as the punch key goes down. Launching it spends the arm with no cooldown, so you can tap F again immediately for the next one, and if no punch comes out inside the second the arm simply lapses. The feint stays out for as long as you hold the punch key (three seconds at most) and snaps back through a normal retraction when you let go. A feint costs 30% of the punch's stamina and throws nothing — its entire purpose is to make the other fighter commit their defense early. The arm comes out 30% slower than the real punch, which is the tell: the snap back is full speed. Uppercuts cannot be feinted, and a feint never spends an armed charge. Feinting and perfect block lock each other out; you cannot do both at once.",
      },
      {
        t: "p",
        text:
          "Feints are recorded in the opponent's memory as their own distinct action, which cuts both ways: a well-timed feint genuinely fools it, and a feint you overuse becomes just another pattern it reads.",
      },
    ],
  },
  {
    id: "drilled",
    title: "Drilled Actions",
    group: "In the Ring",
    icon: Repeat,
    blurb: "The combinations you groove in the gym, what they buy you, and what they cost to keep.",
    blocks: [
      { t: "h", text: "What a drilled action is" },
      {
        t: "p",
        text:
          "A drilled action is a three-action combination you have deliberately grooved. It is the player's half of the pattern game: the opponent keeps a tape of the combinations it catches you repeating, and this is the list of combinations you have chosen to repeat on purpose. Both systems read actions with exactly the same vocabulary, so the two can never disagree about what counts as the same combination.",
      },
      {
        t: "p",
        text:
          "A combination is identified by its three actions alone. What the opponent happened to be doing beforehand is not part of its identity — the same three actions are the same drilled action in any situation.",
      },
      { t: "h", text: "How one gets listed" },
      {
        t: "ul",
        items: [
          "A link is any of: a punch, a body shot, a feint, a duck, or arming a charge. A combination must END on a punch — one that finishes on anything else could never make contact, so it is thrown away rather than tracked.",
          "Land the same three-action combination twice in gym sparring and it is added to your list. Below two it is an unlisted candidate and does nothing.",
          "Sharpness is bought by LANDING the combination, and only in gym sparring. A career fight never sharpens anything.",
          "The buffs it earns apply everywhere, career bouts included. Drill it in the gym, cash it in on fight night.",
          "Links thrown from outside close working range do not count, and stepping out of range breaks the combination you were building.",
        ],
      },
      { t: "h", text: "The five tiers" },
      {
        t: "table",
        head: ["Tier", "Reps", "What it unlocks"],
        rows: [
          ["Rough", "under 20", "Listed, but no bonuses yet"],
          ["Good", "20", "The closing punch starts earning stun and crit"],
          ["Sharp", "100", "Nothing new switches on — the closing bonuses are simply becoming noticeable by here"],
          ["Effortless", "200", "The closing punch costs no stamina at all, and pauses the burst penalty for a second"],
          ["Mastered", "3000", "The closing punch hits for 1.5× damage and the opening punch for 1.2×. The opener is also 50% faster and +30% crit, and finishing the combination opens a one-second window with a 50% chance to slip the next punch outright"],
        ],
      },
      { t: "h", text: "What the closing punch earns" },
      {
        t: "ul",
        items: [
          "+0.05% stun chance per rep, up to +30% at 600 reps.",
          "+0.05% crit chance per rep, up to +30% at 600 reps.",
          "No damage. Repetition alone never makes a combination hit harder.",
        ],
      },
      {
        t: "note",
        text:
          "Damage is the one thing repetition does not buy. Stun and crit climb with every rep, but power is all-or-nothing: a combination hits exactly as hard as an undrilled one right up until it is Mastered, and then its closing punch does 1.5× and its opening punch 1.2×. The closer gets the bigger share because it is the punch the whole combination exists to set up. A punch that happens to be the mastered opener of one combination and the mastered closer of another takes the better of the two — 1.5× — rather than both. Mastery is the whole of drilled power, and 1.5× is its ceiling.",
      },
      { t: "h", text: "Upkeep: a combination you stop throwing gets expensive" },
      {
        t: "p",
        text:
          "Sharpness only ever climbs. Rehearsal is the half that rots. An unrehearsed combination pays a stamina surcharge on its closing punch, and the only way down the ladder is to keep working it. The ladder runs 3× → 2× → 1× → 0.5×, one rung per week in either direction.",
      },
      {
        t: "dl",
        rows: [
          ["Improve it", "Throw it twice in gym sparring inside one career week. That buys one rung down. Improving is gym work and gym work only."],
          ["Hold it", "Throw it once in any bout — a career fight counts. That keeps it exactly where it is."],
          ["Neglect it", "Three untouched weeks are forgiven, plus one extra week for every 50 lifetime reps. After that it climbs back a rung per week until it is at 3× again."],
        ],
      },
      {
        t: "ul",
        items: [
          "Upkeep counts THROWS, not landings. Rehearsal is the act of throwing it; a miss still rehearses.",
          "A rung is applied at the week rollover, so the week you put the work in is still billed at the old rate.",
          "Only listed combinations are ever surcharged. An improvised flurry is never charged extra.",
          "A combination at Effortless still costs nothing even while it carries a surcharge — the free closing punch beats the multiplier.",
          "A feint can be a link in a combination but can never close one, so a feint itself never pays the surcharge. A combination that happens to contain a feint is still rehearsed normally when its closing punch goes out.",
        ],
      },
      {
        t: "note",
        text:
          "So a real fight keeps a combination from rusting but can never sharpen it or make it cheaper. That is the same gym-versus-fight-night split the buffs run on, pointed the other way. The Drilled Action Progress panel in the career hub shows every combination's tier, its current stamina multiplier, and when it was last practised.",
      },
    ],
  },
  {
    id: "defense",
    title: "Defense",
    group: "In the Ring",
    icon: Shield,
    blurb: "Guard, perfect block, duck, slip — and precisely what beats what.",
    blocks: [
      { t: "h", text: "Ordinary guard (Space)" },
      {
        t: "ul",
        items: [
          "Guard reduces incoming damage; it does not erase it. The reduction scales with your level and is capped at 95%.",
          "Punching while you hold guard weakens the reduction substantially. You cannot attack from behind a full guard for free.",
          "Guard is directional. A standing guard turns away punches from a standing attacker, and a ducking guard turns away punches from a ducking attacker. Mismatch it and you fall back to an ordinary, weaker block.",
          "Double-tap Space for auto-guard, which holds the guard without you keeping the key down. Tap Space again to drop it.",
          "Auto-guard is the answer to a charge. While it is up, it soaks the extra damage a charged punch carries, scaled by your Defense — nothing at all at Defense 0, and 85% of the surplus at the 1000 cap. It only eats the surplus, never the punch itself, so a maxed-Defense fighter behind auto-guard takes roughly a normal shot instead of a charged one.",
        ],
      },
      {
        t: "note",
        text:
          "Holding auto-guard and a duck together for more than 2.5 seconds starts costing you 2% of your maximum stamina every half second. Turtling is possible, but the game charges you rent for it.",
      },
      { t: "h", text: "Perfect block (V)" },
      {
        t: "p",
        text:
          "Perfect block is a timed window rather than a hold-forever state. It ramps up, holds for a duration scaled by your Defense, then goes on cooldown. Inside the window it negates the damage entirely — including a charged punch that would bypass an ordinary guard — and it leaves you with no recovery delay, so you can punch straight out of it. That last property is what makes it the foundation of counter-punching.",
      },
      { t: "h", text: "Duck (Shift)" },
      {
        t: "ul",
        items: [
          "Ducking takes your head off the line of head punches entirely.",
          "You are completely immune to rhythm vulnerability while ducking.",
          "Uppercuts beat ducks. The punch follows the head down. This is the single most reliable punishment for someone who ducks too often, and the AI knows it.",
          "You cannot start a duck while a punch is going out.",
          "A stun does not stop you ducking. Almost everything else a stun touches is slowed or disabled, but the duck stays available — it is the one answer you always have while hurt.",
        ],
      },
      { t: "h", text: "Slip (C)" },
      {
        t: "ul",
        items: [
          "Hold C to slip; the held arrow key aims it, and with no arrow held you slip straight back.",
          "Only the completed slip evades. There is a 0.15 second window once you arrive — get hit during the entry, or after the window closes, and the punch lands normally.",
          "You can hold a slip for at most 2 seconds.",
          "Taking a head shot locks slipping out for 0.75 seconds.",
          "Re-aiming mid-slip travels back through center and is not evasive until it arrives at the new position.",
          "Slips cost stamina, and consecutive slips cost progressively more.",
          "A punch thrown out of a slip lands at 1.2× power.",
        ],
      },
      { t: "h", text: "What beats what" },
      {
        t: "table",
        head: ["Against", "Works", "Fails"],
        rows: [
          ["Head straight / hook", "Duck, slip, perfect block, step out, counter", "—"],
          ["Uppercut", "Perfect block, slip, step out, counter", "Duck — the punch follows you down"],
          ["Body shot", "Low perfect block, guard, step out, counter", "Slip — your head was never the target"],
          ["Feint", "Hold position, keep the guard you have", "Committing to any read at all"],
          ["Armed charge", "Perfect block, duck, step out", "Ordinary guard — a matching charge can go through it"],
        ],
      },
      { t: "h", text: "Passive defense" },
      {
        t: "p",
        text:
          "Your Defense stat also produces defensive events you did not input: an automatic block when your guard is already up, or an outright dodge when it is down. These are separate from evasion you performed yourself, and the game distinguishes between the three ways a punch can fail to land — a whiff (it could never have reached), an evasion (you ducked or your Defense saved you), and a dodge.",
      },
    ],
  },
  {
    id: "rhythm",
    title: "Rhythm & Sway",
    group: "In the Ring",
    icon: Activity,
    blurb: "The timing layer that sits on top of everything else.",
    blocks: [
      {
        t: "p",
        text:
          "Rhythm is HANDZ's timing minigame, and it is optional in the sense that you can fight at rhythm level 0 and ignore it entirely. Turn it up and you gain access to real damage and speed bonuses, at the cost of a moving window you have to hit.",
      },
      { t: "h", text: "Rhythm level" },
      {
        t: "ul",
        items: [
          "X raises your rhythm level, Z lowers it. The range is 0 to 4.",
          "A marker moves continuously at a constant speed — not a sine wave, so the edges are worth exactly as much real time as they look like they are.",
          "Tab + Left/Right changes how fast the marker travels.",
        ],
      },
      { t: "h", text: "Snap zones" },
      {
        t: "dl",
        rows: [
          ["Early / late zones", "Throwing here shortens your punch's telegraph — the punch comes out with less warning."],
          ["Past 95%", "The telegraph can be skipped entirely. This is the fastest a punch can possibly arrive."],
          ["The green middle", "This is the vulnerability zone. Throwing into it can hold you in your windup, and it pauses a perfect block's timer rather than letting it run out. Ducking makes you completely immune to it."],
        ],
      },
      { t: "h", text: "Sway" },
      {
        t: "p",
        text:
          "Sway is your weight shifting between the front and back foot, cycled with Tab + C. It is a separate axis from rhythm level.",
      },
      {
        t: "table",
        head: ["Zone", "Effect"],
        rows: [
          ["Power (90%+ sway)", "1.5× damage, and half the telegraph"],
          ["Neutral", "No modifier"],
          ["Off-balance (leaving foot)", "0.85× damage, and 1.5× the telegraph"],
        ],
      },
      {
        t: "note",
        text:
          "The opponent learns your sway timing. It samples when you tend to throw relative to your own sway and starts timing its answers to it — so a metronomic rhythm is a liability at higher difficulties even though it feels powerful.",
      },
    ],
  },
  {
    id: "stamina",
    title: "Stamina & Conditioning",
    group: "In the Ring",
    icon: Flame,
    blurb: "The resource that decides late rounds, and the burst penalty that ends careers.",
    blocks: [
      { t: "h", text: "The bar and the pool" },
      {
        t: "p",
        text:
          "There are two numbers. Your current stamina is the bar — it drains as you work and regenerates when you do not. Your stamina pool is the ceiling that bar can refill to, and over the course of a bout that ceiling comes down. It never goes back up mid-fight.",
      },
      { t: "h", text: "The burst penalty" },
      {
        t: "p",
        text:
          "This is the most important mechanic in the game and the one new players lose to most often. Punches are counted inside a rolling one-second window. Depending on your raw Stamina stat you get between four and ten punches free inside that window. Every punch past the allowance multiplies its own stamina cost by 1.5 to the power of how far over you are.",
      },
      {
        t: "table",
        head: ["Punches over the allowance", "Cost multiplier on that punch"],
        rows: [
          ["1 over", "1.5×"],
          ["2 over", "2.25×"],
          ["3 over", "3.4×"],
          ["4 over", "5.1×"],
          ["5 over", "7.6×"],
        ],
      },
      {
        t: "note",
        text:
          "An unbroken assault can empty a full bar in roughly one second. This is not a bug and it is not a punishment for aggression — it is a punishment for aggression without spacing. The AI obeys exactly the same rule and will hold its punches to wait out a burst window.",
      },
      { t: "h", text: "Other drains" },
      {
        t: "ul",
        items: [
          "Every punch costs its own configured stamina. Feints cost 30% of the real punch.",
          "Charged punches multiply the cost, and consecutive charges add more on top.",
          "Slips cost at least one point, and consecutive slips escalate.",
          "Auto-guard plus duck held past 2.5 seconds costs 2% of max stamina per half second.",
          "A punch is simply refused if your current stamina is below half of what it would cost.",
          "Stamina cannot fall below 1 — you never hit literal zero.",
        ],
      },
      { t: "h", text: "Punch endurance" },
      {
        t: "p",
        text:
          "Every so many real punches you throw, your stamina ceiling for that bout permanently drops. Feints do not count toward it. This is the mechanic that makes a twelve-round fight feel different from a three-round one: the fighter who threw 600 punches in the first half has a visibly smaller tank in the second, regardless of how much they have rested.",
      },
      { t: "h", text: "Recovery" },
      {
        t: "p",
        text:
          "Stamina regenerates during the bout, but regeneration pauses after you take damage. Your Stamina stat governs both the size of the pool and the speed of the refill. Between rounds you get a recovery step at the bell.",
      },
    ],
  },
  {
    id: "damage",
    title: "Damage, Knockdowns & Endings",
    group: "In the Ring",
    icon: Skull,
    blurb: "Crits, stuns, the ten-count, and every way a bout can finish.",
    blocks: [
      { t: "h", text: "How a punch resolves" },
      {
        t: "p",
        text:
          "A thrown punch is checked in order: is the target in range, does the posture and target line up, was it evaded, was it blocked. Only then is damage applied. The result carries flags for whether it was a critical hit, whether it stunned, whether it hit head or body, whether it was perfect-blocked, and whether it was dodged.",
      },
      { t: "h", text: "Crits and stuns" },
      {
        t: "ul",
        items: [
          "Critical hits multiply damage. Jab, hook, and uppercut crits can each be raised separately through refinements.",
          "A stun restricts the victim's input, weakens their blocking, and slows their punches. There is no single stun timer — it is a family of overlapping slow-down windows governed by Focus and the Iron Chin refinement.",
          "Ducking is the one thing a stun does not take away. Your guard is weakened and your punches are slowed, but you can still drop under the follow-up — so being stunned is survivable if you stop trading and start moving your head.",
        ],
      },
      { t: "h", text: "The Big Shot" },
      {
        t: "p",
        text:
          "A Big Shot is a charged punch whose key was held for at least half a second before release, landing clean as a critical hit that also stuns. There is no chance roll: hit all four and it's an automatic knockdown. Big Shots and Rocker Shots go straight through a perfect block, but can still be dodged. AI opponents don't need to hold: any charged punch of theirs can be a Big Shot or Rocker Shot. A high-level mouthguard can shrug one off, with the chance rising from around 20% at level 1 to roughly 55% by level 150.",
      },
      { t: "h", text: "The Rocker Shot" },
      {
        t: "p",
        text:
          "A Rocker Shot is a charged punch held for half a second that crits or stuns. If it lands, even through a normal or perfect block, it takes 35% of the opponent's max stamina. The screen shows \"HE'S HURT\" and the hurt fighter can't slip or duck for 5 seconds. Punch Rolling gives a chance to roll with it and lose nothing.",
      },
      { t: "h", text: "Knockdowns and the count" },
      {
        t: "ul",
        items: [
          "A knockdown starts the referee's count, which runs to 10 and no further. Reaching 10 is always a knockout — there is no getting up at the count of ten.",
          "You get up by mashing. The required input rises with each knockdown: 25 after the first, 35 after the second, 50 for every one after that.",
          "The count has a 10 second timer behind it.",
          "Nothing else ticks while a fighter is down — timers, stamina regeneration, and rhythm are all suspended for the duration of the count.",
        ],
      },
      { t: "h", text: "How a bout ends" },
      {
        t: "dl",
        rows: [
          ["KO", "A fighter is counted out."],
          ["TKO / referee stoppage", "The referee steps in. The stoppage logic reads the damage actually done to the health bar, not the judges' scorecards, so a fighter who is winning on points can still be pulled out."],
          ["Decision", "The final bell arrives with both fighters standing and the judges' cards decide it."],
        ],
      },
    ],
  },
  {
    id: "rounds",
    title: "Rounds & the Judges",
    group: "In the Ring",
    icon: Timer,
    blurb: "Round structure and how a decision is actually scored.",
    blocks: [
      { t: "h", text: "Rounds" },
      {
        t: "p",
        text:
          "The engine's standard round is 120 seconds; career bouts pass in their own configured length, chosen in minutes when the fight is set up. When the timer expires the round is scored and, if rounds remain, the next one starts after a recovery and countdown step.",
      },
      { t: "h", text: "The scorecards" },
      {
        t: "ul",
        items: [
          "Three judges score every round independently, and each judge accumulates their own running total across the bout.",
          "The winner is whoever wins more judges' cumulative totals. Split judges with no majority is a draw.",
          "Judges weigh clean hits landed, damage dealt, aggression, ring control, and defense — each judge with their own weighting, so they genuinely disagree.",
          "Knockdowns are recorded separately and weigh heavily on the round they happen in.",
        ],
      },
      {
        t: "note",
        text:
          "Judges score damage dealt, which is not the same number as the damage that moved the health bar — the bar has a floor the scorecards ignore. Do not expect the scorecards and the visible health bars to agree.",
      },
    ],
  },

  /* ═══════════════════════════════ CAREER ═══════════════════════════════ */
  {
    id: "career-loop",
    title: "The Career Loop",
    group: "Career",
    icon: Trophy,
    blurb: "Weeks, camps, the opponent board, and how a career actually progresses.",
    blocks: [
      { t: "h", text: "The week" },
      {
        t: "p",
        text:
          "Career mode runs on a weekly calendar. Each week you either train, take a fight, or let the week pass. The rest of the world's fighters fight each other in the background and the rankings move whether or not you did anything.",
      },
      { t: "h", text: "The Select Opponent board" },
      {
        t: "ul",
        items: [
          "You are offered 7 fighters to choose from, rising to 15 once the expanded board unlocks at 10 career wins.",
          "The board will not offer anyone more than 10 places above you. It reaches 5 places below you, widening in steps of 5 if it cannot fill the board.",
          "Below level 300 the board also prefers opponents within 15 levels of you, and hard-caps at 30 levels above.",
          "Rerolling reaches 20 ranks above you normally, 50 on the expanded board.",
          "Each card shows the fighter, their rank, their stats, and the Force you would earn for the win.",
        ],
      },
      {
        t: "note",
        text:
          "Between one and three of an opponent's five stats are hidden until you scout them. Which ones are hidden is fixed per fighter, not random per viewing.",
      },
      { t: "h", text: "Camps" },
      {
        t: "p",
        text:
          "Booking a fight opens a camp of 1 to 8 weeks, which you choose. You train during camp; the fight week itself is locked to the bout. A title camp is a full 8-week schedule. Your first two career fights have completely open availability.",
      },
      { t: "h", text: "Save slots" },
      {
        t: "p",
        text:
          "Careers live in save slots you can create, delete, export to a file, and import back. An export sweeps everything belonging to that career, and an import is all-or-nothing — it either restores the whole thing or it does not touch your data.",
      },
    ],
  },
  {
    id: "rankings",
    title: "Rankings & the Belt",
    group: "Career",
    icon: TrendingUp,
    blurb: "The rating maths, the champion, and how the title actually changes hands.",
    blocks: [
      { t: "h", text: "Rating and rank" },
      {
        t: "p",
        text:
          "Every fighter carries an ELO-style rating. Rank is not stored — it is the re-sorted order of everyone's rating, with smoothing so positions do not jitter wildly week to week. You start at 900, which puts you at rank 705 of 705.",
      },
      {
        t: "table",
        head: ["Band", "Rating range"],
        rows: [
          ["Champion", "2400 – 2600"],
          ["Top 10", "2200 – 2390"],
          ["Top 50", "2000 – 2190"],
          ["Top 100", "1800 – 1990"],
          ["Rank 651+", "910 – 1040"],
        ],
      },
      { t: "h", text: "How much a result moves you" },
      {
        t: "p",
        text:
          "Expected score is standard ELO — one over one plus ten to the power of the rating gap over four hundred. What varies is K, the size of the swing:",
      },
      {
        t: "table",
        head: ["Situation", "K"],
        rows: [
          ["Your first fight", "45"],
          ["Ranked 15 or better", "20"],
          ["Ranked 16 – 50", "24"],
          ["Ranked 51 – 100", "28"],
          ["Ranked 101+", "32"],
          ["A title fight", "18"],
        ],
      },
      {
        t: "table",
        head: ["Modifier", "Multiplier"],
        rows: [
          ["Difficulty: Journeyman / Contender / Elite / Champion", "0.75 / 1.0 / 1.25 / 1.5"],
          ["Win: close / dominant / KO", "1.0 / 1.25 / 1.4"],
          ["Loss: close / dominant / KO", "0.9 / 1.1 / 1.25"],
          ["Rank gap ≤10 / ≤25 / ≤50 / beyond", "1.05 / 1.15 / 1.3 / 1.5"],
        ],
      },
      {
        t: "p",
        text:
          "Upset bonuses apply only while you are outside the top 100: +7.5% per rank beyond 3 that you punched above, and +10% per level beyond 4 when the opponent starts at least a rank above you. Both cap at +400%.",
      },
      { t: "h", text: "The belt" },
      {
        t: "p",
        text:
          "Rank 1 is not simply whoever has the highest rating. The belt is sticky: it stays with its current holder and only changes hands when someone beats that holder. You can out-rate the champion on paper and still not be champion.",
      },
      { t: "h", text: "Reaching the champion" },
      {
        t: "ul",
        items: [
          "The champion sits pinned at rank 1 for as long as he is unbeaten, and he is kept out of the ordinary matchmaking pool.",
          "His card does not appear on your board at all until your rank has closed to within 10 of his.",
          "Once his card is visible, it stays locked and reads as unavailable until you have 75 career wins. No requirement is stated on the card.",
          "Both conditions are required. A win count alone will not surface him, so the belt cannot be taken from deep down the ladder.",
          "Only official career bouts count toward those wins — sparring, Nightmare, Doghouse and quick fights do not.",
          "Once you have beaten him, access never closes again, and he resurfaces as a rematch every 25 completed bouts.",
        ],
      },
    ],
  },
  {
    id: "stats",
    title: "Your Five Stats",
    group: "Career",
    icon: BarChart3,
    blurb: "What Power, Speed, Defense, Stamina and Focus actually change.",
    blocks: [
      {
        t: "dl",
        rows: [
          ["Power", "Damage multiplier on everything you throw."],
          ["Speed", "Punch speed and movement speed. This is the stat with the most visible effect on how the game feels — it shortens telegraphs and raises your punch rate. It is deliberately soft-capped, so late investment returns less."],
          ["Defense", "Damage reduction behind a guard, the length of your perfect-block hold, and the chance of automatic blocks and dodges."],
          ["Stamina", "Both the size of your stamina pool and how fast it regenerates. It also sets your free burst allowance — the number of punches you can throw inside one second before the multiplier starts."],
          ["Focus", "Governs the stun window. High Focus means you spend less time slowed after being hurt."],
        ],
      },
      {
        t: "note",
        text:
          "Power, Defense, Focus and the stamina pool are scaled against a cap of 1000. Speed and stamina regeneration deliberately keep an older, tighter scale — Speed soft-caps around 220 and regeneration caps at 250 — because rescaling them to 1000 would have wrecked the feel of the fight.",
      },
      { t: "h", text: "How power bonuses stack" },
      {
        t: "p",
        text:
          "Every percentage that raises your power adds to the same pool, and the pool is applied to your base power once. Your base is what your level and your spent stat points are worth; the Pressure Fighter refinement, the Straight, Hook and Uppercut Power refinements, Fight Gloves, item boosts like Gummy Candy and the Veteran's Hand Wraps, and the damage from a mastered Drilled Action all pay into it.",
      },
      {
        t: "p",
        text:
          "They are added, never multiplied together. A +50% refinement alongside a +50% glove is +100% on your base, not +125% — so a stat point is worth exactly as much whether you own one power bonus or ten, and stacking them cannot run away with the fight. Only the punch-family bonus matching the punch you actually threw counts toward the total.",
      },
      {
        t: "note",
        text:
          "Situational multipliers are separate and still multiply: counter hits, charged punches, stance and distance bonuses, rhythm timing, critical hits and blocking all scale the particular punch you threw rather than how hard you hit in general.",
      },
      { t: "h", text: "Stat points and the cap" },
      {
        t: "p",
        text:
          "Stats are raised with stat points, earned from fights and from training. When a stat is at its cap, further points are not lost — they convert into Force instead. See the economy section for the rates.",
      },
    ],
  },
  {
    id: "gym",
    title: "The Gym",
    group: "Career",
    icon: Dumbbell,
    blurb: "Training, minigames, and what a week of work is worth.",
    blocks: [
      {
        t: "p",
        text:
          "The gym is where non-fight weeks go. It holds your training activities, your equipment, your refinements, and the sparring modes.",
      },
      { t: "h", text: "Training" },
      {
        t: "ul",
        items: [
          "Heavy bag — a timed minigame; performance converts into stat points.",
          "Weight lifting — a separate minigame with its own rhythm and its own payout.",
          "Sparring — a full practice bout against a chosen opponent, with no effect on your record. It is also the only place drilled actions are sharpened or made cheaper.",
          "Sweep — resolves a training session automatically instead of playing the minigame, for when you do not want to play it out.",
        ],
      },
      {
        t: "note",
        text:
          "Training boosts are consumed when the earned stat points are handed out, not when the workout finishes. A swept session burns them exactly the same as a played one.",
      },
      { t: "h", text: "Passive income" },
      {
        t: "p",
        text: "The gym generates Force passively alongside what you earn in the ring.",
      },
    ],
  },
  {
    id: "economy",
    title: "Force, Diamonds & Shards",
    group: "Career",
    icon: Coins,
    blurb: "Three currencies, what earns them, and what they buy.",
    blocks: [
      {
        t: "dl",
        rows: [
          ["Force", "The main currency. Earned from fights and from passive gym income. Buys stat points, equipment levels, refinement tracks and sparring sessions."],
          ["Diamonds", "Premium currency. Every career win pays one. Every equipment level costs one on top of the Force price. Force can be converted into diamonds, but only after the Credit Limit unlock."],
          ["Shards", "Spent on paid training and the paid sparring modes."],
        ],
      },
      { t: "h", text: "Buying stat points" },
      {
        t: "p",
        text:
          "The first stat point costs 10,000 Force and every purchase after that is 5% more expensive than the last. The price is driven by how many you have bought in total, so it is a permanent escalating curve rather than a per-stat one.",
      },
      { t: "h", text: "Overflow" },
      {
        t: "table",
        head: ["Source of the capped point", "Force returned"],
        rows: [
          ["An official bout", "100,000 per point"],
          ["Training", "10,000 per point"],
        ],
      },
    ],
  },
  {
    id: "equipment",
    title: "Equipment",
    group: "Career",
    icon: Shirt,
    blurb: "Five slots, what each does, and the level curve.",
    blocks: [
      {
        t: "table",
        head: ["Slot", "Unlocks at", "Effect per level"],
        rows: [
          ["Gloves", "1 win", "+0.25% punch power, +0.1% auto-guard duration"],
          ["Shoes", "3 wins", "+0.1% movement speed"],
          ["Trunks", "4 wins", "+10 starting max stamina, capped at +50% of the tank your level, stats and refinements already give you"],
          ["Mouthguard", "5 wins", "+0.009% max-stamina-loss shrug, +0.05% crit damage resistance, plus a Big Shot shrug rising from 20% at level 1 to 55% at level 150"],
          ["Wraps", "6 wins", "+0.01% block and perfect-block hold, +0.05% crit and stun"],
        ],
      },
      { t: "h", text: "Levelling" },
      {
        t: "p",
        text:
          "Each level costs Force, compounding at 2.35% per level, plus one diamond. The maximum is level 1000. Equipment milestones drop chests every 10 levels, and the tier of the chest rises with the level band — journeyman through 100, contender through 200, elite through 300, champion through 400, undisputed through 500, and goat beyond that.",
      },
    ],
  },
  {
    id: "refinements",
    title: "Refinements",
    group: "Career",
    icon: Sparkles,
    blurb: "Seventeen skill tracks, five active slots, and a hard choice.",
    blocks: [
      {
        t: "p",
        text:
          "Refinements are your skill tree. There are seventeen tracks, each levelling from 1 to 100 with its effect interpolating linearly across that range. You can have at most five active at once — that limit is the entire design of the system. Levelling a track you are not running does nothing in the ring.",
      },
      {
        t: "table",
        head: ["Refinement", "What it does"],
        rows: [
          ["Pressure Fighter", "Damage and cut generation while coming forward"],
          ["Precision Striker", "Crit chance, stamina efficiency, dodge and range"],
          ["Jab Power", "Jab damage and crit"],
          ["Hook Power", "Hook damage and crit"],
          ["Uppercut Power", "Uppercut damage and crit"],
          ["Bruiser", "Raw damage"],
          ["KO Artist", "Knockdown and finishing power"],
          ["Iron Chin", "Reduces stun duration, incoming damage, and recovery delay"],
          ["Slippery", "Slip speed — the single stat that governs how fast you get your head off the line"],
          ["Guard Master", "Block strength"],
          ["Duck Recovery", "How fast you come back up out of a duck"],
          ["Punch Rolling", "Damage shed by rolling with a shot"],
          ["Fast Twitch", "Reaction and punch initiation"],
          ["Heart", "Stamina under pressure"],
          ["Chin Hitter", "Damage to the head"],
          ["Technician", "Accuracy, free whiffs, and the ability to cancel a linger feint into a real punch"],
          ["Life Drain", "Converts damage dealt into stamina"],
        ],
      },
      {
        t: "note",
        text:
          "Slippery is the only thing in the entire game that changes slip speed — no item and no equipment touches it.",
      },
    ],
  },
  {
    id: "items",
    title: "Items & Crates",
    group: "Career",
    icon: Package,
    blurb: "Six crate tiers, rarities, synergy families, and keepsakes.",
    blocks: [
      { t: "h", text: "Crates" },
      {
        t: "p",
        text:
          "Crates come in six tiers — journeyman, contender, elite, champion, undisputed and goat. The tier you get from a fight is set by the rank of the opponent you beat. Crates also arrive from equipment milestones every 10 levels and from the daily reward.",
      },
      { t: "h", text: "Daily rewards" },
      {
        t: "table",
        head: ["Your rank", "Daily chest"],
        rows: [
          ["1", "Goat"],
          ["2 – 9", "Undisputed"],
          ["10 – 49", "Champion"],
          ["50 – 199", "Elite"],
          ["200 – 499", "Contender"],
          ["500+", "Journeyman"],
        ],
      },
      {
        t: "note",
        text:
          "The daily reward keys off your local calendar date and can only ever move forward, so you cannot farm it by winding your system clock back.",
      },
      { t: "h", text: "Items" },
      {
        t: "ul",
        items: [
          "Items are one-shot boosts armed before a bout. They are applied to the fight after it has been set up, and they take effect for both career bouts and the sparring-scope modes.",
          "Items belong to synergy families — a ladder of tiers sharing a base name. Owning several from one family stacks their synergy, and the family link is what governs that ceiling.",
          "An armed boost is only consumed by a bout that actually reaches a conclusion. Walk out of a fight and it comes back.",
          "Keepsakes are one-per-career items. They are never included in an ordinary crate draw unless the draw explicitly asks for them.",
          "Crate draws respect your inventory limits, and stop offering refinement tomes once you are maxed.",
        ],
      },
      {
        t: "note",
        text:
          "The opponent gets item kits too. An AI opponent's items reach the fight through the same path yours do.",
      },
    ],
  },
  {
    id: "sparring",
    title: "Sparring, Nightmare & Doghouse",
    group: "Career",
    icon: Skull,
    blurb: "Practice, and the two paid modes designed to hurt.",
    blocks: [
      { t: "h", text: "Sparring" },
      {
        t: "p",
        text:
          "Ordinary sparring is free and lives in the gym. It is a full bout against a chosen opponent that does not touch your record, your rating, or your rank.",
      },
      {
        t: "p",
        text:
          "Slip training: every slip you put in yourself that makes a punch miss from within 80 pixels is counted. Win the session and each one adds to your auto slip chance permanently: +0.001% at Journeyman, +0.002% at Contender, +0.003% at Elite, +0.004% at Champion. In the Doghouse each counts +0.001%, paid if you put at least one opponent away. Auto slips themselves don't count. Auto slip chance from every source combined is capped at 50%, and an auto slip can now fire while you're mid-punch without stopping the punch.",
      },
      {
        t: "p",
        text:
          "Defensive Mastery (in the gym, under Punch Endurance) is a 0-100% bar: 35% from your best Defense refinement toward level 100, 35% from your Defense stat toward 1000, and 30% from your auto slip chance toward 45%. Each part fills in proportion. Perfect blocks add on top: +0.0005% each in Journeyman sparring, 0.001% in Contender, 0.0015% in Elite, 0.002% in Champion (win or lose), and 0.004% in the Doghouse — there, blocks are paid each time an opponent goes down, so blocks against the last one standing don't count. Every 10% reached pays diamonds once — 30 at 10% rising by 30 each step to 300 at 100% (1,650 in all).",
      },
      { t: "h", text: "Nightmare" },
      {
        t: "table",
        head: ["", ""],
        rows: [
          ["Unlock", "10 wins and 10,000,000 Force, paid once"],
          ["Per session", "5,000 Force and 5,000 shards"],
        ],
      },
      {
        t: "p",
        text:
          "Nightmare is an endless gauntlet against champion-difficulty opposition. Activating the mode rescales the opening enemy's stamina pool, and each rung you clear replaces the fighter in front of you.",
      },
      { t: "h", text: "Doghouse" },
      {
        t: "table",
        head: ["", ""],
        rows: [
          ["Unlock", "20 wins and 20,000,000 Force, paid once"],
          ["Per session", "10,000 Force and 10,000 shards"],
        ],
      },
      {
        t: "p",
        text:
          "The Doghouse Round is a single brutal round with its own knockdown and knockout rules. Both fighters walk in with 1.5x (you) and about 1.75x (the opponent) their normal stamina. Each opponent put away pays 5 diamonds on top of the XP and chests. Sessions in both modes are unlimited as long as you can pay for them, and both are grandfathered for existing careers already past the win thresholds.",
      },
      {
        t: "note",
        text:
          "Neither mode advances your career record, and neither teaches the opponent anything permanent — the AI's career-long memory of you is only written by official career bouts.",
      },
    ],
  },

  /* ════════════════════════════ THE OPPONENT ════════════════════════════ */
  {
    id: "ai-thinking",
    title: "How the AI Thinks",
    group: "The Opponent",
    icon: Brain,
    blurb: "The decision loop, in plain language. This is the deep end of the game.",
    blocks: [
      {
        t: "p",
        text:
          "The opponent is not picking randomly from a list of moves, and it is not cheating. Its damage, reach, and hit chance are exactly yours. What changes between difficulties is the quality and speed of its decisions, and how much of you it remembers.",
      },
      { t: "h", text: "Eight states of mind" },
      {
        t: "p",
        text:
          "At any moment the AI is in one of eight tactical phases, and it moves between them based on what the fight is doing:",
      },
      {
        t: "dl",
        rows: [
          ["Probe", "Feeling you out. Low commitment, lots of looking."],
          ["Download", "Actively gathering data on you. Heavy feint usage — it is asking questions to see your answers."],
          ["Pressure", "Walking into your inside range and committing to combinations."],
          ["Whiff Punish", "You missed; it is taking the opening."],
          ["Counter", "Waiting to answer rather than lead."],
          ["Body Hunt", "Campaigning on your ribs to take your legs away later."],
          ["Finish", "You are hurt. Feints get suppressed — it stops asking questions and starts throwing."],
          ["Panic", "It is hurt. Survival behavior takes over."],
        ],
      },
      { t: "h", text: "Reading, not reacting" },
      {
        t: "p",
        text:
          "The AI does not get a free look at your inputs every frame. When you commit to a punch, it makes a single read attempt against a difficulty-based chance. If the read fails, it does not get another one for that punch. Land clean shots on it and that read chance erodes — a fighter you are hurting genuinely stops seeing your punches coming, and recovers after about a second and a half.",
      },
      {
        t: "p",
        text:
          "When a read succeeds it picks an answer weighted between slipping, perfect blocking, and stepping out. If one of those is not physically available the weight is redistributed rather than wasted. A punch already committed inside a combination cannot be interrupted by an ordinary block. And if the AI is caught in the green rhythm vulnerability zone, it does not get to read at all.",
      },
      { t: "h", text: "Answering a punch that does not exist yet" },
      {
        t: "p",
        text:
          "The most sophisticated thing the AI does is anticipate. When you arm a charge, that arming is visible — and the AI answers it 1 to 7 seconds before the punch actually exists, holding a duck or a guard open while it waits and releasing when you retract or the window expires. It specifically avoids an ordinary guard here, because it knows a charged punch of a matching family can go straight through one.",
      },
      {
        t: "p",
        text:
          "It also learns the shape of your approach. It samples the distance between you over time and watches for a 'close then fire' habit. If your historical rate of firing after closing hits 50% or higher, it starts arming a perfect block as you walk in — before you have thrown anything. Each success raises that chance by 1 to 3%, each miss lowers it by 1%, and its hold timing adapts afterward.",
      },
      { t: "h", text: "Gas management" },
      {
        t: "p",
        text:
          "The AI pays the same burst penalty you do and it knows it. It tolerates going 1 punch over the allowance at the top tiers and 2 at the lower ones, then refuses all real throws until the burst window lapses — while still allowing itself to feint. It cancels queued punches while gassed and resumes on the exact tick the penalty expires. At low stamina it drops its commitment, enters survival, and at the deepest point may stop attacking entirely.",
      },
      { t: "h", text: "Ring generalship" },
      {
        t: "p",
        text:
          "Movement is its own decision layer. The AI maintains an ideal engaging distance and an ideal reset distance from its style, cycles in and out rather than sitting at one range, switches which side it circles to, cuts the ring off, and detects when it is on the ropes or stalled in a corner. In pressure mode it walks into a tight inside band and commits, with one or two follow-ups depending on difficulty. Its combo chase can track you as you move rather than punching where you were.",
      },
      { t: "h", text: "Why it feels human" },
      {
        t: "ul",
        items: [
          "Its personality values are randomized within bounded ranges, so it is probabilistic rather than scripted. Two fighters of the same style genuinely differ.",
          "It hesitates. It waits for the center of its sway, suppresses its own offense after whiffing repeatedly, and sometimes declines an opening that looked clean.",
          "Its feints are real baits — after one it watches whether you changed your defense, and follows up at a rate from 30% at the lowest tier to 90% at the highest.",
          "Its timing is learned and therefore imperfect. Slipped head shots adjust its future slip delay; its block sync and sway timing update from whether it actually got hit.",
          "It drops its guard. It deliberately jiggles between a high and low guard. It gets caught out. Its anticipatory perfect blocks can freeze, expire, and miss.",
        ],
      },
    ],
  },
  {
    id: "ai-styles",
    title: "Styles & Difficulty",
    group: "The Opponent",
    icon: Users,
    blurb: "Four archetypes, four tiers, and what actually changes between them.",
    blocks: [
      { t: "h", text: "The four archetypes" },
      {
        t: "p",
        text:
          "An archetype is both a physical build and a set of decision biases. It changes how a fighter is put together and how they think.",
      },
      {
        t: "table",
        head: ["Style", "Build", "Behaviour"],
        rows: [
          ["Boxer-Puncher", "Balanced across the board", "Neutral aggression, range and combo tendencies. The baseline."],
          ["Out-Boxer", "+10% speed, −5% damage, cheaper punches, better regen", "Less aggressive, fights long, fewer combos. Jab setups, patience, lateral movement, a farther reset distance, disciplined defense, counters on your guard drops, and punishes sustained ducking."],
          ["Brawler", "+15% damage, −10% speed, costlier punches, +1.5% stamina", "More aggressive, closer, combo-prone. Favours body work, crosses, power punches and counters. Short cycles, little patience, uppercuts to answer ducks."],
          ["Swarmer", "+5% damage, cheaper punches, slightly better regen", "High volume infighter. Aggressive and close, long engagement cycles with short exits, lateral approach, lots of ducking and bodywork."],
        ],
      },
      {
        t: "note",
        text:
          "Within an archetype, values like patience, preferred distances, cycle length, defensive discipline and charge usage are varied by seed. Two Brawlers do not fight the same.",
      },
      { t: "h", text: "The four difficulty tiers" },
      {
        t: "p",
        text:
          "Journeyman, Contender, Elite and Champion. Difficulty is thinking speed and decision quality — it never touches damage, reach, or hit chance.",
      },
      {
        t: "table",
        head: ["What changes", "Journeyman → Champion"],
        rows: [
          ["Tactical state re-think", "every 0.50s → every 0.15s"],
          ["Phase re-evaluation", "every 1.00s → every 0.30s"],
          ["Movement decisions", "every 0.31s → every 0.08s"],
          ["Defensive decisions", "every 0.38s → every 0.08s"],
          ["Style quality retained", "15% → 100%"],
          ["Execution intensity", "0.25 → 1.0"],
          ["Chance of entering Pressure", "15% → 70%"],
          ["Combo follow-ups", "1 → 2"],
          ["Anticipatory block base chance", "60% → 85%"],
          ["Repeats needed to lock a pattern", "5 → 2"],
          ["Patterns held armed at once", "6 → 10"],
          ["Chance of learning an observation", "2% → 30%"],
          ["Maximum adaptation", "30% → 55%"],
          ["Duck usage cap", "10% → unlimited"],
          ["Feint follow-up rate", "30% → 90%"],
        ],
      },
      {
        t: "note",
        text:
          "Champion-difficulty roster opponents are deliberately routed to the champion's own brain and tuning, so they share his instincts. Their stats, refinements, level, reach and appearance remain entirely their own.",
      },
      {
        t: "p",
        text:
          "Your career rank also feeds the opponent's anticipatory block chance — the higher you climb, the sharper everyone gets. Quick fights, sparring, Nightmare and Doghouse have no rank attached, so they use the difficulty base alone.",
      },
    ],
  },
  {
    id: "ai-learning",
    title: "How It Learns You",
    group: "The Opponent",
    icon: GraduationCap,
    blurb: "The tape: what gets recorded, how it is answered, and what survives the bell.",
    blocks: [
      {
        t: "p",
        text:
          "This is the system that makes HANDZ what it is. The opponent keeps a tape of your offensive habits, and it does not forget between bouts.",
      },
      { t: "h", text: "What gets recorded" },
      {
        t: "p",
        text:
          "Only offensive actions go on the tape: punches, feints, arming a charge, and ducking or working the body. Footwork is context, not an action. A punch is recorded with its type, whether it went to the head or the body, and your stance — so a jab to the head from Orthodox is a different token from a jab to the body.",
      },
      { t: "h", text: "How a pattern forms" },
      {
        t: "ul",
        items: [
          "The tape reads in rolling three-action windows, so overlapping sequences all become candidates at once.",
          "Each sequence is filed under the context it happened in — specifically, the last punch the AI landed on you.",
          "Range is only an observation gate (roughly 95px), not part of the key, which stops near-identical sequences from splitting into separate buckets.",
          "A candidate needs to repeat a tier-dependent number of times before it becomes armed: 5 repeats at Journeyman, down to 2 at Champion.",
        ],
      },
      { t: "h", text: "What happens when it locks on" },
      {
        t: "p",
        text:
          "Once a pattern is armed, the chance of it being countered starts at 75% and rises 10% for every repeat beyond the threshold, capping at 99%. That chance is reduced by 0.25 percentage points for every hit you land that was not perfect-blocked, multiplied by 0.8 for each knockdown it has suffered, and penalised further while it is stunned.",
      },
      {
        t: "note",
        text:
          "A recognised pattern still has to pass the ordinary read gate for every single action in the sequence. Deviate and the script aborts immediately. Miss a read and it waits without losing the script. This is deliberately not omniscience — you can always break the read by changing what you do.",
      },
      { t: "h", text: "What survives" },
      {
        t: "ul",
        items: [
          "Career tape persists across bouts. It is stored as a library, merged rather than overwritten, so live observations add to career weight instead of flattening it.",
          "Studied entries are seeded into the AI's memory before the opening bell — it walks into the ring already knowing your habits. Carried repeats are capped so it cannot start a fight fully locked on.",
          "Gym modes — sparring, Nightmare, Doghouse and quick fights — may study the career library but never write to it. Their brains adapt live during the session and then forget.",
          "Bell rings and knockdowns clear the in-progress pattern windows, but they do not delete anything already learned.",
        ],
      },
      { t: "h", text: "Everything else it tracks" },
      {
        t: "p",
        text:
          "Alongside the tape, within a single bout it tracks your conditioning, clean hits, head-versus-body ratio, guard drops, ducks, retreats, sustained ducking, whiffs, sway rhythm, range errors, and your last five punch bursts. At every round boundary it nudges its adaptive memory slots — uppercut-on-duck, body-target bias, chasing you after a retreat, expecting a feint before an attack.",
      },
      {
        t: "note",
        text:
          "Under the Hood, at the top of this screen, overlays the combinations the AI has memorised off you during a live fight and marks the one it is currently answering. It is display only and changes nothing about the bout.",
      },
    ],
  },

  {
    id: "ai-fundamentals",
    title: `The ${FUNDAMENTALS.length} AI Fundamentals`,
    group: "The Opponent",
    icon: Brain,
    blurb: "Every boxing principle the AI is built and trained on, with when it applies and what counts as pulling it off.",
    blocks: fundamentalsBlocks(),
  },

  /* ═══════════════════════ DEVELOPER REFERENCE ══════════════════════════ */
  {
    id: "dev-neural",
    title: "Neural Network — Technical Reference",
    group: "Developer Reference",
    icon: Code2,
    blurb: "Engineering documentation for this view: data model, persistence, tuning transport.",
    blocks: [
      {
        t: "note",
        text:
          "This subsection is written for developers. It documents the implementation of the Neural Network view itself rather than how to play. It intentionally omits the access credential and how it is derived.",
      },
      { t: "h", text: "It is not a trained model" },
      {
        t: "p",
        text:
          "Despite the name and the node-graph canvas, there is no inference here — no weights, no backpropagation, no training loop. The 'neural network' is a hand-authored scalar parameter set with a graph-style editor drawn on top of it. The visualisation is a presentation of parameter-to-behaviour mapping; the persisted model is nothing more than the values.",
      },
      {
        t: "code",
        text: `type NeuralParam = { id: string; label: string; category: string };
type NeuralState = Record<string, number>;   // paramId -> normalized scalar
type Difficulty  = "journeyman" | "contender" | "elite" | "champion";

// 24 parameters across 6 categories:
//   Personality | Reaction | Defense | Offense | Movement | Resilience
const NEURAL_PARAMS: NeuralParam[] = [ /* ... */ ];

// One full parameter set per difficulty tier.
const DEFAULT_STATES: Record<Difficulty, NeuralState> = { /* ... */ };`,
      },
      {
        t: "p",
        text:
          "Node positions on the canvas are transient and live in a ref, not in state and not in storage. There is no persisted topology and no edge model — the graph is conceptual. Re-laying out the canvas has no effect on behaviour.",
      },
      { t: "h", text: "Persistence and resolution order" },
      {
        t: "table",
        head: ["localStorage key", "Holds"],
        rows: [
          ["handz_neural_state", "The global parameter set, all four difficulties"],
          ["handz_fighter_neural", "Per-fighter overrides, keyed by fighter id"],
          ["handz_neural_defaults", "Custom defaults, written by 'Set … Default' one difficulty at a time"],
          ["handz_neural_presets", "Named presets: { name, all four difficulty states, createdAt }"],
        ],
      },
      {
        t: "p",
        text:
          "Resolution runs override → global → shipped default. A fighter with no personal entry silently falls back, so an override is genuinely additive and safe to delete. Reset All Networks clears global state, custom defaults and every fighter override — it deliberately does not clear presets.",
      },
      { t: "h", text: "Consumption at fight time" },
      {
        t: "p",
        text:
          "Resolved values are read once when the brain is constructed, not polled per tick. There is no service boundary and no async — the parameters are folded into AiBrainState at init and the engine then operates on state.aiBrain directly.",
      },
      {
        t: "note",
        text:
          "A brain's identity is (rosterId, archetype), and the profile derived from it is deterministic. Editing parameters changes behaviour on the next brain construction, not mid-bout. Note also that HMR keeps live brains alive across a reload, so any newly added AiBrainState field needs an idempotent backfill at the top of the update loop or an in-flight fight will throw.",
      },
      { t: "h", text: "The tuning bundle" },
      {
        t: "p",
        text:
          "Everything editable in this view is registered in a single central registry, each entry mapped to its own localStorage key. The registry covers the neural keys above plus punch animation, roster generation, fight tips, items, scaling, XP, stamina, refinement, turn, range, stoppage and AI-pattern configs, along with the boolean toggles (including the under-the-hood HUD switch). It also carries the AI training outputs: the deployed RL policy (handz_rl_policy — whatever was last deployed from AI Training, with its live-use mode) and the fundamentals-trained champion (handz_champion_fundamental_states — its parameters plus remembered situations, republished each time a fundamental closes). So the most recently deployed/trained AI is what a publish ships. The training runs themselves (population, RL trainer checkpoint) are scratch work and stay in the browser.",
      },
      {
        t: "code",
        text: `// Export shape written by Download Parameters
{
  kind: "handz-neural-parameters",
  version: 1,
  exportedAt: string,        // ISO
  params: Record<string, unknown>   // one entry per registry key
}`,
      },
      {
        t: "ul",
        items: [
          "Export reads each registry key, JSON-parses it, and validates only the outer shape.",
          "Upload rejects a wrong kind, a wrong version, unknown sections, or a wrong per-section shape. Application then replaces registered keys, removes sections absent from the bundle, and invalidates the scaling, punch-animation, refinement and champion-fundamentals caches.",
          "Upload is a replace, not a merge. A section missing from the file is deleted, not left alone.",
          "Stateful child editors are remounted after an upload via a paramEpoch key bump — without it they would keep rendering their pre-upload state.",
        ],
      },
      { t: "h", text: "Shipping defaults with a build" },
      {
        t: "p",
        text:
          "The server reads data/tuned-defaults.json and injects it into the HTML as window.__HANDZ_TUNED__. On startup the client seeds any registry key the browser does not already have. Seeding is additive and stamped with a revision in handz_tuned_rev.",
      },
      {
        t: "code",
        text: `// Revision = FNV-1a hash of the serialized injected params.
// Same revision  -> skip seeding entirely.
// New revision   -> seed keys the browser is missing, then re-stamp.
//
// This is change detection, not integrity or security.`,
      },
      {
        t: "note",
        text:
          "Saved localStorage values win field-by-field over code defaults. Editing a constant in a source file will not reach a browser that already has that field seeded — the value in data/tuned-defaults.json has to change too, which is what moves the hash and forces the re-seed. This is the single most common way a tuning change appears to do nothing.",
      },
      { t: "h", text: "The development watcher" },
      {
        t: "p",
        text:
          "While a tab is open in development, a watcher polls every registry key, hashes the raw values, and POSTs the complete bundle to /api/tuning-defaults on change (default every 1.5s, with a flush on stop). The route persists to disk in development only; a published server refuses it, and the client treats a 403 as permanently refused for the rest of the session.",
      },
      {
        t: "note",
        text:
          "Because of this watcher, data/tuned-defaults.json shows as modified during normal development. That is expected. Do not 'restore' it to match the code defaults — doing so silently reverts published tuning.",
      },
      { t: "h", text: "Rhythm-cut and resource settings" },
      {
        t: "dl",
        rows: [
          ["rhythmCutCommit, rhythmCutAggression, rhythmSwayAdapt", "Neural offensive rhythm parameters, defaulted per difficulty tier."],
          ["rhythmCutHit, rhythmCutFightCap", "Part of the max-stamina config, which also carries per-event enable and use-points flags plus clean-hit, streak and ring-mileage settings."],
          ["Rhythm-cut timing config", "Rank-band chances, delay and speed-up windows, and the vulnerable-window half-width."],
          ["Directional perfect block", "A separately persisted boolean, not part of the neural state."],
        ],
      },
      {
        t: "note",
        text:
          "Every max-stamina event reads its percentage off the bout-start pool, so a percentage has to be converted to points at the event, not at settle time — the pool has already moved by then.",
      },
      { t: "h", text: "XP and stat multipliers" },
      {
        t: "p",
        text:
          "XP config is loaded at mount and every field edit writes through immediately to handz_xp_config; defaults live separately in handz_xp_defaults. The exposed fields cover weightlifting, heavy bag and sparring session multipliers, prep and idle-week XP bonuses, and the stat-point coefficients. Both keys are in the tuning registry, so they travel with an export.",
      },
      {
        t: "note",
        text:
          "Level ramps and stat-point coefficients are player-tunable config. Writing an inline (level - 1) / 99 anywhere re-hardcodes the old level-100 clamp for that stat and silently opts it out of the ramp registry.",
      },
      { t: "h", text: "Lifecycle relative to a career save" },
      {
        t: "p",
        text:
          "None of this is part of a career save object — it is all browser-level configuration. Starting a new career does not reset the neural state, the presets, the XP config, or any other tuning key. Fighter overrides are keyed by fighter id, so they only apply if that id exists in the active roster; a new fighter simply falls through to global.",
      },
      { t: "h", text: "Access control" },
      {
        t: "p",
        text:
          "The view is behind a numeric gate held in local component state and validated through the shared pin-auth module. Fighter mode initialises unlocked; global mode renders the gate. The credential and its derivation are deliberately not documented here.",
      },
      { t: "h", text: "Structure of this view" },
      {
        t: "p",
        text:
          "Historically this component had no tab primitive — subviews (roster generation, fight tips, items, and these docs) are launched from buttons and rendered as early returns before the main panel, each guarded on the unlocked flag. That is the established pattern; new subviews should follow it rather than introducing a parallel navigation system.",
      },
      {
        t: "code",
        text: `// Established subview pattern in NeuralNetworkView.tsx
const [showItemsEditor, setShowItemsEditor] = useState(false);
// ...
if (showItemsEditor && unlocked) {
  return <ItemsEditorView onBack={() => setShowItemsEditor(false)} />;
}`,
      },
      {
        t: "note",
        text:
          "Do not run npx tsc --noEmit in this project — it falls back to a default ES5 config and floods false errors. Use LSP diagnostics plus npx vite build as the authoritative static check.",
      },
    ],
  },
];

/* ────────────────────────────────────────────────────────────────────────────
   Rendering
   ──────────────────────────────────────────────────────────────────────── */

function BlockView({ block }: { block: Block }) {
  switch (block.t) {
    case "h":
      return (
        <h4 className="text-sm font-bold mt-5 mb-1.5" style={{ color: "#e8c877" }}>
          {block.text}
        </h4>
      );
    case "p":
      return <p className="text-[13px] leading-relaxed text-muted-foreground mb-2.5">{block.text}</p>;
    case "ul":
      return (
        <ul className="space-y-1.5 mb-3 ml-1">
          {block.items.map((it, i) => (
            <li key={i} className="text-[13px] leading-relaxed text-muted-foreground flex gap-2">
              <span className="shrink-0 mt-[7px] w-1 h-1 rounded-full" style={{ background: "#e8c877" }} />
              <span>{it}</span>
            </li>
          ))}
        </ul>
      );
    case "dl":
      return (
        <dl className="space-y-2 mb-3">
          {block.rows.map(([term, def], i) => (
            <div key={i} className="border-l-2 pl-3" style={{ borderColor: "#3a3a2a" }}>
              <dt className="text-[12px] font-semibold" style={{ color: "#d8d8c0" }}>{term}</dt>
              <dd className="text-[12px] leading-relaxed text-muted-foreground">{def}</dd>
            </div>
          ))}
        </dl>
      );
    case "table":
      return (
        <div className="mb-3 overflow-x-auto rounded border" style={{ borderColor: "#2a2a2a" }}>
          <table className="w-full text-[12px]">
            {block.head.some(h => h !== "") && (
              <thead>
                <tr style={{ background: "#161610" }}>
                  {block.head.map((h, i) => (
                    <th key={i} className="text-left px-2.5 py-1.5 font-semibold" style={{ color: "#e8c877" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {block.rows.map((row, i) => (
                <tr key={i} style={{ background: i % 2 ? "transparent" : "#0e0e0c" }}>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className="px-2.5 py-1.5 align-top text-muted-foreground"
                      style={j === 0 ? { color: "#d8d8c0", fontWeight: 600, whiteSpace: "nowrap" } : undefined}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "note":
      return (
        <div
          className="mb-3 rounded px-3 py-2 text-[12px] leading-relaxed"
          style={{ background: "#14140c", borderLeft: "3px solid #e8c877", color: "#cfcaa8" }}
        >
          {block.text}
        </div>
      );
    case "code":
      return (
        <pre
          className="mb-3 rounded p-3 text-[11px] leading-relaxed overflow-x-auto"
          style={{ background: "#08080a", border: "1px solid #1e1e28", color: "#9fd39f" }}
        >
          <code>{block.text}</code>
        </pre>
      );
  }
}

function sectionText(s: DocSection): string {
  const parts: string[] = [s.title, s.blurb];
  for (const b of s.blocks) {
    switch (b.t) {
      case "p":
      case "h":
      case "note":
      case "code":
        parts.push(b.text);
        break;
      case "ul":
        parts.push(b.items.join(" "));
        break;
      case "dl":
        parts.push(b.rows.flat().join(" "));
        break;
      case "table":
        parts.push(b.head.join(" "), b.rows.flat().join(" "));
        break;
    }
  }
  return parts.join(" ").toLowerCase();
}

export default function GameDocsView({ onBack }: { onBack: () => void }) {
  const [activeId, setActiveId] = useState<string>(SECTIONS[0].id);
  const [query, setQuery] = useState("");

  const haystacks = useMemo(
    () => new Map(SECTIONS.map(s => [s.id, sectionText(s)])),
    []
  );

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return null;
    return new Set(SECTIONS.filter(s => haystacks.get(s.id)!.includes(q)).map(s => s.id));
  }, [query, haystacks]);

  const active = SECTIONS.find(s => s.id === activeId) ?? SECTIONS[0];
  const ActiveIcon = active.icon;

  return (
    <div className="flex flex-col gap-3 p-4 max-w-5xl mx-auto w-full">
      <div className="flex items-center gap-3 w-full">
        <Button variant="ghost" size="icon" onClick={onBack} data-testid="button-back-docs">
          <ArrowLeft className="w-5 h-5" />
        </Button>
        <div className="flex-1">
          <h2 className="text-xl font-bold">Documentation</h2>
          <p className="text-xs text-muted-foreground">
            Everything HANDZ does, from the premise to the internals.
          </p>
        </div>
      </div>

      <div className="relative w-full">
        <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          value={query}
          onChange={e => setQuery(e.target.value)}
          placeholder="Search the documentation…"
          className="pl-8"
          data-testid="input-docs-search"
        />
      </div>

      <div className="flex flex-col md:flex-row gap-3 w-full items-start">
        {/* ── Navigation ────────────────────────────────────────────── */}
        <Card className="p-2 w-full md:w-60 shrink-0 md:sticky md:top-4" style={{ background: "#0d0d0a" }}>
          <nav className="space-y-2 max-h-none md:max-h-[70vh] md:overflow-y-auto">
            {GROUPS.map(group => {
              const inGroup = SECTIONS.filter(s => s.group === group);
              const visible = matches ? inGroup.filter(s => matches.has(s.id)) : inGroup;
              if (visible.length === 0) return null;
              return (
                <div key={group}>
                  <p className="text-[10px] uppercase tracking-wider px-2 py-1 font-semibold" style={{ color: "#6a6a55" }}>
                    {group}
                  </p>
                  <div className="space-y-0.5">
                    {visible.map(s => {
                      const Icon = s.icon;
                      const isActive = s.id === activeId;
                      return (
                        <button
                          key={s.id}
                          onClick={() => setActiveId(s.id)}
                          className="w-full text-left px-2 py-1.5 rounded text-[12px] flex items-center gap-2 transition-colors"
                          style={
                            isActive
                              ? { background: "#2a2410", color: "#e8c877", fontWeight: 600 }
                              : { color: "#9a9a88" }
                          }
                          data-testid={`button-docs-section-${s.id}`}
                        >
                          <Icon className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{s.title}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
            {matches && matches.size === 0 && (
              <p className="text-[11px] text-muted-foreground px-2 py-3" data-testid="text-docs-no-results">
                Nothing matches that.
              </p>
            )}
          </nav>
        </Card>

        {/* ── Content ───────────────────────────────────────────────── */}
        <Card className="p-4 md:p-5 flex-1 w-full min-w-0" style={{ background: "#0b0b09" }}>
          <div className="flex items-start gap-2.5 mb-1">
            <ActiveIcon className="w-5 h-5 mt-0.5 shrink-0" style={{ color: "#e8c877" }} />
            <div>
              <h3 className="text-lg font-bold leading-tight">{active.title}</h3>
              <p className="text-[11px] uppercase tracking-wider" style={{ color: "#6a6a55" }}>
                {active.group}
              </p>
            </div>
          </div>
          <p className="text-[12px] italic text-muted-foreground mb-4 pb-3 border-b" style={{ borderColor: "#242420" }}>
            {active.blurb}
          </p>
          <div data-testid={`content-docs-${active.id}`}>
            {active.blocks.map((b, i) => (
              <BlockView key={i} block={b} />
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
