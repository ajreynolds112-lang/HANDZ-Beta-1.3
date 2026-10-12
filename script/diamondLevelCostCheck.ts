/**
 * Stat economy checks — run with `npx tsx script/diamondLevelCostCheck.ts`.
 *
 * The retired bought-point counter must still round-trip through saves, and a
 * point earned past the cap pays Force instead.
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
console.log("8. the retired bought-point counter still round-trips");
// Stat points cannot be bought any more, but careers saved while they could
// carry the counter, so storage must neither drop nor rewind it.
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
