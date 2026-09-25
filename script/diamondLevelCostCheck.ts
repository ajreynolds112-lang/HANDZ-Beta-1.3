/**
 * Purchase price checks — run with `npx tsx script/diamondLevelCostCheck.ts`.
 *
 * Both paid ladders — diamond level-ups and Force-bought stat points — price
 * off a counter in the save rather than off the fighter's level. The properties
 * worth guarding are the same for each: XP levels must not raise the price, the
 * counter must survive a save download/upload round trip, it must start over on
 * a new career, and a stale write must not be able to rewind it. The last
 * section covers the other end of the stat economy: what a point earned past
 * the cap pays instead.
 */
export {};

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "ok  " : "FAIL"} ${name}${cond ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

// The save layer runs in the browser — stub the storage it needs.
const store: Record<string, string> = {};
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v; },
  removeItem: (k: string) => { delete store[k]; },
  clear: () => { for (const k of Object.keys(store)) delete store[k]; },
  key: () => null,
  length: 0,
};

const localSaves = await import("../client/src/lib/localSaves");
const { diamondLevelUpCost, DIAMOND_LEVEL_COST_MULT, DIAMOND_LEVEL_COST_STEP } =
  await import("../client/src/game/diamondLevelCost");

console.log("1. the price steps by 1.5× every other purchase");
check("the configured multiplier is 1.5", DIAMOND_LEVEL_COST_MULT === 1.5, String(DIAMOND_LEVEL_COST_MULT));
check("the step is every other purchase", DIAMOND_LEVEL_COST_STEP === 2, String(DIAMOND_LEVEL_COST_STEP));
const curve = Array.from({ length: 14 }, (_, i) => diamondLevelUpCost(i));
check("the first 14 purchases follow the curve",
  JSON.stringify(curve) === JSON.stringify([1, 1, 2, 2, 3, 3, 4, 4, 6, 6, 8, 8, 12, 12]), curve.join(","));
check("every price holds for exactly two purchases",
  Array.from({ length: 30 }, (_, i) => i * 2).every(b => diamondLevelUpCost(b) === diamondLevelUpCost(b + 1)));
check("the price never drops as purchases pile up",
  Array.from({ length: 200 }, (_, i) => diamondLevelUpCost(i)).every((v, i, a) => i === 0 || v >= a[i - 1]));
check("a huge purchase count stays a finite number", Number.isFinite(diamondLevelUpCost(2000)));

console.log("2. a new career starts at the base price");
const fresh = localSaves.createFighter({ name: "Fresh" } as never);
check("a brand-new save has bought nothing", (fresh.diamondLevelsBought ?? 0) === 0, String(fresh.diamondLevelsBought));
check("and pays the base price", diamondLevelUpCost(fresh.diamondLevelsBought ?? 0) === 1);

console.log("3. XP levels never raise the price");
localSaves.updateFighter(fresh.id, { level: 40, xp: 999_999 } as never);
const xpGrown = localSaves.getFighter(fresh.id)!;
check("the fighter really did level up", xpGrown.level === 40, String(xpGrown.level));
check("but has still bought nothing", (xpGrown.diamondLevelsBought ?? 0) === 0, String(xpGrown.diamondLevelsBought));
check("so the next level still costs the base price",
  diamondLevelUpCost(xpGrown.diamondLevelsBought ?? 0) === 1, String(diamondLevelUpCost(xpGrown.diamondLevelsBought ?? 0)));

console.log("4. only purchases advance the price");
localSaves.updateFighter(fresh.id, { diamonds: 500, diamondLevelsBought: 4 } as never);
const bought = localSaves.getFighter(fresh.id)!;
const priceBefore = diamondLevelUpCost(bought.diamondLevelsBought ?? 0);
check("four purchases in, the price has stepped twice", priceBefore === 3, String(priceBefore));
check("a legacy save with no counter falls back to the base price", diamondLevelUpCost(undefined as unknown as number) === 1);

console.log("5. a stale write cannot rewind the counter");
localSaves.updateFighter(fresh.id, { diamondLevelsBought: 1 } as never);
check("the rewind is refused", (localSaves.getFighter(fresh.id)!.diamondLevelsBought ?? 0) === 4,
  String(localSaves.getFighter(fresh.id)!.diamondLevelsBought));
localSaves.updateFighter(fresh.id, { level: 41 } as never);
check("an unrelated write leaves it alone", (localSaves.getFighter(fresh.id)!.diamondLevelsBought ?? 0) === 4);

console.log("6. the counter survives a save download and upload");
const grown = localSaves.getFighter(fresh.id)!;
const file = JSON.parse(JSON.stringify(localSaves.exportSaveFile(grown)));
check("the downloaded file carries the counter", file.fighter.diamondLevelsBought === 4, String(file.fighter.diamondLevelsBought));
check("and the diamonds that pay for it", file.fighter.diamonds === 500, String(file.fighter.diamonds));

localSaves.deleteFighter(grown.id);
const restored = localSaves.importSaveFile(file);
check("an uploaded save keeps the counter", (restored.diamondLevelsBought ?? 0) === 4, String(restored.diamondLevelsBought));
check("so the price picks up where it left off",
  diamondLevelUpCost(restored.diamondLevelsBought ?? 0) === priceBefore);

const legacyFile = JSON.parse(JSON.stringify(file));
delete legacyFile.fighter.diamondLevelsBought;
localSaves.deleteFighter(restored.id);
const legacy = localSaves.importSaveFile(legacyFile);
check("an old save file with no counter imports at zero", legacy.diamondLevelsBought === 0, String(legacy.diamondLevelsBought));

console.log("7. starting over resets the price");
localSaves.deleteFighter(legacy.id);
const reborn = localSaves.createFighter({ name: "Reborn" } as never);
check("the new career has bought nothing", (reborn.diamondLevelsBought ?? 0) === 0, String(reborn.diamondLevelsBought));
check("and pays the base price again", diamondLevelUpCost(reborn.diamondLevelsBought ?? 0) === 1);

console.log("8. the retired bought-point counter still round-trips");
// Stat points cannot be bought any more, but careers saved while they could
// carry the counter, so storage must neither drop nor rewind it.
// An upload refuses to overwrite an existing save, so clear the one above first.
localSaves.deleteFighter(reborn.id);
const spCareer = localSaves.createFighter({ name: "Spender" } as never);
check("a brand-new save has bought none", (spCareer.statPointsBought ?? 0) === 0, String(spCareer.statPointsBought));
localSaves.updateFighter(spCareer.id, { force: 1_000_000, statPointsBought: 3 } as never);
check("a stored count survives the write",
  (localSaves.getFighter(spCareer.id)!.statPointsBought ?? 0) === 3,
  String(localSaves.getFighter(spCareer.id)!.statPointsBought));
localSaves.updateFighter(spCareer.id, { statPointsBought: 1 } as never);
check("a stale write cannot rewind it", (localSaves.getFighter(spCareer.id)!.statPointsBought ?? 0) === 3,
  String(localSaves.getFighter(spCareer.id)!.statPointsBought));
const spFile = JSON.parse(JSON.stringify(localSaves.exportSaveFile(localSaves.getFighter(spCareer.id)!)));
check("the downloaded file carries it", spFile.fighter.statPointsBought === 3, String(spFile.fighter.statPointsBought));
localSaves.deleteFighter(spCareer.id);
const spRestored = localSaves.importSaveFile(spFile);
check("an uploaded save keeps the count",
  (spRestored.statPointsBought ?? 0) === 3, String(spRestored.statPointsBought));
const spLegacyFile = JSON.parse(JSON.stringify(spFile));
delete spLegacyFile.fighter.statPointsBought;
localSaves.deleteFighter(spRestored.id);
const spLegacy = localSaves.importSaveFile(spLegacyFile);
check("an old save file with no counter imports at zero", spLegacy.statPointsBought === 0, String(spLegacy.statPointsBought));
localSaves.deleteFighter(spLegacy.id);

console.log("9. capped stat points pay Force instead");
const { cappedStatPointForce, FORCE_PER_CAPPED_SP_BOUT, FORCE_PER_CAPPED_SP_TRAINING } =
  await import("../client/src/game/statPointEconomy");
const { statPointCap, perStatCap } = await import("../shared/schema");
check("an official bout pays 100k a point", cappedStatPointForce(3, FORCE_PER_CAPPED_SP_BOUT) === 300_000);
check("training pays 10k a point", cappedStatPointForce(3, FORCE_PER_CAPPED_SP_TRAINING) === 30_000);
check("nothing over the cap pays nothing", cappedStatPointForce(0, FORCE_PER_CAPPED_SP_BOUT) === 0);
check("a negative overflow pays nothing", cappedStatPointForce(-5, FORCE_PER_CAPPED_SP_TRAINING) === 0);
check("the champion lifts the pool to a full 1000 a stat", statPointCap(true) === perStatCap(true) * 5,
  `${statPointCap(true)} vs ${perStatCap(true) * 5}`);
check("before that the pool is short of it", statPointCap(false) < statPointCap(true),
  `${statPointCap(false)} vs ${statPointCap(true)}`);
check("but still leaves room to max a few stats", statPointCap(false) >= perStatCap(false) * 4,
  `${statPointCap(false)} vs ${perStatCap(false) * 4}`);

console.log(failures === 0 ? "\nAll purchase price checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
