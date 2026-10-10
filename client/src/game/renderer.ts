import { GameState, FighterState, HitEffect, BIG_SHOT_TEXT_DURATION, MAX_STAMINA_DELTA_TEXT_LIFETIME } from "./types";
import { soundEngine } from "./sound";
import { xpToNextLevel } from "./engine";
import { SPACIAL_BASE_HEX, enableSpacialFills, isSpacial, spacialPaint } from "./spacialColor";

function parseHex(hex: string): [number, number, number] {
  // The Spacial finish is not a hex — everything that shades, contrasts or
  // gradients off it works from its base black instead.
  const h = (isSpacial(hex) ? SPACIAL_BASE_HEX : hex).replace('#', '');
  if (h.length === 6) {
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  return [128, 128, 128];
}

const CANVAS_W = 800;
const CANVAS_H = 600;

/**
 * Bumped by every resetAutoZoom so the 3D broadcast camera, which keeps its own
 * state, snaps back to the wide shot (fight start, new round, quit).
 */
let cameraResetEpoch = 0;
export function getCameraResetEpoch(): number {
  return cameraResetEpoch;
}

export function resetAutoZoom(): void {
  cameraResetEpoch++;
}

const COLORS = {
  staminaPlayer: "#22cc44",
  staminaEnemy: "#cc4422",
  staminaBg: "rgba(0,0,0,0.6)",
};

/** Projects an engine floor point (px) plus a height (px) to 800x600 screen space. */
export type WorldProjector = (wx: number, wz: number, heightPx: number) => { sx: number; sy: number } | null;

/**
 * The 2D layer over the 3D view: every screen-space overlay (HUD, banners,
 * prompts, pause menu) plus world-anchored hit text placed with `project`.
 * The 3D scene underneath draws the world.
 */
export function renderGame(ctx: CanvasRenderingContext2D, state: GameState, project: WorldProjector | null): void {
  enableSpacialFills(ctx);
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.restore();
  ctx.save();
  if (project) drawHitEffectsProjected(ctx, state.hitEffects, project);
  drawScreenOverlays(ctx, state);
  ctx.restore();
}

/** Every screen-space layer drawn over the world: HUD, banners, prompts, pause. */
function drawScreenOverlays(ctx: CanvasRenderingContext2D, state: GameState): void {
  if ((state.phase === "fighting" || state.phase === "prefight") && !state.menuBackground) {
    drawHUD(ctx, state);
  }

  if (state.phase === "prefight" && state.countdownTimer > 0 && !state.menuBackground) {
    drawCountdown(ctx, state.countdownTimer);
  }

  if (state.knockdownActive && !state.menuBackground) {
    drawKnockdownOverlay(ctx, state);
  }

  // Screen-space, like every other announcement here. This used to be drawn
  // inside the world transform, where the camera's pan and zoom dragged it off
  // centre and clipped it against the top or bottom edge.
  if (state.refStoppageActive && !state.menuBackground) {
    drawStoppageOverlay(ctx, state);
  }

  if (state.bigShotTextTimer > 0 && !state.menuBackground) {
    drawBigShotBanner(ctx, state.bigShotTextTimer);
  } else if ((state.rockerShotTextTimer ?? 0) > 0 && !state.menuBackground) {
    drawBigShotBanner(ctx, state.rockerShotTextTimer!, "HE'S HURT", ["#e8f6ff", "#5ab8ff", "#2a3ce0"]);
  }

  if (state.tutorialMode && state.tutorialPrompt && !state.isPaused) {
    drawTutorialPrompt(ctx, state);
  }

  if (state.isPaused) {
    drawPauseMenu(ctx, state.pauseSelectedIndex, state.pauseSoundTab, state.pauseControlsTab, state.sparringMode || state.careerFightMode, state);
  }
}
/** Used when a save predates the editable sock colour. */
export const DEFAULT_SOCK_COLOR = "#f0f0f0";

function drawStoppageOverlay(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();

  ctx.fillStyle = "rgba(0,0,0,0.3)";
  ctx.fillRect(0, CANVAS_H / 2 - 40, CANVAS_W, 80);

  ctx.fillStyle = "#ff3333";
  ctx.font = "bold 32px 'Oxanium', sans-serif";
  ctx.textAlign = "center";

  const label = state.refStoppageType === "towel" ? "TOWEL STOPPAGE" : "REFEREE STOPPAGE";
  ctx.fillText(label, CANVAS_W / 2, CANVAS_H / 2 + 5);

  ctx.fillStyle = "rgba(255,255,255,0.7)";
  ctx.font = "14px 'Oxanium', sans-serif";
  ctx.fillText("THE FIGHT HAS BEEN STOPPED", CANVAS_W / 2, CANVAS_H / 2 + 28);

  ctx.restore();
}

/** Hit effects over the 3D view: anchored at head height through its camera. */
function drawHitEffectsProjected(ctx: CanvasRenderingContext2D, effects: HitEffect[], project: WorldProjector): void {
  for (const e of effects) {
    const pt = project(e.x, e.y, 90);
    if (!pt) continue;
    const rise = (0.6 - e.timer) * 30;
    drawHitEffectText(ctx, e, pt.sx, pt.sy - rise);
  }
}

function drawHitEffectText(ctx: CanvasRenderingContext2D, e: HitEffect, x: number, y: number): void {
  {
    const alpha = Math.min(1, e.timer * 2);
    ctx.save();
    ctx.globalAlpha = alpha;

    if (e.type === "perfectBlock") {
      ctx.fillStyle = "#eab308";
      ctx.font = "bold 16px 'Oxanium', sans-serif";
    } else if (e.type === "crit") {
      ctx.fillStyle = e.attackerColor ?? "#ff4444";
      ctx.font = "bold 20px 'Oxanium', sans-serif";
    } else if (e.type === "block") {
      ctx.fillStyle = e.attackerColor ?? "#6688ff";
      ctx.font = "bold 15px 'Oxanium', sans-serif";
    } else if (e.type === "feint") {
      ctx.fillStyle = e.attackerColor ?? "#aaaaff";
      ctx.font = "italic 14px 'Oxanium', sans-serif";
    } else {
      ctx.fillStyle = e.attackerColor ?? "#ffcc44";
      ctx.font = "bold 16px 'Oxanium', sans-serif";
    }

    ctx.textAlign = "center";
    ctx.fillText(e.text, x, y);
    ctx.restore();
  }
}

function drawExpBarOverlay(ctx: CanvasRenderingContext2D, state: GameState): void {
  const level = state.playerLevel;
  const xp = state.playerCurrentXp ?? 0;
  const needed = xpToNextLevel(level);
  const fillPct = needed > 0 ? Math.min(1, xp / needed) : 1;

  const ow = 164, oh = 37;
  const ox = 0, oy = 0;
  const barX = ox + 6, barW2 = ow - 12, barH2 = 5;
  const barY = oy + oh - 14;

  ctx.save();
  // Pinned to the top middle at 80% size: the top corners belong to the
  // active-item rows, which used to sit on top of this panel.
  const XP_SCALE = 0.8;
  ctx.translate((CANVAS_W - ow * XP_SCALE) / 2, 6);
  ctx.scale(XP_SCALE, XP_SCALE);
  ctx.globalAlpha = 0.92;
  ctx.fillStyle = "#1a1a1a";
  ctx.beginPath();
  ctx.roundRect(ox, oy, ow, oh, 5);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.font = "bold 10px 'Oxanium', sans-serif";
  ctx.textAlign = "left";
  ctx.fillStyle = "#ffffff";
  ctx.fillText(`LV ${level}`, ox + 6, oy + 14);

  const xpStr = `${Math.ceil(xp).toLocaleString()} / ${needed.toLocaleString()} XP`;
  ctx.font = "8px 'Oxanium', sans-serif";
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,0.55)";
  ctx.fillText(xpStr, ox + ow - 6, oy + 14);

  ctx.fillStyle = "#262626";
  ctx.beginPath();
  ctx.roundRect(barX, barY, barW2, barH2, 2);
  ctx.fill();

  if (fillPct > 0) {
    ctx.fillStyle = "#4d9432";
    ctx.beginPath();
    ctx.roundRect(barX, barY, Math.max(4, barW2 * fillPct), barH2, 2);
    ctx.fill();
  }

  if (state.midFightLevelUpTimer && state.midFightLevelUpTimer > 0) {
    const alpha = Math.min(1, state.midFightLevelUpTimer / 0.5);
    ctx.globalAlpha = alpha;
    ctx.font = "bold 9px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "#ffe066";
    ctx.fillText("▲ LEVEL UP!", ox + 6, oy + oh - 2);
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

function drawHUD(ctx: CanvasRenderingContext2D, state: GameState): void {
  const barW = 260;
  const barH = 18;
  const padding = 15;
  const hudH = 70;
  const hudTop = CANVAS_H - hudH;
  const barY = hudTop + 15;

  ctx.fillStyle = "rgba(0,0,0,0.5)";
  ctx.fillRect(0, hudTop, CANVAS_W, hudH);

  const nmBoostActive = state.nightmareMode && state.nightmareRegenBoostTimer > 0;
  drawStaminaBar(ctx, padding, barY, barW, barH, state.player, true, nmBoostActive);
  if (!state.nightmareMode) {
    drawStaminaBar(ctx, CANVAS_W - padding - barW, barY, barW, barH, state.enemy, false);
  }
  drawMaxStaminaDeltaTexts(ctx, state, padding, barW, barY);

  const sqSize = 12;
  const sqGap = 3;
  const sqY = barY + (barH - sqSize) / 2;

  const pSqX = padding + barW + sqGap;
  ctx.fillStyle = state.player.colors.gloves;
  ctx.fillRect(pSqX, sqY, sqSize, sqSize);
  ctx.strokeStyle = "rgba(255,255,255,0.4)";
  ctx.lineWidth = 1;
  ctx.strokeRect(pSqX, sqY, sqSize, sqSize);

  ctx.fillStyle = state.player.colors.trunks;
  ctx.fillRect(pSqX + sqSize + 2, sqY, sqSize, sqSize);
  ctx.strokeRect(pSqX + sqSize + 2, sqY, sqSize, sqSize);

  if (!state.nightmareMode) {
    const eSqX = CANVAS_W - padding - barW - sqGap - sqSize * 2 - 2;
    ctx.fillStyle = state.enemy.colors.gloves;
    ctx.fillRect(eSqX, sqY, sqSize, sqSize);
    ctx.strokeRect(eSqX, sqY, sqSize, sqSize);

    ctx.fillStyle = state.enemy.colors.trunks;
    ctx.fillRect(eSqX + sqSize + 2, sqY, sqSize, sqSize);
    ctx.strokeRect(eSqX + sqSize + 2, sqY, sqSize, sqSize);
  }

  const cmY = barY + barH + 3;
  const cmH = 6;
  drawChargeMeter(ctx, padding, cmY, barW, cmH, state.player, true);
  if (!state.nightmareMode) {
    drawChargeMeter(ctx, CANVAS_W - padding - barW, cmY, barW, cmH, state.enemy, false);
  }

  ctx.font = "bold 11px 'Oxanium', sans-serif";
  ctx.textAlign = "left";
  const playerNameText = `${state.player.name} (LV ${state.player.level})`;
  if (state.midFightLevelUps > 0) {
    const nameOnly = `${state.player.name} (LV `;
    const levelOnly = `${state.player.level}`;
    const closeParen = `)`;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(nameOnly, padding, barY - 4);
    const nameW = ctx.measureText(nameOnly).width;
    ctx.fillStyle = "#22cc44";
    ctx.fillText(levelOnly, padding + nameW, barY - 4);
    const lvW = ctx.measureText(levelOnly).width;
    ctx.fillStyle = "#ffffff";
    ctx.fillText(closeParen, padding + nameW + lvW, barY - 4);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.fillText(playerNameText, padding, barY - 4);
  }
  // Player southpaw badge
  if (state.player.boxingStance === "southpaw") {
    const nameW2 = ctx.measureText(playerNameText).width;
    ctx.font = "bold 9px 'Oxanium', sans-serif";
    ctx.fillStyle = "#f0c040";
    ctx.textAlign = "left";
    ctx.fillText("Southpaw", padding + nameW2 + 5, barY - 4);
    ctx.font = "bold 11px 'Oxanium', sans-serif";
  }
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "right";
  if (state.nightmareMode) {
    ctx.fillStyle = "#ff6666";
    ctx.font = "bold 11px 'Oxanium', sans-serif";
    ctx.fillText("NIGHTMARE", CANVAS_W - padding, barY - 4);
  } else {
    ctx.fillText(`${state.enemy.name} (LV ${state.enemy.level})`, CANVAS_W - padding, barY - 4);
    // Enemy southpaw badge
    if (state.enemy.boxingStance === "southpaw") {
      const enemyNameText = `${state.enemy.name} (LV ${state.enemy.level})`;
      const enemyNameW = ctx.measureText(enemyNameText).width;
      ctx.font = "bold 9px 'Oxanium', sans-serif";
      ctx.fillStyle = "#f0c040";
      ctx.textAlign = "right";
      ctx.fillText("Southpaw", CANVAS_W - padding - enemyNameW - 5, barY - 4);
      ctx.font = "bold 11px 'Oxanium', sans-serif";
    }
  }

  ctx.textAlign = "center";
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 14px 'Oxanium', sans-serif";
  const roundText = `R${state.currentRound} of ${state.totalRounds}`;
  ctx.fillText(roundText, CANVAS_W / 2, barY - 2);

  const minutes = Math.floor(state.roundTimer / 60);
  const seconds = Math.floor(state.roundTimer % 60);
  const timeStr = `${minutes}:${seconds.toString().padStart(2, "0")}`;
  ctx.font = "bold 20px 'Oxanium', sans-serif";
  ctx.fillStyle = state.roundTimer < 10 ? "#ff4444" : "#ffffff";
  ctx.fillText(timeStr, CANVAS_W / 2, barY + 18);

  ctx.font = "10px 'Oxanium', sans-serif";
  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.textAlign = "center";
  if (state.nightmareMode) {
    ctx.fillStyle = "#ffaaaa";
    ctx.fillText(`KOs: ${state.nightmareKillCount}`, CANVAS_W / 2, barY + 35);
  } else {
    ctx.fillText(`KD: ${state.player.knockdowns}`, CANVAS_W / 2 - 35, barY + 35);
    ctx.fillText(`KD: ${state.enemy.knockdowns}`, CANVAS_W / 2 + 35, barY + 35);
  }

  if (state.player.defenseState === "fullGuard") {
    ctx.fillStyle = "rgba(100, 150, 255, 0.8)";
    ctx.font = "bold 9px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("FULL GUARD", padding, barY + 35);
    const remaining = Math.max(0, state.player.maxBlockDuration - state.player.blockTimer);
    ctx.fillStyle = "rgba(255,255,255,0.4)";
    ctx.font = "7px 'Oxanium', sans-serif";
    ctx.fillText(`${Math.ceil(remaining)}s`, padding + 60, barY + 35);
  }

  const rhythmY = barY + 42;
  if (state.player.autoGuardActive && state.player.autoGuardDuration > 0) {
    const agW = 50;
    const agH = 5;
    const pct = Math.max(0, Math.min(1, state.player.autoGuardTimer / state.player.autoGuardDuration));
    ctx.fillStyle = "rgba(80, 80, 80, 0.65)";
    ctx.fillRect(padding, rhythmY, agW, agH);
    ctx.fillStyle = "rgba(230, 210, 80, 0.85)";
    ctx.fillRect(padding, rhythmY, agW * pct, agH);
    ctx.strokeStyle = "rgba(200, 190, 100, 0.7)";
    ctx.lineWidth = 0.5;
    ctx.strokeRect(padding, rhythmY, agW, agH);
    ctx.font = "7px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(230, 210, 80, 0.9)";
    ctx.fillText("AUTO", padding + agW + 3, rhythmY + 4);
  }

  drawPauseButton(ctx);

  if (state.showExpBar) {
    drawExpBarOverlay(ctx, state);
  }
}

/**
 * The orange "-N max stamina" tick that rises out of a stamina bar whenever that
 * fighter's pool shrinks. Anchored to the bar's *inner* edge, because the fighter
 * name is pinned to the outer edge -- a long name would otherwise sit under it.
 * The enemy's ticks are already filtered at source by the Focus gate; the only
 * check left here is Nightmare, where the enemy bar itself is not drawn.
 */
function drawMaxStaminaDeltaTexts(ctx: CanvasRenderingContext2D, state: GameState, padding: number, barW: number, barY: number): void {
  // Same reason as the engine-side backfill: a state that predates this field can
  // reach a render before the first update tick has had a chance to fill it in.
  if (!state.maxStaminaDeltaTexts || state.maxStaminaDeltaTexts.length === 0) return;
  ctx.save();
  ctx.font = "bold 11px 'Oxanium', sans-serif";
  state.maxStaminaDeltaTexts.forEach(t => {
    if (t.side === "enemy" && state.nightmareMode) return;
    const life = Math.max(0, Math.min(1, t.timer / MAX_STAMINA_DELTA_TEXT_LIFETIME));
    ctx.globalAlpha = Math.min(1, life * 2.5);
    const gained = t.delta > 0;
    ctx.fillStyle = gained ? "#35d46a" : "#ff7a18";
    const label = `${gained ? "+" : "-"}${Math.abs(t.delta)}`;
    // Its own lane ABOVE the name row (names sit at barY - 4 in 11px, so they
    // occupy roughly barY-15..barY-4). Anchoring to the bar's inner edge is not
    // enough on its own -- a long name reaches across and the name is painted
    // after this, so it would win the overlap.
    const ty = barY - 20 - (1 - life) * 18;
    if (t.side === "player") {
      ctx.textAlign = "right";
      ctx.fillText(label, padding + barW, ty);
    } else {
      ctx.textAlign = "left";
      ctx.fillText(label, CANVAS_W - padding - barW, ty);
    }
  });
  ctx.restore();
}

function drawStaminaBar(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fighter: FighterState, isPlayer: boolean, glowBlue = false): void {
  ctx.fillStyle = COLORS.staminaBg;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3);
  ctx.fill();

  const frac = Math.max(0, fighter.stamina / fighter.maxStamina);
  const fillColor = glowBlue ? "#3b82f6" : (frac > 0.5 ? "#22aa44" : (frac > 0.15 ? "#ccaa22" : "#cc2222"));

  const grad = ctx.createLinearGradient(x, y, x, y + h);
  grad.addColorStop(0, fillColor);
  grad.addColorStop(1, shadeColor(fillColor, -30));
  ctx.fillStyle = grad;

  const fillW = w * frac;
  const fillX = isPlayer ? x : x + w - fillW;
  ctx.beginPath();
  ctx.roundRect(fillX, y, fillW, h, 3);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 3);
  ctx.stroke();

  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "bold 10px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(`${Math.round(fighter.stamina)}/${Math.round(fighter.maxStamina)}`, x + w / 2, y + h - 4);
}

function drawChargeMeter(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, fighter: FighterState, isPlayer: boolean): void {
  const maxBars = 6;
  const gap = 2;
  const segW = (w - gap * (maxBars - 1)) / maxBars;

  for (let i = 0; i < maxBars; i++) {
    const segX = isPlayer ? x + i * (segW + gap) : x + w - (i + 1) * segW - i * gap;
    const filled = i < fighter.chargeMeterBars;
    const partial = i === fighter.chargeMeterBars ? fighter.chargeMeterCounters / 100 : 0;

    ctx.fillStyle = "rgba(0,0,0,0.4)";
    ctx.fillRect(segX, y, segW, h);

    if (filled) {
      const grad = ctx.createLinearGradient(segX, y, segX, y + h);
      grad.addColorStop(0, "#3388ff");
      grad.addColorStop(1, "#1155cc");
      ctx.fillStyle = grad;
      ctx.fillRect(segX, y, segW, h);
    } else if (partial > 0) {
      const fillW = segW * partial;
      const partX = isPlayer ? segX : segX + segW - fillW;
      ctx.fillStyle = "rgba(51,136,255,0.5)";
      ctx.fillRect(partX, y, fillW, h);
    }
  }
}

function drawCountdown(ctx: CanvasRenderingContext2D, timer: number): void {
  const count = Math.ceil(timer);
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.4)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  const frac = timer - Math.floor(timer);
  const scale = 1 + frac * 0.5;

  ctx.translate(CANVAS_W / 2, CANVAS_H / 2 - 30);
  ctx.scale(scale, scale);

  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 72px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.globalAlpha = 0.5 + frac * 0.5;
  ctx.fillText(count <= 0 ? "FIGHT!" : count.toString(), 0, 0);
  ctx.restore();
}

// Big Shot (charged + held + crit + stun) and Rocker Shot share this banner:
// slams in, holds, then fades.
function drawBigShotBanner(
  ctx: CanvasRenderingContext2D, timer: number, text = "BIG SHOT",
  colors: [string, string, string] = ["#fff3c4", "#ffb020", "#e02a1c"],
): void {
  const age = BIG_SHOT_TEXT_DURATION - timer;
  const slam = Math.min(1, age / 0.14);
  const scale = 2.2 - 1.2 * slam * slam;
  const alpha = Math.min(1, timer / 0.35);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(CANVAS_W / 2, CANVAS_H / 2 - 60);
  ctx.scale(scale, scale);
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = "bold 54px 'Oxanium', sans-serif";

  ctx.lineWidth = 8;
  ctx.strokeStyle = "#1a0505";
  ctx.strokeText(text, 0, 0);

  const grad = ctx.createLinearGradient(0, -28, 0, 28);
  grad.addColorStop(0, colors[0]);
  grad.addColorStop(0.5, colors[1]);
  grad.addColorStop(1, colors[2]);
  ctx.fillStyle = grad;
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function drawKnockdownOverlay(ctx: CanvasRenderingContext2D, state: GameState): void {
  ctx.save();

  ctx.font = "18px 'Oxanium', sans-serif";
  ctx.fillStyle = "#cccccc";
  ctx.textAlign = "center";
  ctx.fillText("KNOCKDOWN!", CANVAS_W / 2, 30);

  // Hide the count while the fall animation is still playing
  if (state.knockdownRefCount > 0) {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 64px 'Oxanium', sans-serif";
    ctx.fillText(state.knockdownRefCount.toString(), CANVAS_W / 2, 80);
  }

  const knockedFighter = state.player.isKnockedDown ? state.player : state.enemy;
  if (knockedFighter.isPlayer) {
    ctx.font = "16px 'Oxanium', sans-serif";
    ctx.fillStyle = "#ffcc00";
    const kdTextY = 120;
    ctx.fillText(`MASH SPACE! ${state.knockdownMashCount} / ${state.knockdownMashRequired}`, CANVAS_W / 2, kdTextY);

    const barW = 200;
    const barH = 10;
    const barX = CANVAS_W / 2 - barW / 2;
    const barFY = kdTextY + 10;
    ctx.fillStyle = "rgba(255,255,255,0.2)";
    ctx.fillRect(barX, barFY, barW, barH);
    const progress = Math.min(1, state.knockdownMashCount / state.knockdownMashRequired);
    ctx.fillStyle = "#00ff88";
    ctx.fillRect(barX, barFY, barW * progress, barH);
  }

  ctx.restore();
}

const PAUSE_BTN_X = CANVAS_W - 35;
const PAUSE_BTN_Y = 10;
const PAUSE_BTN_SIZE = 24;

function drawPauseButton(ctx: CanvasRenderingContext2D): void {
  ctx.save();
  ctx.fillStyle = "rgba(255,255,255,0.3)";
  ctx.beginPath();
  ctx.roundRect(PAUSE_BTN_X, PAUSE_BTN_Y, PAUSE_BTN_SIZE, PAUSE_BTN_SIZE, 4);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.8)";
  const barW = 4;
  const barH = 12;
  const gap = 3;
  const cx = PAUSE_BTN_X + PAUSE_BTN_SIZE / 2;
  const cy = PAUSE_BTN_Y + PAUSE_BTN_SIZE / 2;
  ctx.fillRect(cx - gap - barW, cy - barH / 2, barW, barH);
  ctx.fillRect(cx + gap, cy - barH / 2, barW, barH);
  ctx.restore();
}

export function isPauseButtonClick(x: number, y: number): boolean {
  return x >= PAUSE_BTN_X && x <= PAUSE_BTN_X + PAUSE_BTN_SIZE &&
    y >= PAUSE_BTN_Y && y <= PAUSE_BTN_Y + PAUSE_BTN_SIZE;
}

const PAUSE_MENU_ITEM_W = 200;
const PAUSE_MENU_ITEM_H = 30;
const PAUSE_MENU_START_Y = CANVAS_H / 2 - 25;
const PAUSE_MENU_SPACING = 36;
const PAUSE_MENU_ITEMS_FULL = ["Resume", "Controls", "Sound", "Restart", "Quit"];
const PAUSE_MENU_ITEMS_CAREER = ["Resume", "Bout Details", "Controls", "Sound", "Quit"];

export function getPauseItems(isCareer: boolean, state?: GameState): string[] {
  if (state?.tutorialMode) {
    return ["Resume", "Restart Tutorial", "Quit"];
  }
  if (state?.practiceMode) {
    return [
      "Resume",
      `CPU Attacks: ${state.cpuAttacksEnabled ? "ON" : "OFF"}`,
      `CPU Defense: ${state.cpuDefenseEnabled ? "ON" : "OFF"}`,
      "Controls",
      "Sound",
      "Restart",
      "Quit",
    ];
  }
  if (isCareer && state?.doghouseMode && (state.doghouseOpponentsDefeated ?? 0) >= 2) {
    return ["Resume", "Bout Details", "Controls", "Sound", "Finish Early", "Quit"];
  }
  return isCareer ? PAUSE_MENU_ITEMS_CAREER : PAUSE_MENU_ITEMS_FULL;
}

const SOUND_SLIDER_W = 200;
const SOUND_SLIDER_H = 8;
const SOUND_SLIDER_X = CANVAS_W / 2 - SOUND_SLIDER_W / 2;
const SOUND_CATEGORIES: { label: string; key: "master" | "sfx" | "crowd" | "ui" }[] = [
  { label: "Master", key: "master" },
  { label: "SFX", key: "sfx" },
  { label: "Crowd", key: "crowd" },
  { label: "UI", key: "ui" },
];
const SOUND_SLIDER_START_Y = CANVAS_H / 2 - 90;
const SOUND_SLIDER_SPACING = 50;

export function getPauseMenuClickIndex(x: number, y: number, isCareer: boolean = false, state?: GameState): number {
  const items = getPauseItems(isCareer, state);
  for (let i = 0; i < items.length; i++) {
    const itemY = PAUSE_MENU_START_Y + i * PAUSE_MENU_SPACING;
    const left = CANVAS_W / 2 - PAUSE_MENU_ITEM_W / 2;
    if (x >= left && x <= left + PAUSE_MENU_ITEM_W &&
      y >= itemY - PAUSE_MENU_ITEM_H / 2 && y <= itemY + PAUSE_MENU_ITEM_H / 2) {
      return i;
    }
  }
  return -1;
}

export function getSoundSliderClick(x: number, y: number): { key: "master" | "sfx" | "crowd" | "ui"; value: number } | null {
  for (let i = 0; i < SOUND_CATEGORIES.length; i++) {
    const sliderY = SOUND_SLIDER_START_Y + i * SOUND_SLIDER_SPACING + 20;
    if (x >= SOUND_SLIDER_X && x <= SOUND_SLIDER_X + SOUND_SLIDER_W &&
      y >= sliderY - 12 && y <= sliderY + 12) {
      const value = Math.max(0, Math.min(1, (x - SOUND_SLIDER_X) / SOUND_SLIDER_W));
      return { key: SOUND_CATEGORIES[i].key, value };
    }
  }
  const muteY = SOUND_SLIDER_START_Y + SOUND_CATEGORIES.length * SOUND_SLIDER_SPACING + 10;
  const muteW = 120;
  const muteLeft = CANVAS_W / 2 - muteW / 2;
  if (x >= muteLeft && x <= muteLeft + muteW && y >= muteY - 15 && y <= muteY + 15) {
    return { key: "master", value: -1 };
  }
  const backY = muteY + 45;
  const backW = 120;
  const backLeft = CANVAS_W / 2 - backW / 2;
  if (x >= backLeft && x <= backLeft + backW && y >= backY - 15 && y <= backY + 15) {
    return { key: "master", value: -2 };
  }
  return null;
}

// Shared by the overlay and its Back hit box. Two columns of grouped rows:
// defence and rhythm on the left, attacks on the right.
type ControlsGroup = { title: string; rows: [string, string][] };

const CONTROLS_COLUMNS: ControlsGroup[][] = [
  [
    {
      title: "MOVE & DEFEND",
      rows: [
        ["Move", "Arrow Keys"],
        ["Duck", "Shift"],
        ["Slip", "Hold C + Arrow Keys"],
        ["Reset", "B"],
        ["Toggle Guard", "Space"],
        ["Full Guard", "Space x2"],
        ["Block Up/Down", "Space + Arrow"],
        ["Perfect Block", "V"],
      ],
    },
    {
      title: "MENU",
      rows: [
        ["Pause", "Esc"],
      ],
    },
  ],
  [
    {
      title: "ATTACK",
      rows: [
        ["Jab", "W"],
        ["Cross", "E"],
        ["L Hook", "Q"],
        ["R Hook", "R"],
        ["L Upper", "S"],
        ["R Upper", "D"],
        ["Body Shot", "Shift + Punch"],
        ["Held Punch", "Hold Punch Key, then Release"],
        ["Charge Punch", "A, then Punch"],
        ["Feint", "F, then Punch"],
      ],
    },
  ],
];

const CONTROLS_TOP_Y = 92;
const CONTROLS_COL_W = 350;
const CONTROLS_COL_GAP = 24;
const CONTROLS_PAD_X = 16;
const CONTROLS_HEADER_H = 30;
const CONTROLS_ROW_H = 24;
const CONTROLS_GROUP_GAP = 18;

function controlsColumnHeight(groups: ControlsGroup[]): number {
  return groups.reduce((h, g, i) => h + (i > 0 ? CONTROLS_GROUP_GAP : 0) + CONTROLS_HEADER_H + g.rows.length * CONTROLS_ROW_H, 0);
}

function drawControlsOverlay(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("CONTROLS", CANVAS_W / 2, 50);

  const totalW = CONTROLS_COLUMNS.length * CONTROLS_COL_W + (CONTROLS_COLUMNS.length - 1) * CONTROLS_COL_GAP;
  const left0 = (CANVAS_W - totalW) / 2;

  CONTROLS_COLUMNS.forEach((groups, c) => {
    const x = left0 + c * (CONTROLS_COL_W + CONTROLS_COL_GAP);
    let y = CONTROLS_TOP_Y;
    groups.forEach((group, gi) => {
      if (gi > 0) y += CONTROLS_GROUP_GAP;
      const boxH = CONTROLS_HEADER_H + group.rows.length * CONTROLS_ROW_H;
      ctx.fillStyle = "rgba(255, 255, 255, 0.05)";
      ctx.beginPath();
      ctx.roundRect(x, y, CONTROLS_COL_W, boxH, 6);
      ctx.fill();

      ctx.fillStyle = "#ffcc44";
      ctx.font = "bold 12px 'Oxanium', sans-serif";
      ctx.textAlign = "left";
      ctx.fillText(group.title, x + CONTROLS_PAD_X, y + CONTROLS_HEADER_H / 2 + 1);
      ctx.fillStyle = "rgba(255, 204, 68, 0.3)";
      ctx.fillRect(x + CONTROLS_PAD_X, y + CONTROLS_HEADER_H - 2, CONTROLS_COL_W - CONTROLS_PAD_X * 2, 1);

      ctx.font = "14px 'Oxanium', sans-serif";
      group.rows.forEach(([label, value], i) => {
        const rowY = y + CONTROLS_HEADER_H + i * CONTROLS_ROW_H + CONTROLS_ROW_H / 2;
        ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
        ctx.textAlign = "left";
        ctx.fillText(label, x + CONTROLS_PAD_X, rowY);
        ctx.fillStyle = "#ffffff";
        ctx.textAlign = "right";
        ctx.fillText(value, x + CONTROLS_COL_W - CONTROLS_PAD_X, rowY);
      });
      y += boxH;
    });
  });

  const backY = controlsBackY();
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = "bold 16px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("[ Back ]", CANVAS_W / 2, backY);
}

function controlsBackY(): number {
  return CONTROLS_TOP_Y + Math.max(...CONTROLS_COLUMNS.map(controlsColumnHeight)) + 36;
}

export function getControlsBackClick(x: number, y: number): boolean {
  const backY = controlsBackY();
  const backW = 120;
  const backLeft = CANVAS_W / 2 - backW / 2;
  return x >= backLeft && x <= backLeft + backW && y >= backY - 15 && y <= backY + 15;
}

function drawPauseMenu(ctx: CanvasRenderingContext2D, selectedIndex: number, soundTab: boolean, controlsTab: boolean, isCareer: boolean = false, state?: GameState): void {
  ctx.save();
  ctx.fillStyle = "rgba(0, 0, 0, 0.75)";
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  if (state?.pauseBoutDetailsTab) {
    ctx.restore();
    return;
  }

  const menuItems = getPauseItems(isCareer, state);

  if (controlsTab) {
    drawControlsOverlay(ctx);
  } else if (soundTab) {
    drawSoundControls(ctx);
  } else {
    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 36px 'Oxanium', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("PAUSED", CANVAS_W / 2, CANVAS_H / 2 - 100);

    menuItems.forEach((item, i) => {
      const y = PAUSE_MENU_START_Y + i * PAUSE_MENU_SPACING;
      const isSelected = i === selectedIndex;

      if (isSelected) {
        ctx.fillStyle = "rgba(255, 200, 50, 0.15)";
        ctx.beginPath();
        ctx.roundRect(CANVAS_W / 2 - PAUSE_MENU_ITEM_W / 2, y - PAUSE_MENU_ITEM_H / 2, PAUSE_MENU_ITEM_W, PAUSE_MENU_ITEM_H, 4);
        ctx.fill();
      }

      const isToggleOn = item.endsWith(": ON");
      const isToggleOff = item.endsWith(": OFF");
      if (isSelected) {
        ctx.fillStyle = isToggleOff ? "#ff6666" : isToggleOn ? "#66ff88" : "#ffcc44";
      } else {
        ctx.fillStyle = isToggleOff ? "rgba(255, 100, 100, 0.5)" : isToggleOn ? "rgba(100, 255, 130, 0.5)" : "rgba(255, 255, 255, 0.6)";
      }
      ctx.font = isSelected ? "bold 20px 'Oxanium', sans-serif" : "18px 'Oxanium', sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(item, CANVAS_W / 2, y);
    });

    ctx.fillStyle = "rgba(255, 255, 255, 0.3)";
    ctx.font = "11px 'Oxanium', sans-serif";
    ctx.fillText("Click or use arrow keys + Enter", CANVAS_W / 2, CANVAS_H / 2 + 130);
  }

  ctx.restore();
}

function drawSoundControls(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("SOUND SETTINGS", CANVAS_W / 2, SOUND_SLIDER_START_Y - 50);

  const volumes = soundEngine.getVolumes();
  const isMuted = soundEngine.isMuted();

  SOUND_CATEGORIES.forEach((cat, i) => {
    const y = SOUND_SLIDER_START_Y + i * SOUND_SLIDER_SPACING;
    const sliderY = y + 20;
    const vol = volumes[cat.key];

    ctx.fillStyle = "rgba(255, 255, 255, 0.7)";
    ctx.font = "14px 'Oxanium', sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(cat.label, SOUND_SLIDER_X, y + 4);

    ctx.fillStyle = `rgba(255, 255, 255, ${isMuted ? 0.15 : 0.25})`;
    ctx.font = "12px 'Oxanium', sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(`${Math.round(vol * 100)}%`, SOUND_SLIDER_X + SOUND_SLIDER_W, y + 4);

    ctx.fillStyle = "rgba(255, 255, 255, 0.15)";
    ctx.beginPath();
    ctx.roundRect(SOUND_SLIDER_X, sliderY - SOUND_SLIDER_H / 2, SOUND_SLIDER_W, SOUND_SLIDER_H, 4);
    ctx.fill();

    const fillW = vol * SOUND_SLIDER_W;
    ctx.fillStyle = isMuted ? "rgba(100, 100, 100, 0.5)" : "rgba(255, 200, 50, 0.8)";
    ctx.beginPath();
    ctx.roundRect(SOUND_SLIDER_X, sliderY - SOUND_SLIDER_H / 2, fillW, SOUND_SLIDER_H, 4);
    ctx.fill();

    const knobX = SOUND_SLIDER_X + fillW;
    ctx.fillStyle = isMuted ? "#888" : "#ffcc44";
    ctx.beginPath();
    ctx.arc(knobX, sliderY, 6, 0, Math.PI * 2);
    ctx.fill();
  });

  const muteY = SOUND_SLIDER_START_Y + SOUND_CATEGORIES.length * SOUND_SLIDER_SPACING + 10;
  const muteW = 120;
  const muteLeft = CANVAS_W / 2 - muteW / 2;
  ctx.fillStyle = isMuted ? "rgba(255, 80, 80, 0.3)" : "rgba(255, 255, 255, 0.1)";
  ctx.beginPath();
  ctx.roundRect(muteLeft, muteY - 15, muteW, 30, 4);
  ctx.fill();
  ctx.fillStyle = isMuted ? "#ff6666" : "rgba(255, 255, 255, 0.7)";
  ctx.font = "14px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(isMuted ? "UNMUTE" : "MUTE ALL", CANVAS_W / 2, muteY);

  const backY = muteY + 45;
  const backW = 120;
  const backLeft = CANVAS_W / 2 - backW / 2;
  ctx.fillStyle = "rgba(255, 200, 50, 0.15)";
  ctx.beginPath();
  ctx.roundRect(backLeft, backY - 15, backW, 30, 4);
  ctx.fill();
  ctx.fillStyle = "#ffcc44";
  ctx.font = "bold 14px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("← BACK", CANVAS_W / 2, backY);
}

/**
 * Sparring headgear colours for the AI. Matches the difficulty colour language
 * used elsewhere in the app, so the partner's headgear reads as the difficulty
 * the session was booked at.
 */
export const SPARRING_HEADGEAR_BY_DIFFICULTY: Record<string, string> = {
  journeyman: "#22aa44",
  contender: "#ddaa00",
  elite: "#cc4400",
  champion: "#cc2222",
};

export const DEFAULT_HEADGEAR_COLOR = "#2244aa";

/** Picks a light or dark accent so trim stays visible against any base colour. */
function contrastInk(hex: string, light: string, dark: string): string {
  const [r, g, b] = parseHex(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? dark : light;
}

/**
 * High-top boxing shoe: rubber sole, laced instep, ankle collar and heel tab.
 * `unit` is one FIGHTER_SCALE step for the leg being drawn, `dir` the facing
 * (+1 toe pointing right). `plain` drops the collar and laces for the referee.
 */
/**
 * Colour the laces fall back to when a fighter has not picked one: a light or
 * dark ink chosen for contrast against the shoe.  Exported so the colour
 * editors can seed their picker with exactly what the canvas would draw.
 */
export function defaultLaceColor(shoeColor: string): string {
  return contrastInk(shoeColor, "#f0ece0", "#26262a");
}

/** Sole colour used when a fighter has not picked one. */
export function defaultSoleColor(shoeColor: string): string {
  return contrastInk(shoeColor, "#e4e0d6", "#2a2a2c");
}

/** Waist-stripe colour used when a fighter has not picked one. */
export function defaultWaistStripeColor(trunksColor: string): string {
  return shadeColor(trunksColor, 30);
}

function shadeColor(color: string, percent: number): string {
  const num = parseInt((isSpacial(color) ? SPACIAL_BASE_HEX : color).replace("#", ""), 16);
  if (isNaN(num)) return color;
  const r = Math.min(255, Math.max(0, (num >> 16) + percent));
  const g = Math.min(255, Math.max(0, ((num >> 8) & 0x00ff) + percent));
  const b = Math.min(255, Math.max(0, (num & 0x0000ff) + percent));
  // Hex, not `rgb(...)`: shaded colours seed the gear colour pickers (the waist
  // stripe follows the trunks), and <input type="color"> only accepts #rrggbb —
  // an rgb() string collapses the swatch and leaks into the value label.
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
}

const TUTORIAL_CONTINUE_BTN_W = 160;
const TUTORIAL_CONTINUE_BTN_H = 36;
const TUTORIAL_CONTINUE_BTN_X = CANVAS_W / 2 - TUTORIAL_CONTINUE_BTN_W / 2;
const TUTORIAL_CONTINUE_BTN_Y = CANVAS_H / 2 + 60;

function drawTutorialPrompt(ctx: CanvasRenderingContext2D, state: GameState): void {
  const prompt = state.tutorialPrompt;
  if (!prompt) return;

  ctx.save();

  if (state.tutorialShowContinueButton) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    ctx.fillStyle = "#ffffff";
    ctx.font = "bold 16px 'Oxanium', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";

    const maxW = CANVAS_W - 80;
    const words = prompt.split(" ");
    const lines: string[] = [];
    let currentLine = "";
    for (const word of words) {
      const test = currentLine ? currentLine + " " + word : word;
      if (ctx.measureText(test).width > maxW) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);

    const lineH = 24;
    const startY = CANVAS_H / 2 - (lines.length * lineH) / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], CANVAS_W / 2, startY + i * lineH);
    }

    ctx.fillStyle = "rgba(255, 200, 50, 0.9)";
    const bx = TUTORIAL_CONTINUE_BTN_X;
    const by = TUTORIAL_CONTINUE_BTN_Y;
    ctx.beginPath();
    ctx.roundRect(bx, by, TUTORIAL_CONTINUE_BTN_W, TUTORIAL_CONTINUE_BTN_H, 6);
    ctx.fill();

    ctx.fillStyle = "#000000";
    ctx.font = "bold 16px 'Oxanium', sans-serif";
    ctx.fillText("Continue", CANVAS_W / 2, by + TUTORIAL_CONTINUE_BTN_H / 2);
  } else {
    const maxTextW = CANVAS_W - 60;
    let fontSize = 20;
    ctx.font = `bold ${fontSize}px 'Oxanium', sans-serif`;
    if (ctx.measureText(prompt).width > maxTextW) {
      fontSize = 16;
      ctx.font = `bold ${fontSize}px 'Oxanium', sans-serif`;
    }
    if (ctx.measureText(prompt).width > maxTextW) {
      fontSize = 14;
      ctx.font = `bold ${fontSize}px 'Oxanium', sans-serif`;
    }

    const words = prompt.split(" ");
    const lines: string[] = [];
    let currentLine = "";
    for (const word of words) {
      const test = currentLine ? currentLine + " " + word : word;
      if (ctx.measureText(test).width > maxTextW) {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = test;
      }
    }
    if (currentLine) lines.push(currentLine);

    const lineH = fontSize + 6;
    const padV = 10;
    const bgH = lines.length * lineH + padV * 2;
    const bgY = 50;

    let bgW = 0;
    for (const line of lines) {
      const w = ctx.measureText(line).width;
      if (w > bgW) bgW = w;
    }
    bgW = Math.min(bgW + 40, CANVAS_W - 20);

    ctx.fillStyle = "rgba(0, 0, 0, 0.65)";
    ctx.beginPath();
    ctx.roundRect(CANVAS_W / 2 - bgW / 2, bgY, bgW, bgH, 8);
    ctx.fill();

    ctx.fillStyle = "#ffcc44";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const startY = bgY + padV + lineH / 2;
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], CANVAS_W / 2, startY + i * lineH);
    }
  }

  // Stage 3 rhythm indicator visual hints
  if (state.tutorialStage === 3) {
    if (state.tutorialShowContinueButton && (state.tutorialStep === 3 || state.tutorialStep === 5)) {
      const drawRhythmDemo = (x: number, y: number, label: string, sublabel: string, widerGreen: boolean) => {
        const rW = 60;
        const rH = 8;
        const cx = x + rW / 2;
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.beginPath();
        ctx.roundRect(x, y, rW, rH, 2);
        ctx.fill();
        const gFrac = widerGreen ? 0.36 : 0.22;
        const gX = x + rW * (0.5 - gFrac / 2);
        const gW = rW * gFrac;
        ctx.fillStyle = "rgba(80, 220, 80, 0.85)";
        ctx.beginPath();
        ctx.roundRect(gX, y, gW, rH, 2);
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.45)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.roundRect(x, y, rW, rH, 2);
        ctx.stroke();
        const pulse = (Math.sin(Date.now() / 260) + 1) / 2;
        ctx.strokeStyle = `rgba(80, 220, 80, ${0.45 + pulse * 0.5})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.roundRect(gX - 2, y - 2, gW + 4, rH + 4, 3);
        ctx.stroke();
        ctx.fillStyle = "rgba(255,220,80,0.95)";
        ctx.font = "bold 10px 'Oxanium', sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(label, cx, y - 6);
        ctx.fillStyle = "rgba(180,180,180,0.85)";
        ctx.font = "9px 'Oxanium', sans-serif";
        ctx.fillText(sublabel, cx, y + rH + 12);
      };
      if (state.tutorialStep === 3) {
        drawRhythmDemo(30, CANVAS_H - 105, "YOUR RHYTHM", "Speed narrows green zone", false);
        ctx.fillStyle = "rgba(255,220,80,0.75)";
        ctx.font = "bold 11px 'Oxanium', sans-serif";
        ctx.textAlign = "left";
        ctx.fillText("↙ bottom-left in fight", 15, CANVAS_H - 55);
      } else {
        drawRhythmDemo(CANVAS_W - 100, CANVAS_H - 105, "ENEMY RHYTHM", "Focus widens green zone", true);
        ctx.fillStyle = "rgba(255,220,80,0.75)";
        ctx.font = "bold 11px 'Oxanium', sans-serif";
        ctx.textAlign = "right";
        ctx.fillText("bottom-right in fight ↘", CANVAS_W - 15, CANVAS_H - 55);
      }
    } else if (!state.tutorialShowContinueButton && state.tutorialStep === 6) {
      const eRhythmX = CANVAS_W - 15 - 50;
      const eRhythmCX = eRhythmX + 25;
      const rhY = (CANVAS_H - 70) + 15 + 42;
      const pulse = (Math.sin(Date.now() / 180) + 1) / 2;
      const alpha = 0.5 + pulse * 0.5;
      ctx.strokeStyle = `rgba(100, 255, 100, ${alpha})`;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.roundRect(eRhythmX - 3, rhY - 3, 56, 12, 3);
      ctx.stroke();
      ctx.fillStyle = `rgba(100, 255, 100, ${alpha})`;
      ctx.beginPath();
      ctx.moveTo(eRhythmCX, rhY - 6);
      ctx.lineTo(eRhythmCX - 8, rhY - 24);
      ctx.lineTo(eRhythmCX + 8, rhY - 24);
      ctx.closePath();
      ctx.fill();
      ctx.fillStyle = "rgba(100, 255, 100, 0.9)";
      ctx.font = "bold 10px 'Oxanium', sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Enemy Rhythm", eRhythmCX, rhY - 28);
    }
  }

  ctx.restore();
}

export function getTutorialContinueClick(x: number, y: number): boolean {
  return (
    x >= TUTORIAL_CONTINUE_BTN_X &&
    x <= TUTORIAL_CONTINUE_BTN_X + TUTORIAL_CONTINUE_BTN_W &&
    y >= TUTORIAL_CONTINUE_BTN_Y &&
    y <= TUTORIAL_CONTINUE_BTN_Y + TUTORIAL_CONTINUE_BTN_H
  );
}
