/**
 * Equipment Upgrade checks — run with `npx tsx script/equipmentCheck.ts`.
 *
 * The project has no test runner, so this is a self-contained assertion script
 * covering the gym crate's rules: unlock thresholds, the compounding price
 * curve, the flat diamond price, the every-tenth-level chest and its
 * tier, the per-level effect values, and how opponents inherit equipment
 * (sparring shares, the post-champion floor, weekly growth).
 *
 * Deliberately imports only `equipmentConfig`, which is engine-free — anything
 * pulling `engine.ts` drags the audio module's mp3 imports in and can't run
 * under tsx.
 */
import {
  EQUIPMENT,
  EQUIPMENT_COST_GROWTH,
  EQUIPMENT_CRATE_INTERVAL,
  EQUIPMENT_DIAMOND_COST,
  EQUIPMENT_MAX_LEVEL,
  EQUIPMENT_PER_LEVEL,
  EQUIPMENT_POOL_BONUS_CAP_SHARE,
  EQUIPMENT_SLOTS,
  cappedStartMaxStamina,
  mouthguardBigShotNegate,
  DOGHOUSE_EQUIPMENT_SHARE,
  NIGHTMARE_EQUIPMENT_SHARE,
  POST_CHAMP_EQUIPMENT_FLOOR_SHARE,
  SPARRING_EQUIPMENT_SHARE,
  WEEKLY_EQUIPMENT_GROWTH_CHANCE,
  WEEKLY_EQUIPMENT_GROWTH_MAX,
  WEEKLY_EQUIPMENT_GROWTH_MIN,
  averageEquipmentLevel,
  canBuyEquipmentLevel,
  clampEquipmentLevel,
  emptyEquipmentLevels,
  equipmentCrateForLevel,
  equipmentDiamondCost,
  equipmentEffects,
  equipmentForceCost,
  formatEquipmentCost,
  grownEquipmentLevel,
  hasEquipment,
  isEquipmentCrateUnlocked,
  normalizeEquipmentLevels,
  pendingEquipmentUnlocks,
  postChampEquipmentFloor,
  quoteEquipmentUpgrade,
  scaleEquipmentLevels,
  totalEquipmentLevels,
  uniformEquipmentLevels,
  unlockedEquipmentSlots,
  type EquipmentSlot,
} from "../client/src/game/equipmentConfig";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) <= tol;

console.log("1. unlocks are gated on career wins");
{
  const expected: Record<EquipmentSlot, number> = { gloves: 1, shoes: 3, trunks: 4, mouthguard: 5, wraps: 6 };
  for (const slot of EQUIPMENT_SLOTS) {
    check(`${EQUIPMENT[slot].name} unlocks at ${expected[slot]} wins`,
      EQUIPMENT[slot].unlockWins === expected[slot], String(EQUIPMENT[slot].unlockWins));
  }
  check("nothing is available at zero wins", unlockedEquipmentSlots(0).length === 0, unlockedEquipmentSlots(0).join(","));
  check("the crate itself stays shut below one win", !isEquipmentCrateUnlocked(0));
  check("the crate opens on the first win", isEquipmentCrateUnlocked(1));
  check("one win unlocks the gloves only",
    unlockedEquipmentSlots(1).join(",") === "gloves", unlockedEquipmentSlots(1).join(","));
  check("six wins unlock all five pieces", unlockedEquipmentSlots(6).length === 5);
  check("a locked piece can't be bought", !canBuyEquipmentLevel("wraps", 0, 5));
  check("an unlocked piece can be bought", canBuyEquipmentLevel("wraps", 0, 6));
  check("a maxed piece can't be bought", !canBuyEquipmentLevel("gloves", EQUIPMENT_MAX_LEVEL, 100));
}

console.log("\n2. pending unlocks drive the milestone and the dot");
{
  check("every cleared slot is pending when nothing has been seen",
    pendingEquipmentUnlocks(6, []).length === 5);
  check("seen slots drop out",
    pendingEquipmentUnlocks(6, ["gloves", "shoes"]).join(",") === "trunks,mouthguard,wraps",
    pendingEquipmentUnlocks(6, ["gloves", "shoes"]).join(","));
  check("an absent seen list reads as nothing seen", pendingEquipmentUnlocks(3, undefined).length === 2);
  check("a fully seen career has nothing pending", pendingEquipmentUnlocks(99, [...EQUIPMENT_SLOTS]).length === 0);
}

console.log("\n3. the Force price compounds 2.35% per level");
{
  check("growth rate is 1.0235", EQUIPMENT_COST_GROWTH === 1.0235);
  for (const slot of EQUIPMENT_SLOTS) {
    check(`${EQUIPMENT[slot].name} level 1 costs its base`,
      equipmentForceCost(slot, 0) === EQUIPMENT[slot].baseCost, String(equipmentForceCost(slot, 0)));
  }
  const expectedBases: Record<EquipmentSlot, number> = {
    gloves: 250, shoes: 500, trunks: 750, mouthguard: 600, wraps: 650,
  };
  for (const slot of EQUIPMENT_SLOTS) {
    check(`${EQUIPMENT[slot].name} base price is ${expectedBases[slot]}`,
      EQUIPMENT[slot].baseCost === expectedBases[slot], String(EQUIPMENT[slot].baseCost));
  }
  // The closed form must match walking the ladder one multiply at a time.
  let walked = EQUIPMENT.gloves.baseCost;
  let drift = 0;
  for (let lvl = 0; lvl < 300; lvl++) {
    if (!near(walked, equipmentForceCost("gloves", lvl), Math.max(1e-6, walked * 1e-9))) drift++;
    walked *= EQUIPMENT_COST_GROWTH;
  }
  check("the closed form tracks a level-by-level walk to 300", drift === 0, `${drift} mismatches`);
  check("each level costs exactly 2.35% more than the last",
    near(equipmentForceCost("shoes", 41) / equipmentForceCost("shoes", 40), 1.0235, 1e-9));
  // The growth rate is tuned to this landing point — retuning one moves the other.
  check("the gloves' last level costs about 3 trillion",
    near(equipmentForceCost("gloves", EQUIPMENT_MAX_LEVEL - 1), 3e12, 0.05e12),
    equipmentForceCost("gloves", EQUIPMENT_MAX_LEVEL - 1).toExponential(3));
  check("the ceiling has no price", equipmentForceCost("gloves", EQUIPMENT_MAX_LEVEL) === Infinity);
  check("huge prices render in exponent form", formatEquipmentCost(1.234e30) === "1.23e30", formatEquipmentCost(1.234e30));
  check("ordinary prices render with separators", formatEquipmentCost(2500) === (2500).toLocaleString());
}

console.log("\n4. every level costs one diamond, on every piece");
{
  check("the flat price is one", EQUIPMENT_DIAMOND_COST === 1);
  for (const slot of EQUIPMENT_SLOTS) {
    const flat = [0, 1, 99, 100, 500, EQUIPMENT_MAX_LEVEL - 1]
      .every(lvl => equipmentDiamondCost(slot, lvl) === EQUIPMENT_DIAMOND_COST);
    check(`${EQUIPMENT[slot].name} costs one diamond at every depth`, flat,
      String(equipmentDiamondCost(slot, 500)));
    check(`${EQUIPMENT[slot].name} has nothing to price at the ceiling`,
      equipmentDiamondCost(slot, EQUIPMENT_MAX_LEVEL) === 0);
  }
  // The headline number: five pieces × a thousand levels × one diamond.
  let total = 0;
  for (const slot of EQUIPMENT_SLOTS) {
    for (let lvl = 0; lvl < EQUIPMENT_MAX_LEVEL; lvl++) total += equipmentDiamondCost(slot, lvl);
  }
  check("the whole set costs 5,000 diamonds to max", total === 5000, String(total));
}

console.log("\n5. quotes gate on both purses");
{
  const rich = quoteEquipmentUpgrade("trunks", 250, { force: 1e30, diamonds: 100 });
  check("a stocked purse affords a diamond level", rich.affordable && rich.diamonds === 1, JSON.stringify(rich));
  const noGems = quoteEquipmentUpgrade("trunks", 150, { force: 1e30, diamonds: 0 });
  check("missing diamonds block the buy", !noGems.affordable);
  const noForce = quoteEquipmentUpgrade("gloves", 0, { force: 10, diamonds: 500 });
  check("missing force blocks the buy", !noForce.affordable);
  check("a quote targets the next level up", quoteEquipmentUpgrade("gloves", 7, {}).targetLevel === 8);
  const maxed = quoteEquipmentUpgrade("gloves", EQUIPMENT_MAX_LEVEL, { force: 1e300, diamonds: 1e9 });
  check("the ceiling is never affordable", maxed.maxed && !maxed.affordable && maxed.crate === null);
  check("an absent purse affords nothing", !quoteEquipmentUpgrade("gloves", 0, {}).affordable);
}

console.log("\n6. every tenth level drops a chest, tiered by depth");
{
  check("interval is ten levels", EQUIPMENT_CRATE_INTERVAL === 10);
  let offInterval = 0;
  for (let lvl = 1; lvl <= EQUIPMENT_MAX_LEVEL; lvl++) {
    const crate = equipmentCrateForLevel(lvl);
    if ((lvl % 10 === 0) !== (crate !== null)) offInterval++;
  }
  check("chests land on exactly the tenth levels", offInterval === 0, `${offInterval} off-interval levels`);
  const tiers: Array<[number, string]> = [
    [10, "journeyman"], [100, "journeyman"], [110, "contender"], [200, "contender"],
    [210, "elite"], [300, "elite"], [310, "champion"], [400, "champion"],
    [410, "undisputed"], [500, "undisputed"], [510, "goat"], [1000, "goat"],
  ];
  for (const [lvl, tier] of tiers) {
    check(`level ${lvl} yields a ${tier} chest`, equipmentCrateForLevel(lvl) === tier, String(equipmentCrateForLevel(lvl)));
  }
  check("level zero yields nothing", equipmentCrateForLevel(0) === null);
  const q = quoteEquipmentUpgrade("gloves", 9, { force: 1e30, diamonds: 0 });
  check("a quote announces the chest the level earns", q.crate === "journeyman", String(q.crate));
  check("a quote off the interval announces no chest", quoteEquipmentUpgrade("gloves", 10, {}).crate === null);
}

console.log("\n7. levels normalise, clamp and total");
{
  check("an absent blob reads as five zeroes", totalEquipmentLevels(normalizeEquipmentLevels(null)) === 0);
  check("junk fields read as zero", normalizeEquipmentLevels({ gloves: "12" }).gloves === 0);
  check("negative levels read as zero", normalizeEquipmentLevels({ shoes: -4 }).shoes === 0);
  check("fractional levels floor", normalizeEquipmentLevels({ wraps: 7.9 }).wraps === 7);
  check("levels clamp at the ceiling", normalizeEquipmentLevels({ trunks: 5000 }).trunks === EQUIPMENT_MAX_LEVEL);
  check("unknown keys are dropped",
    Object.keys(normalizeEquipmentLevels({ gloves: 3, hat: 9 })).sort().join(",") === [...EQUIPMENT_SLOTS].sort().join(","));
  check("a uniform spread wears one level in all five slots",
    totalEquipmentLevels(uniformEquipmentLevels(20)) === 100);
  check("the average of a uniform spread is that level", averageEquipmentLevel(uniformEquipmentLevels(37)) === 37);
  check("an uneven average floors",
    averageEquipmentLevel({ gloves: 1, shoes: 1, trunks: 1, mouthguard: 1, wraps: 0 }) === 0);
  check("an empty spread isn't worth applying", !hasEquipment(emptyEquipmentLevels()));
  check("a single level is worth applying", hasEquipment({ ...emptyEquipmentLevels(), shoes: 1 }));
  check("clamping is idempotent", clampEquipmentLevel(clampEquipmentLevel(1e9)) === EQUIPMENT_MAX_LEVEL);
  check("NaN clamps to zero", clampEquipmentLevel(Number.NaN) === 0);
}

console.log("\n8. per-level effect values");
{
  const P = EQUIPMENT_PER_LEVEL;
  check("gloves give 0.25% power a level", P.glovesPowerPct === 0.0025);
  check("gloves give 0.1% auto-guard a level", P.glovesAutoGuardPct === 0.001);
  check("shoes give 0.1% movement a level", P.shoesMoveSpeedPct === 0.001);
  check("trunks give 10 max stamina a level", P.trunksStartMaxStamina === 10);
  check("the mouthguard gives 0.009% negation a level", P.mouthguardNegateChance === 0.00009);
  check("the mouthguard gives 0.05% crit resist a level", P.mouthguardCritDamageResistPct === 0.0005);
  check("wraps give 0.01% blocking a level", P.wrapsBlockPct === 0.0001);
  check("wraps give 0.01% perfect-block hold a level", P.wrapsPerfectBlockHoldPct === 0.0001);
  check("wraps give 0.05% crit a level", P.wrapsCritPct === 0.0005);
  check("wraps give 0.05% stun a level", P.wrapsStunPct === 0.0005);

  const none = equipmentEffects(null);
  check("no equipment is worth nothing",
    Object.values(none).every(v => v === 0), JSON.stringify(none));

  const e = equipmentEffects(uniformEquipmentLevels(100));
  check("100 levels of gloves are +25% power", near(e.powerPct, 0.25));
  check("100 levels of gloves are +10% auto-guard", near(e.autoGuardPct, 0.1));
  check("100 levels of shoes are +10% movement", near(e.moveSpeedPct, 0.1));
  check("100 levels of trunks are +1000 max stamina", e.startMaxStamina === 1000);
  // The flat pool bonus is capped against the wearer's own tank, so the same
  // trunks can't be worth several times a low-level fighter's whole pool.
  check("the pool cap is half the wearer's tank", EQUIPMENT_POOL_BONUS_CAP_SHARE === 0.5);
  check("a big tank takes the whole bonus", cappedStartMaxStamina(1000, 8000) === 1000);
  check("the cap bites on a small tank", cappedStartMaxStamina(3000, 300) === 150,
    String(cappedStartMaxStamina(3000, 300)));
  check("exactly at the cap is unclipped", cappedStartMaxStamina(500, 1000) === 500);
  check("no pool means no bonus", cappedStartMaxStamina(1000, 0) === 0);
  check("no trunks means no bonus", cappedStartMaxStamina(0, 5000) === 0);
  check("100 levels of mouthguard are 0.9% negation", near(e.maxStaminaNegateChance, 0.009));
  check("100 levels of mouthguard are 5% crit resist", near(e.critDamageResistPct, 0.05));
  check("100 levels of wraps are +1% blocking", near(e.blockPct, 0.01));
  check("100 levels of wraps are +1% perfect-block hold", near(e.perfectBlockHoldPct, 0.01));
  check("100 levels of wraps are +5% crit", near(e.critPct, 0.05));
  check("100 levels of wraps are +5% stun", near(e.stunPct, 0.05));
  check("one level of wraps is 0.05% crit and stun",
    near(equipmentEffects({ ...emptyEquipmentLevels(), wraps: 1 }).critPct, 0.0005)
    && near(equipmentEffects({ ...emptyEquipmentLevels(), wraps: 1 }).stunPct, 0.0005));
  check("crit and stun are the wraps' alone",
    equipmentEffects({ ...emptyEquipmentLevels(), gloves: 300, mouthguard: 300 }).critPct === 0
    && equipmentEffects({ ...emptyEquipmentLevels(), gloves: 300, mouthguard: 300 }).stunPct === 0);

  const capped = equipmentEffects(uniformEquipmentLevels(EQUIPMENT_MAX_LEVEL));
  check("negation chance never exceeds certainty", capped.maxStaminaNegateChance <= 1);
  check("crit resist never exceeds the full bonus", capped.critDamageResistPct <= 1);
  check("a maxed mouthguard is still a 9% negation", near(capped.maxStaminaNegateChance, 0.09));
  check("a maxed mouthguard is a 50% crit resist", near(capped.critDamageResistPct, 0.5));
  check("maxed wraps are +50% crit and stun", near(capped.critPct, 0.5) && near(capped.stunPct, 0.5));

  // The mouthguard's Big Shot save: worth a fifth from the first level, topping
  // out at level 150. It cancels the knockdown only — the punch still lands.
  check("no mouthguard is no Big Shot save", mouthguardBigShotNegate(0) === 0);
  check("a negative level is no save", mouthguardBigShotNegate(-5) === 0);
  check("level 1 already saves 20%", near(mouthguardBigShotNegate(1), 0.20));
  check("level 150 saves 55%", near(mouthguardBigShotNegate(150), 0.55));
  check("the climb is even", near(mouthguardBigShotNegate(75.5 | 0), 0.20 + (74 / 149) * 0.35));
  check("every level up to the cap is worth more than the last",
    Array.from({ length: 149 }, (_, i) => i + 1)
      .every(l => mouthguardBigShotNegate(l + 1) > mouthguardBigShotNegate(l)));
  check("nothing past level 150 buys another point",
    mouthguardBigShotNegate(151) === 0.55 && mouthguardBigShotNegate(500) === 0.55
    && mouthguardBigShotNegate(EQUIPMENT_MAX_LEVEL) === 0.55);
  check("the save never exceeds its ceiling",
    capped.bigShotNegateChance === 0.55 && capped.bigShotNegateChance <= 1);
  check("the fight reads the same curve the page shows",
    near(equipmentEffects({ ...emptyEquipmentLevels(), mouthguard: 40 }).bigShotNegateChance,
      mouthguardBigShotNegate(40)));
  check("the Big Shot save is the mouthguard's alone",
    equipmentEffects({ ...emptyEquipmentLevels(), gloves: 200, wraps: 200 }).bigShotNegateChance === 0);

  // Only the slot bought moves — no effect leaks between pieces.
  const glovesOnly = equipmentEffects({ ...emptyEquipmentLevels(), gloves: 40 });
  check("buying gloves moves nothing else",
    glovesOnly.moveSpeedPct === 0 && glovesOnly.startMaxStamina === 0 && glovesOnly.blockPct === 0
      && near(glovesOnly.powerPct, 0.1));
}

console.log("\n9. opponents inherit a share of the player's kit");
{
  check("journeyman partners take 75%", SPARRING_EQUIPMENT_SHARE.journeyman === 0.75);
  check("contender partners take 80%", SPARRING_EQUIPMENT_SHARE.contender === 0.80);
  check("elite partners take 85%", SPARRING_EQUIPMENT_SHARE.elite === 0.85);
  check("champion partners take 90%", SPARRING_EQUIPMENT_SHARE.champion === 0.90);
  check("nightmare enemies take 10%", NIGHTMARE_EQUIPMENT_SHARE === 0.10);
  check("the doghouse queue matches the player", DOGHOUSE_EQUIPMENT_SHARE === 1.00);

  const player = uniformEquipmentLevels(100);
  check("a champion partner wears 90 of 100", scaleEquipmentLevels(player, SPARRING_EQUIPMENT_SHARE.champion).gloves === 90);
  check("a journeyman partner wears 75 of 100", scaleEquipmentLevels(player, SPARRING_EQUIPMENT_SHARE.journeyman).gloves === 75);
  check("a nightmare enemy wears 10 of 100", scaleEquipmentLevels(player, NIGHTMARE_EQUIPMENT_SHARE).gloves === 10);
  check("the doghouse wears the lot", scaleEquipmentLevels(player, DOGHOUSE_EQUIPMENT_SHARE).gloves === 100);
  check("shares round up so a share of one is never nothing",
    scaleEquipmentLevels({ ...emptyEquipmentLevels(), shoes: 1 }, NIGHTMARE_EQUIPMENT_SHARE).shoes === 1);
  check("a share of nothing is nothing",
    totalEquipmentLevels(scaleEquipmentLevels(emptyEquipmentLevels(), 0.9)) === 0);
  check("an uneven kit scales slot by slot",
    JSON.stringify(scaleEquipmentLevels({ gloves: 10, shoes: 3, trunks: 0, mouthguard: 7, wraps: 1 }, 0.5))
      === JSON.stringify({ gloves: 5, shoes: 2, trunks: 0, mouthguard: 4, wraps: 1 }));
  check("a scaled kit still clamps at the ceiling",
    scaleEquipmentLevels(uniformEquipmentLevels(EQUIPMENT_MAX_LEVEL), 2).gloves === EQUIPMENT_MAX_LEVEL);
}

console.log("\n10. the post-champion floor lifts stragglers");
{
  check("the floor is three quarters", POST_CHAMP_EQUIPMENT_FLOOR_SHARE === 0.75);
  check("a 100-level kit floors opponents at 75", postChampEquipmentFloor(uniformEquipmentLevels(100)) === 75);
  check("the floor rounds up", postChampEquipmentFloor(uniformEquipmentLevels(10)) === 8);
  check("no kit means no floor", postChampEquipmentFloor(null) === 0);
  check("the floor reads the average, not a single slot",
    postChampEquipmentFloor({ gloves: 100, shoes: 0, trunks: 0, mouthguard: 0, wraps: 0 }) === 15,
    String(postChampEquipmentFloor({ gloves: 100, shoes: 0, trunks: 0, mouthguard: 0, wraps: 0 })));
}

console.log("\n11. weekly growth");
{
  check("the weekly roll is 30%", WEEKLY_EQUIPMENT_GROWTH_CHANCE === 0.30);
  check("growth is 1 to 5 levels", WEEKLY_EQUIPMENT_GROWTH_MIN === 1 && WEEKLY_EQUIPMENT_GROWTH_MAX === 5);
  check("an unequipped opponent never grows", grownEquipmentLevel(0, 0, 0) === 0);
  check("a failed roll leaves the level alone", grownEquipmentLevel(50, 0.31, 0.9) === 50);
  check("a roll on the boundary fails", grownEquipmentLevel(50, 0.30, 0.9) === 50);
  check("the minimum gain is one level", grownEquipmentLevel(50, 0.0, 0.0) === 51);
  check("the maximum gain is five levels", grownEquipmentLevel(50, 0.29, 0.9999) === 55);
  check("growth clamps at the ceiling", grownEquipmentLevel(EQUIPMENT_MAX_LEVEL, 0, 0.99) === EQUIPMENT_MAX_LEVEL);
  // The five buckets have to be reachable and evenly spread across the roll.
  const seen = new Set<number>();
  for (let i = 0; i < 1000; i++) seen.add(grownEquipmentLevel(10, 0.1, i / 1000) - 10);
  check("all five gain sizes are reachable",
    [1, 2, 3, 4, 5].every(g => seen.has(g)) && seen.size === 5, [...seen].sort().join(","));
  // Long-run share of weeks that grow, at an even spread of rolls.
  let grew = 0;
  for (let i = 0; i < 10_000; i++) if (grownEquipmentLevel(10, i / 10_000, 0.5) > 10) grew++;
  check("about 30% of weeks grow", Math.abs(grew / 10_000 - 0.30) <= 0.001, `${grew}/10000`);
}

console.log(failures === 0 ? "\nAll equipment checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
