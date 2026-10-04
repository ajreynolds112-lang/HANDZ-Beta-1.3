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
      const empowered = fighter.chargeEmpoweredTimer > 0;
      const grad = ctx.createLinearGradient(segX, y, segX, y + h);
      grad.addColorStop(0, empowered ? "#ffcc00" : "#3388ff");
      grad.addColorStop(1, empowered ? "#ff8800" : "#1155cc");
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

// The one-in-a-lifetime punch: charged, critical, stunning and straight through
// the rhythm. Slams in, holds, then fades with the knockdown it caused.
function drawBigShotBanner(ctx: CanvasRenderingContext2D, timer: number): void {
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
  ctx.strokeText("BIG SHOT", 0, 0);

  const grad = ctx.createLinearGradient(0, -28, 0, 28);
  grad.addColorStop(0, "#fff3c4");
  grad.addColorStop(0.5, "#ffb020");
  grad.addColorStop(1, "#e02a1c");
  ctx.fillStyle = grad;
  ctx.fillText("BIG SHOT", 0, 0);
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
const SOUND_CATEGORIES: { label: string; key: "master" | "sfx" | "crowd" | "ui" | "music" }[] = [
  { label: "Master", key: "master" },
  { label: "Music", key: "music" },
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

export function getSoundSliderClick(x: number, y: number): { key: "master" | "sfx" | "crowd" | "ui" | "music"; value: number } | null {
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

// Shared by the overlay and its Back hit box, so the button stays under the
// text when a line is added to the list.
const CONTROLS_ROWS: [string, string][] = [
  ["Move", "Arrow Keys"],
    ["Duck", "Shift"],
    ["Jab", "W"],
    ["Cross", "E"],
    ["L Hook", "Q"],
    ["R Hook", "R"],
    ["L Upper", "S"],
    ["R Upper", "D"],
    ["Body Shot", "Shift + Punch"],
    ["Charge Punch", "A, then Punch"],
    ["Feint", "F, then Punch"],
    ["Full Guard", "Space x2"],
    ["Block Up/Down", "Space + Arrow"],
    ["Perfect Block", "V"],
  ["Rhythm Up", "Tab + Right"],
  ["Rhythm Down", "Tab + Left"],
  ["Pause", "Esc"],
];

const CONTROLS_START_Y = 90;
const CONTROLS_LINE_H = 22;

function drawControlsOverlay(ctx: CanvasRenderingContext2D): void {
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 28px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("CONTROLS", CANVAS_W / 2, 50);

  const startY = CONTROLS_START_Y;
  const lineH = CONTROLS_LINE_H;
  const colLabelX = CANVAS_W / 2 - 20;
  const colValueX = CANVAS_W / 2 + 20;

  ctx.font = "14px 'Oxanium', sans-serif";
  CONTROLS_ROWS.forEach(([label, value], i) => {
    const y = startY + i * lineH;
    ctx.fillStyle = "rgba(255, 255, 255, 0.6)";
    ctx.textAlign = "right";
    ctx.fillText(label, colLabelX, y);
    ctx.fillStyle = "#ffcc44";
    ctx.textAlign = "left";
    ctx.fillText(value, colValueX, y);
  });

  const backY = controlsBackY();
  ctx.fillStyle = "rgba(255, 255, 255, 0.8)";
  ctx.font = "bold 16px 'Oxanium', sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("[ Back ]", CANVAS_W / 2, backY);
}

function controlsBackY(): number {
  return CONTROLS_START_Y + CONTROLS_ROWS.length * CONTROLS_LINE_H + 20;
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

/** Rounded-rectangle sub-path (hand-rolled: ctx.roundRect isn't universal). */
function roundedBoxPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
}

/** Picks a light or dark accent so trim stays visible against any base colour. */
function contrastInk(hex: string, light: string, dark: string): string {
  const [r, g, b] = parseHex(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? dark : light;
}

/**
 * Boxing mitt. Local space points the knuckles along +x, so the caller passes
 * an aim vector (normally elbow → glove) and the cuff always ends up on the
 * wrist side. `profile` (0..1) foreshortens the mitt along the aim axis: a
 * glove travelling at or away from the camera squashes into a fist coming at
 * you instead of staying a side-on mitt.
 */
export function drawBoxingGlove(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, r: number,
  aimX: number, aimY: number,
  gloveColor: string, tapeColor: string,
  profile: number,
  flat: boolean,
  bareFist: boolean = false,
  /**
   * Mirrors the thumb across the forearm axis. The mitt art is rotated, not
   * mirrored, so the two gloves of a fighter facing the camera end up with
   * their thumbs on opposite sides; the still canvases flip the right-hand
   * glove so both thumbs read inward.
   */
  flipThumb: boolean = false,
): void {
  const aimLen = Math.hypot(aimX, aimY);
  const ang = aimLen > 0.0001 ? Math.atan2(aimY, aimX) : 0;
  const squash = 0.62 + 0.38 * Math.min(1, Math.max(0, profile));

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  ctx.scale(squash, 1);

  const deep = shadeColor(gloveColor, -65);

  // The referee's "gloves" are bare hands — a plain fist, no cuff or wrap.
  if (bareFist) {
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 0.92, r * 0.86, 0, 0, Math.PI * 2);
    ctx.fillStyle = flat ? gloveColor : shadeColor(gloveColor, -8);
    ctx.fill();
    if (!flat) {
      ctx.strokeStyle = deep;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 0.7;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
    return;
  }

  // ── Wrist cuff, drawn first so the mitt overlaps its front edge ────────────
  const cuffBackX = -r * 1.3;
  const cuffFrontX = -r * 0.1;
  const cuffH = r * 0.6;
  ctx.beginPath();
  roundedBoxPath(ctx, cuffBackX, -cuffH, cuffFrontX - cuffBackX, cuffH * 2, r * 0.24);
  ctx.fillStyle = flat ? gloveColor : shadeColor(gloveColor, -22);
  ctx.fill();

  if (!flat) {
    // Hand wrap at the wrist end of the cuff — this is the editable tape colour.
    const tapeW = (cuffFrontX - cuffBackX) * 0.62;
    ctx.save();
    ctx.beginPath();
    roundedBoxPath(ctx, cuffBackX, -cuffH, cuffFrontX - cuffBackX, cuffH * 2, r * 0.24);
    ctx.clip();
    ctx.fillStyle = tapeColor;
    ctx.fillRect(cuffBackX, -cuffH, tapeW, cuffH * 2);
    // Overlapping wrap turns
    ctx.strokeStyle = shadeColor(tapeColor, -50);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.6;
    for (let i = 1; i <= 2; i++) {
      const bx = cuffBackX + (tapeW * i) / 3;
      ctx.beginPath();
      ctx.moveTo(bx + r * 0.14, -cuffH);
      ctx.lineTo(bx - r * 0.14, cuffH);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    // Shaded underside of the cuff
    ctx.fillStyle = "rgba(0,0,0,0.22)";
    ctx.fillRect(cuffBackX, cuffH * 0.35, cuffFrontX - cuffBackX, cuffH);
    ctx.restore();
    // Velcro strap edge where the wrap meets the leather
    ctx.strokeStyle = shadeColor(tapeColor, -60);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    ctx.moveTo(cuffBackX + tapeW, -cuffH);
    ctx.lineTo(cuffBackX + tapeW, cuffH);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = deep;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    roundedBoxPath(ctx, cuffBackX, -cuffH, cuffFrontX - cuffBackX, cuffH * 2, r * 0.24);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Mitt body ─────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(-r * 0.55, -r * 0.72);
  ctx.bezierCurveTo(-r * 0.1, -r * 1.12, r * 0.7, -r * 1.06, r * 0.98, -r * 0.5);
  ctx.bezierCurveTo(r * 1.26, -r * 0.06, r * 1.1, r * 0.62, r * 0.6, r * 0.86);
  ctx.bezierCurveTo(r * 0.2, r * 1.06, -r * 0.3, r * 0.98, -r * 0.55, r * 0.66);
  ctx.bezierCurveTo(-r * 0.8, r * 0.38, -r * 0.8, -r * 0.44, -r * 0.55, -r * 0.72);
  ctx.closePath();

  if (flat) {
    ctx.fillStyle = gloveColor;
  } else {
    const grad = ctx.createRadialGradient(
      -r * 0.25, -r * 0.45, r * 0.05,
      r * 0.15, r * 0.1, r * 1.4,
    );
    grad.addColorStop(0, shadeColor(gloveColor, 50));
    grad.addColorStop(0.5, shadeColor(gloveColor, 0));
    grad.addColorStop(1, shadeColor(gloveColor, -55));
    ctx.fillStyle = isSpacial(gloveColor) ? spacialPaint(ctx) : grad;
  }
  ctx.fill();

  if (!flat) {
    ctx.strokeStyle = deep;
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 0.7;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Knuckle seam
    ctx.strokeStyle = deep;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(r * 0.5, -r * 0.85);
    ctx.quadraticCurveTo(r * 0.8, 0, r * 0.42, r * 0.8);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Thumb
    const thumbSide = flipThumb ? -1 : 1;
    ctx.beginPath();
    ctx.ellipse(r * 0.05, r * 0.62 * thumbSide, r * 0.5, r * 0.33, -0.32 * thumbSide, 0, Math.PI * 2);
    ctx.fillStyle = shadeColor(gloveColor, -14);
    ctx.fill();
    ctx.strokeStyle = deep;
    ctx.globalAlpha = 0.4;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Leather highlight
    ctx.fillStyle = "rgba(255,255,255,0.16)";
    ctx.beginPath();
    ctx.ellipse(-r * 0.08, -r * 0.55, r * 0.42, r * 0.2, -0.25, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

/**
 * Ribbed boxing sock covering the lower shin. Drawn between the leg and the
 * shoe so the shoe's ankle collar overlaps its bottom edge.
 */
export function drawSock(
  ctx: CanvasRenderingContext2D,
  footX: number, footY: number,
  kneeX: number, kneeY: number,
  width: number,
  color: string,
  flat: boolean,
): void {
  const dx = kneeX - footX;
  const dy = kneeY - footY;
  const topT = 0.46;
  const topX = footX + dx * topT;
  const topY = footY + dy * topT;

  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(footX, footY);
  ctx.lineTo(topX, topY);
  ctx.stroke();

  if (!flat) {
    // Shaded far side
    ctx.strokeStyle = "rgba(0,0,0,0.18)";
    ctx.lineWidth = width * 0.4;
    ctx.beginPath();
    ctx.moveTo(footX + width * 0.28, footY);
    ctx.lineTo(topX + width * 0.28, topY);
    ctx.stroke();

    // Ribbed cuff band at the top
    const bandT = 0.86;
    const bx = footX + (topX - footX) * bandT;
    const by = footY + (topY - footY) * bandT;
    ctx.strokeStyle = shadeColor(color, -40);
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 0.7;
    const px = -(topY - footY);
    const py = topX - footX;
    const pl = Math.hypot(px, py) || 1;
    const nx = (px / pl) * width * 0.5;
    const ny = (py / pl) * width * 0.5;
    for (let i = 0; i < 2; i++) {
      const ox = (topX - footX) * 0.06 * i;
      const oy = (topY - footY) * 0.06 * i;
      ctx.beginPath();
      ctx.moveTo(bx - nx + ox, by - ny + oy);
      ctx.lineTo(bx + nx + ox, by + ny + oy);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  ctx.restore();
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

export function drawBoxingShoe(
  ctx: CanvasRenderingContext2D,
  footX: number, footY: number,
  unit: number,
  dir: number,
  color: string,
  flat: boolean,
  rot: number = 0,
  plain: boolean = false,
  laceColor?: string,
  soleColor?: string,
): void {
  const u = unit;
  ctx.save();
  ctx.translate(footX, footY);
  if (rot) ctx.rotate(rot * (dir >= 0 ? 1 : -1));
  ctx.scale(dir >= 0 ? 1 : -1, 1);

  const collarTop = plain ? -2.0 * u : -6.0 * u;

  // ── Upper ─────────────────────────────────────────────────────────────────
  ctx.beginPath();
  ctx.moveTo(-2.4 * u, 0.9 * u);
  ctx.lineTo(-2.25 * u, collarTop + 0.7 * u);
  ctx.quadraticCurveTo(-2.15 * u, collarTop, -1.2 * u, collarTop);
  ctx.lineTo(0.8 * u, collarTop + 0.15 * u);
  ctx.quadraticCurveTo(1.6 * u, collarTop + 0.3 * u, 1.8 * u, collarTop + 1.5 * u);
  ctx.lineTo(2.5 * u, -1.9 * u);
  ctx.quadraticCurveTo(3.3 * u, -1.5 * u, 4.4 * u, -1.35 * u);
  ctx.quadraticCurveTo(5.5 * u, -1.2 * u, 5.7 * u, -0.1 * u);
  ctx.lineTo(5.6 * u, 0.9 * u);
  ctx.closePath();

  if (flat) {
    ctx.fillStyle = color;
  } else {
    const grad = ctx.createLinearGradient(0, collarTop, 0, 1.2 * u);
    grad.addColorStop(0, shadeColor(color, 32));
    grad.addColorStop(0.55, shadeColor(color, 0));
    grad.addColorStop(1, shadeColor(color, -45));
    ctx.fillStyle = isSpacial(color) ? spacialPaint(ctx) : grad;
  }
  ctx.fill();
  if (!flat) {
    ctx.strokeStyle = shadeColor(color, -60);
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 0.6;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Sole ──────────────────────────────────────────────────────────────────
  const soleCol = flat ? color : (soleColor || defaultSoleColor(color));
  ctx.beginPath();
  ctx.moveTo(-2.55 * u, 0.6 * u);
  ctx.lineTo(5.75 * u, 0.5 * u);
  ctx.quadraticCurveTo(6.15 * u, 0.85 * u, 5.6 * u, 1.55 * u);
  ctx.lineTo(-2.1 * u, 1.7 * u);
  ctx.quadraticCurveTo(-2.8 * u, 1.6 * u, -2.55 * u, 0.6 * u);
  ctx.closePath();
  ctx.fillStyle = soleCol;
  ctx.fill();
  if (!flat) {
    ctx.strokeStyle = "rgba(0,0,0,0.45)";
    ctx.lineWidth = 0.5;
    ctx.stroke();
    // Midsole stripe
    ctx.strokeStyle = "rgba(0,0,0,0.25)";
    ctx.beginPath();
    ctx.moveTo(-2.35 * u, 1.05 * u);
    ctx.lineTo(5.6 * u, 0.95 * u);
    ctx.stroke();
  }

  if (!plain && !flat) {
    // ── Ankle collar padding ────────────────────────────────────────────────
    ctx.strokeStyle = shadeColor(color, 45);
    ctx.lineWidth = 1.1;
    ctx.globalAlpha = 0.75;
    ctx.beginPath();
    ctx.moveTo(-2.1 * u, collarTop + 0.2 * u);
    ctx.quadraticCurveTo(-0.6 * u, collarTop - 0.25 * u, 0.9 * u, collarTop + 0.35 * u);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Heel tab
    ctx.fillStyle = shadeColor(color, -30);
    ctx.beginPath();
    roundedBoxPath(ctx, -2.5 * u, collarTop - 0.15 * u, 1.0 * u, 1.1 * u, 0.3 * u);
    ctx.fill();

    // ── Laces up the instep ─────────────────────────────────────────────────
    const laceCol = laceColor || defaultLaceColor(color);
    const sx0 = 1.35 * u, sy0 = collarTop + 1.35 * u;
    const sx1 = 3.6 * u, sy1 = -1.3 * u;
    const ldx = sx1 - sx0, ldy = sy1 - sy0;
    const ll = Math.hypot(ldx, ldy) || 1;
    const pxn = -ldy / ll, pyn = ldx / ll;
    const half = 0.8 * u;
    ctx.strokeStyle = laceCol;
    ctx.lineWidth = 0.7;
    ctx.lineCap = "round";
    for (let i = 0; i < 4; i++) {
      const t0 = 0.08 + i * 0.24;
      const t1 = t0 + 0.18;
      const ax = sx0 + ldx * t0, ay = sy0 + ldy * t0;
      const bx = sx0 + ldx * t1, by = sy0 + ldy * t1;
      ctx.beginPath();
      ctx.moveTo(ax - pxn * half, ay - pyn * half);
      ctx.lineTo(bx + pxn * half, by + pyn * half);
      ctx.moveTo(ax + pxn * half, ay + pyn * half);
      ctx.lineTo(bx - pxn * half, by - pyn * half);
      ctx.stroke();
    }
    // Tongue edge
    ctx.strokeStyle = shadeColor(color, -55);
    ctx.globalAlpha = 0.45;
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(sx0 - pxn * half * 1.15, sy0 - pyn * half * 1.15);
    ctx.lineTo(sx1 - pxn * half * 1.15, sy1 - pyn * half * 1.15);
    ctx.moveTo(sx0 + pxn * half * 1.15, sy0 + pyn * half * 1.15);
    ctx.lineTo(sx1 + pxn * half * 1.15, sy1 + pyn * half * 1.15);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Toe cap seam
    ctx.strokeStyle = shadeColor(color, -55);
    ctx.globalAlpha = 0.4;
    ctx.beginPath();
    ctx.moveTo(4.25 * u, -1.3 * u);
    ctx.quadraticCurveTo(4.0 * u, 0, 4.35 * u, 0.85 * u);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  ctx.restore();
}

/**
 * Builds the outline of one tapered limb segment: `wStart`/`wEnd` are the
 * widths at the two joints, `wMid` the belly of the muscle (bicep / calf)
 * placed `bulgeT` of the way along.  Both ends are capped with a half-round so
 * joints still read as spheres.
 */
function limbPath(
  ctx: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  wStart: number, wMid: number, wEnd: number,
  bulgeT: number,
): { nx: number; ny: number } {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const rawLen = Math.hypot(dx, dy);
  const h0 = Math.max(0.1, wStart * 0.5);
  const hm = Math.max(0.1, wMid * 0.5);
  const h1 = Math.max(0.1, wEnd * 0.5);

  // Collapsed segment (a limb folded flat during a punch): fall back to a
  // single bounded joint circle so the capsule can't balloon or self-fold.
  if (!Number.isFinite(rawLen) || rawLen < 0.001) {
    ctx.beginPath();
    ctx.arc(x0, y0, Math.max(h0, h1), 0, Math.PI * 2);
    ctx.closePath();
    return { nx: -1, ny: 0 };
  }

  const len = rawLen;
  const nx = -(dy / len);
  const ny = dx / len;
  const t = Math.min(0.8, Math.max(0.2, bulgeT));
  // Quadratic control offset that makes the curve actually reach `hm` at t.
  // Clamped so a short or lopsided segment can't throw the control point far
  // outside the limb and fold the outline over itself.
  const hcRaw = (hm - (1 - t) * (1 - t) * h0 - t * t * h1) / (2 * t * (1 - t));
  const hcLimit = Math.min(Math.max(h0, hm, h1) * 2.2, len * 0.9 + hm);
  const hc = Math.min(hcLimit, Math.max(Math.min(h0, h1) * 0.5, hcRaw));
  const cx = x0 + dx * t;
  const cy = y0 + dy * t;
  const aN = Math.atan2(ny, nx);

  ctx.beginPath();
  ctx.moveTo(x0 + nx * h0, y0 + ny * h0);
  ctx.quadraticCurveTo(cx + nx * hc, cy + ny * hc, x1 + nx * h1, y1 + ny * h1);
  ctx.arc(x1, y1, h1, aN, aN - Math.PI, true);
  ctx.quadraticCurveTo(cx - nx * hc, cy - ny * hc, x0 - nx * h0, y0 - ny * h0);
  ctx.arc(x0, y0, h0, aN + Math.PI, aN, true);
  ctx.closePath();
  return { nx, ny };
}

/**
 * Draws a lean, lightly muscled limb segment: cylindrical cross-light plus a
 * short highlight over the muscle belly.  `flat` paints a single colour for the
 * crit / block flash silhouette.
 */
export function drawLimb(
  ctx: CanvasRenderingContext2D,
  x0: number, y0: number, x1: number, y1: number,
  wStart: number, wMid: number, wEnd: number,
  color: string,
  flat: boolean,
  bulgeT: number = 0.42,
): void {
  ctx.save();
  const { nx, ny } = limbPath(ctx, x0, y0, x1, y1, wStart, wMid, wEnd, bulgeT);

  if (flat) {
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
    return;
  }

  // The key light sits up and to the left, so the lit edge is whichever normal
  // points that way.  Without this the shading flips as a limb swings across.
  const litSign = (-nx - ny * 0.35) >= 0 ? 1 : -1;
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5;
  const hMax = Math.max(wStart, wMid, wEnd) * 0.5;
  const grad = ctx.createLinearGradient(
    mx + nx * hMax * litSign, my + ny * hMax * litSign,
    mx - nx * hMax * litSign, my - ny * hMax * litSign,
  );
  grad.addColorStop(0, shadeColor(color, 24));
  grad.addColorStop(0.45, shadeColor(color, 0));
  grad.addColorStop(1, shadeColor(color, -42));
  ctx.fillStyle = isSpacial(color) ? spacialPaint(ctx) : grad;
  ctx.fill();

  // Muscle belly: a soft streak along the lit side, clipped to the limb.
  ctx.clip();
  const off = hMax * 0.34 * litSign;
  ctx.strokeStyle = shadeColor(color, 38);
  ctx.globalAlpha = 0.34;
  ctx.lineCap = "round";
  ctx.lineWidth = Math.max(0.9, hMax * 0.5);
  ctx.beginPath();
  ctx.moveTo(x0 + (x1 - x0) * 0.16 + nx * off, y0 + (y1 - y0) * 0.16 + ny * off);
  ctx.quadraticCurveTo(
    x0 + (x1 - x0) * bulgeT + nx * off * 1.25, y0 + (y1 - y0) * bulgeT + ny * off * 1.25,
    x0 + (x1 - x0) * 0.72 + nx * off * 0.6, y0 + (y1 - y0) * 0.72 + ny * off * 0.6,
  );
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.restore();
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
