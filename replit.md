# HANDZ - The Boxing Game

## Overview
HANDZ is a full-stack web application implementing a top-down orthographic boxing game. It features a canvas-based fighting system with 8-directional movement, stamina-driven combat, diverse fighter archetypes, and a career mode that includes persistent fighter progression. The game utilizes HTML5 Canvas for real-time rendering and a PostgreSQL database for managing fighter data and fight outcomes. The project aims to deliver a comprehensive boxing simulation experience in a web browser.

## User Preferences
Preferred communication style: Simple, everyday language.
After each request, concisely state in plain English the new functionality it added.

**GitHub sync (set by the user):** every update is committed to https://github.com/ajreynolds112-lang/HANDZ-Beta-1.3 (branch `main`) via the GitHub connection. Push **only when the user asks for a push** (user's instruction, Oct 5 2026; replaces the earlier push-every-update rule). Every push also updates the repo's About description to: `Last update: <date, time ET> — <what was changed/rolled back>` (GitHub caps it at 350 chars). The Neural Network screen also has a **Push to GitHub** button (`server/githubPush.ts`, `/api/github/*`). It works only in the workspace and only while online, and pushes the same tree diff with the same About-description format. **Import from GitHub**, just below it, does the reverse. It previews the files it would update, add or delete, applies only after you confirm, runs npm install when the package files change, and never touches `.agents/`, `.replit`, `.gitignore` or Git LFS files.

**Neural Network data files (set by the user, Oct 5 2026):** Download Data / Upload Data and Download / Upload Parameters write and read the same full file: every registered tunable (including edited poses, punch animations/profiles, the deployed RL policy and the trained fundamentals champion) plus the AI Training state. Every new Neural Network feature or setting must be added to that file (the key registry in `client/src/lib/tuningBundle.ts`, or a file-only section there) in the same change.

**Skill activation (set by the user):** `using-agent-skills` (in `.local/custom_skills/`) is the single entry point. Activate it FIRST at the start of every task; it decides which other skills load. Only load a skill when the task matches its trigger below or in its own decision tree. Never preload the whole list, because every skill read costs tokens on every request.

*Always on (small, every change):*
- `ponytail-main-*` (both variants): laziest working solution, YAGNI, reuse before writing, root-cause fixes.
- `token-efficiency`: keep tool output and file reads small.

*Load on trigger (`using-agent-skills` routes to these):*
- Any game-dev work (fighters, AI, levels, feel, physics, shaders): `router` first, which then picks the gamedev skill.
- AI opponent decision-making or behavior logic: `game-ai`.
- Controls, key mapping, rebinding, input feel: `input-systems`.
- Fight or gym camera follow, zoom, framing, shake: `camera-systems`.
- HUD, menus, overlays, scaling, focus navigation: `game-ui-ux`. Also `a11y-debugging` when the UI change affects keyboard nav, focus, labels or contrast.
- Save slots, persistence, migrations, save import/export: `save-systems`.
- Career progression, stats, leveling, items, equipment, rewards: `rpg`.
- Generated or sourced art (sprites, item icons, textures): `create-game-assets`.
- API, module boundary or shared type contracts: `api-and-interface-design`.
- Non-obvious design decisions or doc updates: `documentation-and-adrs`.
- Check scripts, validation workflows, build/deploy automation: `ci-cd-and-automation`.
- Reviewing a diff: `code-review-and-quality` and `code-simplification`; `ponytail-review-*` for over-engineering.
- Verifying browser behavior (DOM, console, network, visuals): `browser-testing-with-devtools` and `chrome-devtools-cli`, using the system Chromium (setup in `chrome-devtools/references/installation.md`; no MCP server is configured). Use `troubleshooting` if the page or connection fails. Fall back to screenshots and logs only if the CLI can't run.
- Slow page or menu loads, Core Web Vitals: `debug-optimize-lcp`.
- Memory growth, long-session slowdowns: `memory-leak-debugging`.
- Session, auth, cookie or 401/403 issues: `cookie-debugging`.
- Internet or outside-URL lookups: `skill` (web research).
- Session context growing heavy: `context-engineering`.
- On request only: `ponytail-audit-*`, `ponytail-debt-*`, `ponytail-gain-*`, `ponytail-help-*`.

*Skill discovery:* when a task could benefit from a skill not listed here, search before building. Use `skill-finder` (secondary) for existing Replit or workspace skills, `github-solution-finder` (secondary) for proven open-source solutions, and `skill` for anything outside the repo. Choose by long-term cost efficiency: prefer what's installed, and adopt something new only if repeated use saves more than it costs to set up and keep in context. Skip discovery on routine tasks the current skills already cover.

## System Architecture

### Frontend
The frontend is built with React 18, TypeScript, Wouter for routing, and React Query for server state management. UI components are styled with shadcn/ui (New York style) and Tailwind CSS, supporting light/dark modes. The game engine is custom-built on HTML5 Canvas, featuring an advanced AI system with state machines, tactical phases, and personality, ported from a C# Unity implementation. Key game mechanics include a 2.5D perspective, 8-directional fighter movement, a rhythm-based combat system, feint-whiff punishment, a 5-phase punch system, and detailed defense mechanics. Fighter customization includes gear colors. A comprehensive knockdown system with ref mercy stoppages and corner towel stoppages is implemented. Quick Fight mode offers adjustable difficulty and round settings, plus a "Select Opponent" roster picker to choose specific fighters from the 204-fighter roster. A two-stage Tutorial Mode accessible from the main menu teaches core mechanics (movement, punches, blocking, ducking) in Stage 1 and advanced techniques (auto guard, guard toggling, weaving, rhythm control) in Stage 2, using a Journeyman level-10 AI opponent that starts idle and activates after punch tutorials. Career Mode features an open-ended career with ELO-based rankings, a 204-fighter roster, weekly simulations, XP-based progression with stat point allocation, and a prep weeks system. The interactive Gym is the career home screen: loading a save, finishing a fight, training, or simulating a week all land in the gym. It shows a fighter header (name/record/rank), a clickable Force chip that opens a Force→SP convert dialog (1,000 Force = 1 SP), an office desk that opens the Fight Planner (the former hub screen, now stripped of training/convert controls), two wide trophy cases flanking the exit door (left → Career Stats, right → Skill Refinement, locked until rank 650) that fill with trophies (1 per 3 wins, 30/case) and medals (1 per 20 refinement points, 40/case) persisted per save in localStorage (`handz_trophies_<fighterId>`), the player's own fighter idling by a wooden bench (click → Edit Colors), and a weekly +XP/+SP bonus tag over the matching equipment (hidden during fight week or when the 2-sessions-per-week training limit is reached, which also locks the Spar/Train/Bag Work popup buttons). The gym exit door returns to the main menu. All sparring modes (every difficulty, Nightmare, and Doghouse) take place in the gym scene: the gym equipment is drawn around the ring during sparring fights and follows the live fight camera (yaw tracking, auto-zoom, focus follow), while each mode's UI and HUD are unchanged. An Input Recording system captures detailed per-frame fight data for AI training analysis, exportable as text files. The game also includes a procedural audio engine built on the Web Audio API for all game sounds and a pre-punch telegraph animation system that scales with fighter level. A visual neural network editor allows admin-level control over AI behavior parameters per difficulty. Its Download/Upload Data and Download/Upload Parameters buttons share one file, which also carries the AI Training state: the fundamentals run (`handz_ai_training`) and the RL trainer checkpoint (`handz_rl_checkpoint`, from IndexedDB). These two sections are file-only, never shipped as defaults, and an upload without them leaves training alone. Per-fighter neural networks (no PIN required) allow individual AI behavior customization. A "Reset All Networks" button with confirmation clears all global, default, and per-fighter neural overrides. A player playstyle visualization in the Career Stats section displays a read-only radar chart computed from fight/sparring performance data, using the same 22 neural network parameters — it updates after each fight or sparring session and is stored in localStorage (`handz_player_playstyle`) with exponential moving average blending (60% old / 40% new). An Invisible Adaptive AI Behavior Engine runs under the hood: AI opponents gradually learn the player's effective patterns during a fight and subtly adjust tactics. The system tracks micro-patterns (jab-step, duck-counter, pivot-punch, backstep-counter, block-counter, dodge-counter) and macro-patterns (exchanges with combo sequences, ring position context) with outcome gating — only patterns where the AI takes more damage or stamina loss are forwarded for adaptation. A 32-slot timing base on AiBrainState stores nudgeable AI response preferences (commit chance, patience, feint bias, body targeting, uppercut-on-duck, retreat tracking, guard drop exploit, engage cycle timing, defense discipline, etc.). Adaptation is probabilistic per difficulty (Journeyman 2%, Contender 8%, Elite 18%, Champion 30%), reviewed every 10 seconds mid-round, with risk management scaling. Confidence decays 0.85x per round boundary and round 1 adaptations are weak. An "ADAPTIVE AI MODE" toggle in MainMenu settings (localStorage key `handz_adaptive_ai`, default true) controls the entire system.

### Combat Systems: Feints, Reaction Flinch, and Reset
All numbers below are the shipped defaults and are tunable in the Energy Fatigue & Reset card of the neural network editor; both corners read the same config, so every rule applies to the AI exactly as it does to the player.

**Feints.** A feint is F held plus a punch key, and it commits on the key going DOWN so feints can be thrown as fast as the hand resets. The punch key's release afterwards is eaten rather than throwing a real punch behind the sell. Real punches still commit on the way UP, and F held at the moment of release still sells a shot that was started as a real one. A feint costs 30% of that punch's stamina, never spends an armed charge, and is never buffered — one that cannot come out right now is dropped, while a real punch buffers for 200ms. A feint already retracting can be cashed into the real punch by the arm that sold it (it continues out of its own retraction); the other arm drops the feint and starts from scratch. The Technician refinement unlocks cancelling a feint during its linger phase. A feint that physically touches the opponent makes their next punch fail — 60%→30% by level for the player, 85/80/75/70% by difficulty for the AI — and punching at a fighter who is feinting, in range, is punished: double retraction penalty on the whiffer, a telegraph read for the baiter (20%→5% by level), a +0.025 round telegraph penalty, and a 0.5s cooldown before it can be punished again.

**Reaction flinch.** Three things draw a flinch from the fighter in front of them, all measured inside 95px centre to centre: a feint reaching full extension, a punch landing that was not perfect-blocked, and a duck input going in. The defender must be walking for it to land at all, unless the fighter drawing the reaction is the one inputting a duck. It is refused outright if the defender is actually answering the shot — perfect block rising or active, a slip running, a duck input held, or a live Reset whose benefits have not been stripped. The flinch slides both hands 8px forward and either down (more non-perfect-blocked body shots taken this bout) or high (more head shots), a coin flip when level, out and back over 0.35s on the same limb delay as the fatigue sway, so the rear hand trails the lead. While it plays the ordinary guard is bypassed completely, hooks included: nothing comes off a punch thrown into a flinch unless the defender times a real perfect block. Each reaction takes 5% off the next, so a fighter repeatedly drawn eventually stops reacting at all. Feints are also rationed per punch and per stance — one committed punch of that exact punch and stance, thrown to full extension in range, buys 4 feints of it; the 5th and beyond still play but draw nothing until a real one closes the ratio again. Both halves of that ratio only count inside 95px.

**Reset (B).** Reset fires on the B key coming UP, so the read is graded where the bout is at release. It suspends fatigue for 20s — every fatigue penalty keeps applying at 10% strength rather than switching off — and clears the punishment banked since the last one: consecutive punches taken, stamina carry, duck lag, and the rhythm's widening vulnerability window. It also puts the flinch back to full strength, cancels any flinch playing, and owes the next flinch a pass for 1.5s. The cooldown starts at 0.75s and grows 0.01s with every Reset spent in the bout. Resetting within 2s of being hit is a panic Reset and costs max stamina for the remainder of the bout, down to a 90% floor — unless it was a read: a feint in the air (from its launch until it would land) or an opponent sitting in a duck, inside 95px, makes the Reset free. A stun locks the stunned fighter out of Reset for 5s at zero Defense down to 0.5s at the cap, announced with a double blink inside a 0.35s window; a Reset that plays all the way through is marked with a single blink and then eyes-open quiet, 20s for a fighter who has taken nothing down to 3s by 200 punches taken. Taking a punch during a Reset strips its benefits but keeps the stamina recovery, and only a whole new Reset buys them back. A perfect block freezes the window's countdown for 2s, recovery is 3x while the resetter is more than 95px from their opponent, and the rhythm kicks into a full-speed sweep for 1s before handing back to footwork. Visually it is a staggered snap — torso, then lead arm, then rear arm — stretched by how gassed the fighter is and by punishment banked since the last Reset, with a small head dip. CPU corners spend Resets everywhere except Nightmare and ordinary gym sparring below champion difficulty.

### Backend
The backend is an Express 5 server using Node.js and TypeScript, exposing a RESTful JSON API for fighter management and fight result storage.

### Shared Code
A `shared/` directory contains Drizzle ORM schema definitions and Zod validation schemas for `fighters` and `fight_results` tables, ensuring type safety and consistency.

### Database
PostgreSQL serves as the primary data store, managed by Drizzle ORM. The schema includes `fighters` (with detailed stats, progression, and career data) and `fight_results` tables.

### Build System
Vite is used for frontend development and building, while esbuild handles the backend. Path aliases simplify module imports.

## External Dependencies

### Database
- **PostgreSQL**: Primary database.
- **pg**: Node.js client for PostgreSQL.

### Key NPM Packages
- **drizzle-orm** & **drizzle-kit**: ORM for database interaction and schema management.
- **@tanstack/react-query**: For server state management in React.
- **wouter**: Lightweight client-side router.
- **zod**: Schema validation.
- **shadcn/ui ecosystem**: UI component library and styling utilities.
- **express**: Backend web framework.