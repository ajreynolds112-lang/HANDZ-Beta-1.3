/**
 * Crate roll checks — run with `npx tsx script/crateRollCheck.ts`.
 *
 * The project has no test runner, so this is a self-contained assertion script
 * covering the reward-crate draw rules: rolled crate size, the authored tier
 * tables, per-item Rarity % weighting, lifetime caps, keepsakes, consumable
 * rank locks, and partially stocked catalogs.
 */
import type { ItemInventory } from "../shared/schema";
import type { ItemDefinition, ItemRarity } from "../client/src/game/itemsConfig";
import { CRATES, CRATE_IDS, CRATE_ITEM_COUNT_MIN, CRATE_ITEM_COUNT_MAX, rollCrateDraw, rollItemOfRarity } from "../client/src/game/cratesConfig";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Crate sizes are rolled per draw, so assertions test the range. */
function inRange(n: number): boolean {
  return n >= CRATE_ITEM_COUNT_MIN && n <= CRATE_ITEM_COUNT_MAX;
}

const RARITIES: ItemRarity[] = ["Journeyman", "Contender", "Elite", "Champion", "Undisputed", "GOAT"];

function item(over: Partial<ItemDefinition> & { id: string; rarity: ItemRarity }): ItemDefinition {
  return {
    name: over.id, icon: "🎁", isBoost: true, isConsumable: false, isKeepsake: false,
    obtainableLimit: 1, synergy: false, synergyStackCount: 1, sellable: false,
    sellShards: 0, sellForce: 0, sellDiamonds: 0, rarityPercent: 50,
    rankUnlockThreshold: null, ...over,
  } as ItemDefinition;
}

/** Three unlimited consumables per tier, weighted 50/30/20. */
const fullCatalog: ItemDefinition[] = RARITIES.flatMap(r =>
  [0, 1, 2].map(i => item({
    id: `${r}-${i}`, rarity: r, isConsumable: true, obtainableLimit: 9999,
    rarityPercent: [50, 30, 20][i],
  })));

function emptyInv(over: Partial<ItemInventory> = {}): ItemInventory {
  return { owned: {}, lifetimeObtained: {}, keepsakesReceived: [], activeBoosts: {}, unseenItemIds: [], ...over };
}

/** Deterministic-enough sampling: many draws, compared with a tolerance. */
function sample(crate: typeof CRATE_IDS[number], catalog: ItemDefinition[], inv: ItemInventory, rank: number | null, runs: number) {
  const tierCount: Record<string, number> = {};
  const idCount: Record<string, number> = {};
  const sizes: number[] = [];
  for (let n = 0; n < runs; n++) {
    const drawn = rollCrateDraw(crate, { inventory: inv, playerRank: rank, items: catalog });
    sizes.push(drawn.length);
    for (const d of drawn) {
      tierCount[d.rarity] = (tierCount[d.rarity] ?? 0) + 1;
      idCount[d.id] = (idCount[d.id] ?? 0) + 1;
    }
  }
  const total = sizes.reduce((a, b) => a + b, 0);
  return { tierCount, idCount, sizes, total };
}

console.log(`1. every crate delivers ${CRATE_ITEM_COUNT_MIN}-${CRATE_ITEM_COUNT_MAX} items from a full catalog`);
for (const id of CRATE_IDS) {
  const { sizes } = sample(id, fullCatalog, emptyInv(), 50, 400);
  check(`${CRATES[id].name} stays inside the size range`,
    sizes.every(s => s >= CRATE_ITEM_COUNT_MIN && s <= CRATE_ITEM_COUNT_MAX),
    `sizes seen: ${[...new Set(sizes)].sort().join(",")}`);
  const seen = new Set(sizes);
  check(`${CRATES[id].name} rolls both ends of the range`,
    seen.has(CRATE_ITEM_COUNT_MIN) && seen.has(CRATE_ITEM_COUNT_MAX),
    `sizes seen: ${[...seen].sort().join(",")}`);
}

console.log("2. tier distribution matches the authored table (±2pp)");
for (const id of CRATE_IDS) {
  const { tierCount, total } = sample(id, fullCatalog, emptyInv(), 50, 3000);
  for (const [tier, pct] of Object.entries(CRATES[id].table)) {
    const got = ((tierCount[tier] ?? 0) / total) * 100;
    check(`${CRATES[id].name} ${tier} ≈ ${pct}%`, Math.abs(got - pct) <= 2, `got ${got.toFixed(2)}%`);
  }
  const offTable = Object.keys(tierCount).filter(t => !(t in CRATES[id].table));
  check(`${CRATES[id].name} draws no off-table tiers`, offTable.length === 0, offTable.join(","));
}

console.log("3. items inside a tier follow their Rarity % weighting (±3pp)");
{
  const { idCount, tierCount } = sample("elite", fullCatalog, emptyInv(), 50, 3000);
  const eliteTotal = tierCount["Elite"] ?? 0;
  const expect = [50, 30, 20];
  [0, 1, 2].forEach(i => {
    const got = ((idCount[`Elite-${i}`] ?? 0) / eliteTotal) * 100;
    check(`Elite-${i} ≈ ${expect[i]}% of Elite draws`, Math.abs(got - expect[i]) <= 3, `got ${got.toFixed(2)}%`);
  });
}

console.log("4. items at their lifetime cap are never drawn");
{
  const capped = emptyInv({ lifetimeObtained: { "Elite-0": 9999 } });
  const { idCount } = sample("elite", fullCatalog, capped, 50, 500);
  check("capped item excluded", (idCount["Elite-0"] ?? 0) === 0, `drawn ${idCount["Elite-0"]}`);

  const allCapped = emptyInv({
    lifetimeObtained: Object.fromEntries(fullCatalog.map(d => [d.id, 9999])),
  });
  const drawn = rollCrateDraw("elite", { inventory: allCapped, playerRank: 50, items: fullCatalog });
  check("fully capped catalog yields nothing", drawn.length === 0, `${drawn.length} drawn`);

  const emptyDraw = rollCrateDraw("elite", { inventory: emptyInv(), playerRank: 50, items: [] });
  check("empty catalog yields nothing", emptyDraw.length === 0, `${emptyDraw.length} drawn`);
}

console.log("5. non-consumables respect their obtainable limit across the crate");
{
  // One Elite item, limit 2 → the crate can hold at most 2 copies of it.
  const catalog = [item({ id: "Elite-limited", rarity: "Elite", obtainableLimit: 2 })];
  const drawn = rollCrateDraw("elite", { inventory: emptyInv(), playerRank: 50, items: catalog });
  check("limit-2 item drops at most twice", drawn.length === 2, `${drawn.length} drawn`);

  const partly = emptyInv({ lifetimeObtained: { "Elite-limited": 1 } });
  const drawn2 = rollCrateDraw("elite", { inventory: partly, playerRank: 50, items: catalog });
  check("already-owned copy counts toward the limit", drawn2.length === 1, `${drawn2.length} drawn`);
}

console.log("6. keepsakes only drop where they are opted in — otherwise they are won in the ring");
{
  const catalog = [
    item({ id: "Elite-keep", rarity: "Elite", isKeepsake: true, obtainableLimit: 9999 }),
    item({ id: "Elite-plain", rarity: "Elite", isConsumable: true, obtainableLimit: 9999 }),
  ];
  const { idCount } = sample("elite", catalog, emptyInv(), 50, 200);
  check("a keepsake never turns up in a crate", (idCount["Elite-keep"] ?? 0) === 0,
    `${idCount["Elite-keep"] ?? 0} drawn over 200 crates`);
  check("the rest of the tier still drops", (idCount["Elite-plain"] ?? 0) > 0);

  const single = rollCrateDraw("elite", { inventory: emptyInv(), playerRank: 50, items: [catalog[0]] });
  check("a crate holding only a keepsake yields nothing", single.length === 0, `${single.length} drawn`);

  // The gym opts in: a workout reward may turn up a keepsake, once ever.
  const opted = rollCrateDraw("elite", {
    inventory: emptyInv(), playerRank: 50, items: [catalog[0]], allowKeepsakes: true,
  });
  check("an opted-in crate can hand over a keepsake", opted.length > 0 && opted.every(d => d.id === "Elite-keep"),
    `${opted.length} drawn`);
  check("even opted in, a keepsake drops only once per crate",
    opted.filter(d => d.id === "Elite-keep").length === 1, `${opted.length} copies`);

  const received = rollCrateDraw("elite", {
    inventory: emptyInv({ keepsakesReceived: ["Elite-keep"] }),
    playerRank: 50, items: [catalog[0]], allowKeepsakes: true,
  });
  check("a keepsake already received is never handed over again", received.length === 0, `${received.length} drawn`);

  const held = rollCrateDraw("elite", {
    inventory: emptyInv({ owned: { "Elite-keep": 1 } }),
    playerRank: 50, items: [catalog[0]], allowKeepsakes: true,
  });
  check("a keepsake already in the locker is never duplicated", held.length === 0, `${held.length} drawn`);
}

console.log("7. rank-locked items only drop once the rank has been reached");
{
  const catalog = [item({
    id: "Elite-ranked", rarity: "Elite", isConsumable: true, obtainableLimit: 9999,
    rankUnlockThreshold: 100,
  })];
  check("reaching the rank drops", inRange(rollCrateDraw("elite", { inventory: emptyInv(), playerRank: 100, items: catalog }).length));
  check("and climbing past it still drops", inRange(rollCrateDraw("elite", { inventory: emptyInv(), playerRank: 5, items: catalog }).length));
  check("short of the rank is excluded", rollCrateDraw("elite", { inventory: emptyInv(), playerRank: 500, items: catalog }).length === 0);
  check("an unranked save is excluded too", rollCrateDraw("elite", { inventory: emptyInv(), playerRank: null, items: catalog }).length === 0);
  // The gate is the item's, not the consumable flag's.
  const permCatalog = [item({
    id: "Elite-rankedPerm", rarity: "Elite", isConsumable: false, obtainableLimit: 9999,
    rankUnlockThreshold: 100,
  })];
  check("a permanent item obeys it as well", rollCrateDraw("elite", { inventory: emptyInv(), playerRank: 500, items: permCatalog }).length === 0);
}

console.log("8. items set to 0% Rarity never drop");
{
  // Mixed tier: a 0% item alongside a positive-weight one.
  const mixed = [
    item({ id: "Elite-zero", rarity: "Elite", isConsumable: true, obtainableLimit: 9999, rarityPercent: 0 }),
    item({ id: "Elite-live", rarity: "Elite", isConsumable: true, obtainableLimit: 9999, rarityPercent: 25 }),
  ];
  const mixedRun = sample("elite", mixed, emptyInv(), 50, 300);
  check("0% item never drawn from a mixed tier", (mixedRun.idCount["Elite-zero"] ?? 0) === 0,
    `drawn ${mixedRun.idCount["Elite-zero"]}`);
  check("mixed tier still fills the crate", mixedRun.sizes.every(inRange));

  // All-zero tier behaves like an unstocked tier: nothing to give.
  const allZero = [item({ id: "Elite-zero", rarity: "Elite", isConsumable: true, obtainableLimit: 9999, rarityPercent: 0 })];
  const zeroDraw = rollCrateDraw("elite", { inventory: emptyInv(), playerRank: 50, items: allZero });
  check("all-zero tier yields nothing", zeroDraw.length === 0, `${zeroDraw.length} drawn`);

  // All-zero tier inside a crate that has other stocked tiers: the zero tier's
  // share falls through to the nearest stocked tier, never to the 0% item.
  const zeroPlusOther = [
    item({ id: "Elite-zero", rarity: "Elite", isConsumable: true, obtainableLimit: 9999, rarityPercent: 0 }),
    item({ id: "Champion-live", rarity: "Champion", isConsumable: true, obtainableLimit: 9999, rarityPercent: 40 }),
  ];
  const mixRun = sample("elite", zeroPlusOther, emptyInv(), 50, 300);
  check("0% item never substitutes for its tier", (mixRun.idCount["Elite-zero"] ?? 0) === 0,
    `drawn ${mixRun.idCount["Elite-zero"]}`);
  check("crate still fills from the stocked tier", mixRun.sizes.every(inRange));
}

console.log("9. partially stocked catalogs still fill the crate");
{
  // Elite's crate wants Contender/Elite/Champion/Undisputed; only Elite exists.
  const onlyElite = fullCatalog.filter(d => d.rarity === "Elite");
  const { sizes, tierCount } = sample("elite", onlyElite, emptyInv(), 50, 100);
  check("single stocked tier still fills the crate", sizes.every(inRange),
    `sizes ${[...new Set(sizes)].join(",")}`);
  check("all draws come from the stocked tier", Object.keys(tierCount).join() === "Elite", Object.keys(tierCount).join());

  // Missing top tier: Champion's crate (Elite/Champion/Undisputed) without Undisputed.
  const noUndisputed = fullCatalog.filter(d => d.rarity !== "Undisputed");
  const s2 = sample("champion", noUndisputed, emptyInv(), 50, 2000);
  check("missing tier still fills the crate", s2.sizes.every(inRange));
  const elitePct = ((s2.tierCount["Elite"] ?? 0) / s2.total) * 100;
  check("stocked tiers keep their authored odds", Math.abs(elitePct - 10) <= 2, `Elite ${elitePct.toFixed(2)}%`);
  check("missing tier's share falls to the nearest stocked tier",
    (s2.tierCount["Undisputed"] ?? 0) === 0 && (s2.tierCount["Champion"] ?? 0) > 0);
}

console.log("10. a win's career fields and crate contents persist together in one save write");
await (async () => {
  // Stub the browser storage the save layer uses, then drive the exact
  // fight-win path: roll off the persisted save, write the crate inventory in
  // the SAME updateFighter call as the career fields, reload from storage.
  const store: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: () => null,
    length: 0,
  };
  store["handz_items_config"] = JSON.stringify(fullCatalog);

  const localSaves = await import("../client/src/lib/localSaves");
  const { rollCrateForFighter, hasUnseenItems, markItemsSeen, getInventory } =
    await import("../client/src/lib/itemInventory");

  const created = localSaves.createFighter({ name: "Check Fighter" } as never);
  check("fresh save has no unseen items", !hasUnseenItems(created));

  const roll = rollCrateForFighter(localSaves.getFighter(created.id), "champion", 40);
  check("win rolls a full crate", inRange(roll.itemIds.length), `${roll.itemIds.length} drawn`);

  // One write, career fields + crate inventory together.
  localSaves.updateFighter(created.id, {
    wins: 1, careerBoutIndex: 1, force: 50000,
    itemInventory: roll.inventory,
  } as never);

  const reloaded = localSaves.getFighter(created.id);
  const inv = getInventory(reloaded);
  check("career fields persisted", reloaded?.wins === 1 && reloaded?.careerBoutIndex === 1 && reloaded?.force === 50000,
    JSON.stringify({ wins: reloaded?.wins, bout: reloaded?.careerBoutIndex, force: reloaded?.force }));
  const ownedTotal = Object.values(inv.owned).reduce((a, b) => a + b, 0);
  check("crate contents persisted", ownedTotal === roll.itemIds.length, `${ownedTotal} owned`);
  const revealMatchesLocker = roll.itemIds.every(id => (inv.owned[id] ?? 0) > 0);
  check("every revealed id is in the locker", revealMatchesLocker);
  check("lifetime counts match owned counts",
    roll.itemIds.every(id => inv.lifetimeObtained[id] === inv.owned[id]));
  check("new items flag the locker dot", hasUnseenItems(reloaded));

  markItemsSeen(created.id);
  const afterSeen = localSaves.getFighter(created.id);
  check("closing the locker clears the dot", !hasUnseenItems(afterSeen));
  check("clearing the dot keeps the items",
    Object.values(getInventory(afterSeen).owned).reduce((a, b) => a + b, 0) === roll.itemIds.length);
})();

console.log("11. reward chests follow the configured per-band odds and count");
await (async () => {
  const rg = await import("../client/src/game/rosterGenConfig");
  const KEY = "handz_roster_gen_config";
  const sumOdds = (c: Record<string, number>) => CRATE_IDS.reduce((s, id) => s + c[id], 0);

  const def = rg.buildDefaultRosterGenConfig();
  check("default bands hand out one chest", def.bands.every(b => b.crateCount === 1));
  check("default odds total 100", def.bands.every(b => sumOdds(b.crateChances) === 100)
    && sumOdds(def.rank1CrateChances) === 100);

  // A config saved before per-crate odds existed carries a `rewardCrates` list:
  // it migrates to an even split, one chest per win (empty list = no chest).
  const legacy = JSON.parse(JSON.stringify(def)) as Record<string, any>;
  for (const b of legacy.bands) {
    delete b.crateChances; delete b.crateCount;
    b.rewardCrates = ["journeyman", "elite"];
  }
  delete legacy.rank1CrateChances; delete legacy.rank1CrateCount;
  legacy.rank1RewardCrates = [];
  localStorage.setItem(KEY, JSON.stringify(legacy));
  const migrated = rg.loadCustomRosterGenConfig()!;
  check("legacy crate list becomes an even split",
    migrated.bands.every(b => b.crateChances.journeyman === 50 && b.crateChances.elite === 50
      && sumOdds(b.crateChances) === 100 && b.crateCount === 1));
  check("legacy empty list means no chest", migrated.rank1CrateCount === 0);

  // Saved odds drive a weighted pick, once per configured chest.
  const custom = rg.buildDefaultRosterGenConfig();
  for (const b of custom.bands) {
    b.crateChances = { journeyman: 70, contender: 30, elite: 0, champion: 0, undisputed: 0, goat: 0 };
    b.crateCount = 3;
  }
  custom.rank1CrateCount = 0;
  localStorage.setItem(KEY, JSON.stringify(custom));

  const counts: Record<string, number> = {};
  let picks = 0;
  let alwaysThree = true;
  for (let i = 0; i < 2000; i++) {
    const won = rg.pickRewardCrates(50);
    if (won.length !== 3) alwaysThree = false;
    for (const id of won) { counts[id] = (counts[id] ?? 0) + 1; picks++; }
  }
  check("every win hands out the configured chest count", alwaysThree);
  const jm = ((counts["journeyman"] ?? 0) / picks) * 100;
  const ct = ((counts["contender"] ?? 0) / picks) * 100;
  check("70/30 odds respected (±3pp)", Math.abs(jm - 70) <= 3 && Math.abs(ct - 30) <= 3,
    `journeyman ${jm.toFixed(1)}%, contender ${ct.toFixed(1)}%`);
  check("0% crates never drop", Object.keys(counts).every(id => id === "journeyman" || id === "contender"),
    Object.keys(counts).join(","));
  check("a count of 0 awards nothing", rg.pickRewardCrates(1).length === 0);

  // Slider rebalance: every move must leave six non-negative integers on 100.
  const chancesOf = (o: Record<string, number>) => CRATE_IDS.map(id => o[id]);
  const valid = (o: Record<string, number>) =>
    chancesOf(o).every(v => Number.isInteger(v) && v >= 0) && sumOdds(o) === 100;

  const evenFour = { journeyman: 25, contender: 25, elite: 25, champion: 25, undisputed: 0, goat: 0 };
  const pushed = rg.rebalanceCrateChances(evenFour as never, "undisputed", 98);
  check("moving a slider to 98 keeps the row on 100", valid(pushed as never),
    JSON.stringify(pushed));

  const allZeroOthers = { journeyman: 100, contender: 0, elite: 0, champion: 0, undisputed: 0, goat: 0 };
  const spread = rg.rebalanceCrateChances(allZeroOthers as never, "journeyman", 34);
  check("zeroed others split the remainder evenly", valid(spread as never), JSON.stringify(spread));
  check("full drop to 0 still totals 100",
    valid(rg.rebalanceCrateChances(allZeroOthers as never, "journeyman", 0) as never));
  check("a single crate can take all 100",
    valid(rg.rebalanceCrateChances(evenFour as never, "goat", 100) as never));

  // Randomised slider walk — any starting split, any target, always lands on 100.
  let walk = rg.buildDefaultRosterGenConfig().bands[0].crateChances;
  let walkOk = true;
  let walkBad = "";
  for (let i = 0; i < 3000; i++) {
    const crate = CRATE_IDS[Math.floor(Math.random() * CRATE_IDS.length)];
    walk = rg.rebalanceCrateChances(walk, crate, Math.floor(Math.random() * 101));
    if (!valid(walk as never)) { walkOk = false; walkBad = JSON.stringify(walk); break; }
  }
  check("3000 random slider moves never leave 100", walkOk, walkBad);

  rg.clearRosterGenConfig();
})();

console.log("12. single-item rarity draws (sparring win rewards)");
(() => {
  // Every requested tier hands back an item of exactly that tier.
  for (const r of RARITIES) {
    let wrong = 0;
    for (let i = 0; i < 300; i++) {
      const drawn = rollItemOfRarity(r, { inventory: emptyInv(), items: fullCatalog });
      if (!drawn || drawn.rarity !== r) wrong++;
    }
    check(`${r} draw always returns a ${r} item`, wrong === 0, `${wrong}/300 wrong`);
  }

  // Rarity % still weights the pick inside the tier (50/30/20 catalog).
  const counts: Record<string, number> = {};
  for (let i = 0; i < 6000; i++) {
    const drawn = rollItemOfRarity("Elite", { inventory: emptyInv(), items: fullCatalog });
    if (drawn) counts[drawn.id] = (counts[drawn.id] ?? 0) + 1;
  }
  const pct = (id: string) => ((counts[id] ?? 0) / 6000) * 100;
  check("Rarity % weighting holds inside a single-item draw (±3pp)",
    Math.abs(pct("Elite-0") - 50) <= 3 && Math.abs(pct("Elite-1") - 30) <= 3 && Math.abs(pct("Elite-2") - 20) <= 3,
    JSON.stringify(counts));

  // Lifetime caps and one-time keepsakes are honoured.
  const cappedCatalog: ItemDefinition[] = [
    item({ id: "spent", rarity: "Journeyman", obtainableLimit: 1 }),
    item({ id: "fresh", rarity: "Journeyman", obtainableLimit: 1 }),
  ];
  let capBreaks = 0;
  for (let i = 0; i < 200; i++) {
    const drawn = rollItemOfRarity("Journeyman", {
      inventory: emptyInv({ lifetimeObtained: { spent: 1 } }),
      items: cappedCatalog,
    });
    if (drawn?.id !== "fresh") capBreaks++;
  }
  check("a maxed item is never handed out", capBreaks === 0, `${capBreaks}/200`);

  // An exhausted tier falls back to the nearest stocked one instead of nothing.
  const eliteOnly: ItemDefinition[] = [item({ id: "only-elite", rarity: "Elite", obtainableLimit: 9999 })];
  const fallback = rollItemOfRarity("Undisputed", { inventory: emptyInv(), items: eliteOnly });
  check("an empty tier falls back to the nearest stocked tier", fallback?.id === "only-elite", String(fallback?.id));

  // A catalog with nothing eligible yields no item rather than a bogus one.
  const nothing = rollItemOfRarity("Champion", {
    inventory: emptyInv({ lifetimeObtained: { "only-elite": 9999 } }),
    items: [item({ id: "only-elite", rarity: "Elite", obtainableLimit: 1 })],
  });
  check("an exhausted catalog returns nothing", nothing === null, String(nothing?.id));
})();

console.log("13. daily reward chests: one hand-out per calendar day, per rank band");
await (async () => {
  const drc = await import("../client/src/game/dailyRewardConfig");
  const {
    claimDailyReward, todayKey, dailyRewardAvailable,
    nextDailyResetAt, msUntilNextDailyReward, lastDailyRewardAt, formatDailyCountdown,
  } = await import("../client/src/lib/dailyReward");
  const localSaves = await import("../client/src/lib/localSaves");
  const { getInventory } = await import("../client/src/lib/itemInventory");
  const sumOdds = (c: Record<string, number>) => CRATE_IDS.reduce((s, id) => s + c[id], 0);
  const rosterOf = (id: string) => localSaves.getFighter(id)?.careerRosterState as Record<string, unknown> | undefined;

  const def = drc.buildDefaultDailyRewardConfig();
  check("defaults hand out one chest a day", def.bands.every(b => b.count === 1) && def.rank1Count === 1);
  check("default odds total 100",
    def.bands.every(b => sumOdds(b.chances) === 100) && sumOdds(def.rank1Chances) === 100);
  check("the chest count is capped at 999",
    drc.DAILY_CRATE_COUNT_MAX === 999 && drc.clampDailyCrateCount(5000) === 999 && drc.clampDailyCrateCount(-3) === 0);

  // A brand-new career sits one place below the whole roster (rank 705, where
  // the bands stop at 704), so an exact-match band lookup would hand day one
  // nothing. The bottom rung's chest is what an off-the-ladder rank gets.
  const bottom = def.bands.find(b => b.hiRank === 704 && b.loRank === 700);
  const fresh = drc.getDailyRewardForRank(705, def);
  check("a rank off the bottom of the ladder still gets a chest", fresh.count === 1, String(fresh.count));
  check("and it gets the bottom band's odds",
    !!bottom && CRATE_IDS.every(id => fresh.chances[id] === bottom.chances[id]));
  check("a fresh career draws a chest on its first day", drc.pickDailyCrates(705, Math.random, def).length === 1);

  // Saved odds and count drive the day's haul.
  const custom = drc.buildDefaultDailyRewardConfig();
  for (const b of custom.bands) {
    b.chances = { journeyman: 0, contender: 0, elite: 60, champion: 40, undisputed: 0, goat: 0 };
    b.count = 4;
  }
  custom.rank1Count = 0;
  drc.saveDailyRewardConfig(custom);

  const counts: Record<string, number> = {};
  let picks = 0;
  let alwaysFour = true;
  for (let i = 0; i < 1500; i++) {
    const won = drc.pickDailyCrates(50);
    if (won.length !== 4) alwaysFour = false;
    for (const id of won) { counts[id] = (counts[id] ?? 0) + 1; picks++; }
  }
  check("every day hands out the configured chest count", alwaysFour);
  const el = ((counts["elite"] ?? 0) / picks) * 100;
  check("60/40 odds respected (±3pp)", Math.abs(el - 60) <= 3, `elite ${el.toFixed(1)}%`);
  check("0% chests never drop", Object.keys(counts).every(id => id === "elite" || id === "champion"),
    Object.keys(counts).join(","));
  check("a band set to 0 chests awards nothing", drc.pickDailyCrates(1).length === 0);

  // The claim writes the items and stamps the day, once.
  const f = localSaves.createFighter({ name: "Daily Fighter" } as never);
  localSaves.updateFighter(f.id, { careerRosterState: { playerRank: 50 } } as never);
  check("an unclaimed day is available", dailyRewardAvailable(rosterOf(f.id) as never));

  const first = claimDailyReward(f.id);
  check("the day pays out its chests", (first?.crates.length ?? 0) === 4, `${first?.crates.length} chests`);
  const granted = (first?.crates ?? []).reduce((s, c) => s + c.itemIds.length, 0);
  const owned = Object.values(getInventory(localSaves.getFighter(f.id)).owned).reduce((a, b) => a + b, 0);
  check("every revealed item is already in the locker", granted > 0 && owned === granted, `${owned} owned / ${granted} shown`);
  check("the day is stamped on the roster state", rosterOf(f.id)?.lastDailyRewardDay === todayKey());
  check("the stamp rides alongside the rest of the roster blob", rosterOf(f.id)?.playerRank === 50);
  check("a second hub visit the same day pays nothing", claimDailyReward(f.id) === null);
  check("a claimed day is no longer available", !dailyRewardAvailable(rosterOf(f.id) as never));

  // The stamp is the entire lockout, and the roster blob is rewritten whole from
  // dozens of handlers. One holding a snapshot from before the claim must not be
  // able to rewind or drop the stamp and hand over a second lot the same day.
  localSaves.updateFighter(f.id, {
    careerRosterState: { ...rosterOf(f.id), lastDailyRewardDay: "2000-01-01" },
  } as never);
  check("a stale roster write can't rewind today's stamp",
    rosterOf(f.id)?.lastDailyRewardDay === todayKey());
  localSaves.updateFighter(f.id, { careerRosterState: { playerRank: 50 } } as never);
  check("nor drop it entirely", rosterOf(f.id)?.lastDailyRewardDay === todayKey());
  check("so the same day still pays nothing after one", claimDailyReward(f.id) === null);

  // A new calendar day pays out again. The stamp is planted on a career that has
  // never claimed rather than wound back on one that has, because winding a live
  // stamp back is exactly what the guard above refuses.
  const returning = localSaves.createFighter({ name: "Returning" } as never);
  localSaves.updateFighter(returning.id, {
    careerRosterState: { playerRank: 50, lastDailyRewardDay: "2000-01-01" },
  } as never);
  const second = claimDailyReward(returning.id);
  check("a new day pays out again", (second?.crates.length ?? 0) === 4, `${second?.crates.length} chests`);

  // Day one of a brand-new save: dead last, one place below the roster.
  const rookie = localSaves.createFighter({ name: "Rookie" } as never);
  localSaves.updateFighter(rookie.id, { careerRosterState: { playerRank: 705 } } as never);
  check("a new save's daily reward is unclaimed", dailyRewardAvailable(rosterOf(rookie.id) as never));
  const firstDay = claimDailyReward(rookie.id);
  check("a new player collects on the day they're created",
    (firstDay?.crates.length ?? 0) === 4, `${firstDay?.crates.length} chests`);
  const rookieItems = (firstDay?.crates ?? []).reduce((s, c) => s + c.itemIds.length, 0);
  check("and those chests hold items", rookieItems > 0, `${rookieItems} items`);

  // A career whose roster hasn't been built yet has no rank to look a band up
  // with: the day must be left alone rather than stamped away unseen.
  const unbuilt = localSaves.createFighter({ name: "Unbuilt" } as never);
  localSaves.updateFighter(unbuilt.id, { careerRosterState: { weekNumber: 0 } } as never);
  check("a career with no rank yet claims nothing", claimDailyReward(unbuilt.id) === null);
  check("and its day is left unstamped", rosterOf(unbuilt.id)?.lastDailyRewardDay === undefined);
  check("so it is still due once the roster exists", dailyRewardAvailable(rosterOf(unbuilt.id) as never));
  for (const bad of [NaN, Infinity, -Infinity, 0]) {
    localSaves.updateFighter(unbuilt.id, { careerRosterState: { playerRank: bad } } as never);
    check(`a rank of ${bad} claims nothing and burns no day`,
      claimDailyReward(unbuilt.id) === null && rosterOf(unbuilt.id)?.lastDailyRewardDay === undefined);
  }
  check("a rank that isn't a real number is owed nothing",
    drc.getDailyRewardForRank(NaN, def).count === 0 && drc.getDailyRewardForRank(Infinity, def).count === 0,
    `${drc.getDailyRewardForRank(NaN, def).count} / ${drc.getDailyRewardForRank(Infinity, def).count}`);

  // An empty band still stamps the day, so the hub doesn't re-roll on every visit.
  const zero = drc.buildDefaultDailyRewardConfig();
  for (const b of zero.bands) b.count = 0;
  zero.rank1Count = 0;
  drc.saveDailyRewardConfig(zero);
  const g = localSaves.createFighter({ name: "Zero Fighter" } as never);
  localSaves.updateFighter(g.id, { careerRosterState: { playerRank: 50 } } as never);
  const none = claimDailyReward(g.id);
  check("a zero band claims the day with no chests", none !== null && none.crates.length === 0);
  check("an empty day is still stamped", rosterOf(g.id)?.lastDailyRewardDay === todayKey());
  check("a stamped empty day doesn't re-roll", claimDailyReward(g.id) === null);

  // A save with no career at all is left alone.
  check("a fighter without a career claims nothing", claimDailyReward("nope") === null);

  // The clock: everything is worked out locally, so the reset lands on the
  // player's own midnight whether or not the game (or the machine) was running.
  const noon = new Date(2026, 2, 14, 12, 0, 0, 0);
  const resetAt = nextDailyResetAt(noon);
  const reset = new Date(resetAt);
  check("the reset is the next local midnight",
    reset.getHours() === 0 && reset.getMinutes() === 0 && reset.getSeconds() === 0
    && reset.getDate() === 15 && reset.getMonth() === 2,
    reset.toString());
  check("midday leaves 12h on the clock", msUntilNextDailyReward(noon) === 12 * 3600_000,
    String(msUntilNextDailyReward(noon)));
  const lateNight = new Date(2026, 2, 14, 23, 59, 30, 0);
  check("half a minute before midnight leaves 30s", msUntilNextDailyReward(lateNight) === 30_000,
    String(msUntilNextDailyReward(lateNight)));
  const justAfter = new Date(2026, 2, 15, 0, 0, 1, 0);
  check("a day rolls over at 00:00, not on a 24h timer",
    todayKey(lateNight) !== todayKey(justAfter));
  check("the countdown never goes negative", msUntilNextDailyReward(justAfter) > 0);
  // Month and year ends must not be walked past with plain arithmetic.
  const yearEnd = new Date(2026, 11, 31, 23, 0, 0, 0);
  const yearReset = new Date(nextDailyResetAt(yearEnd));
  check("the reset crosses a year boundary cleanly",
    yearReset.getFullYear() === 2027 && yearReset.getMonth() === 0 && yearReset.getDate() === 1,
    yearReset.toString());

  check("countdowns read as hours, minutes then seconds",
    formatDailyCountdown(7 * 3600_000 + 12 * 60_000) === "7h 12m"
    && formatDailyCountdown(12 * 60_000 + 5_000) === "12m 05s"
    && formatDailyCountdown(45_000) === "45s"
    && formatDailyCountdown(-5) === "0s",
    [formatDailyCountdown(7 * 3600_000 + 12 * 60_000), formatDailyCountdown(12 * 60_000 + 5_000),
      formatDailyCountdown(45_000), formatDailyCountdown(-5)].join(" | "));

  // The claim timestamp is what "last reward" is read from, offline included.
  const stampedAt = rosterOf(f.id)?.lastDailyRewardAt as number | undefined;
  check("the claim records when it happened",
    typeof stampedAt === "number" && Math.abs(Date.now() - stampedAt) < 60_000, String(stampedAt));
  check("last reward reads back off the save", lastDailyRewardAt(rosterOf(f.id) as never) === stampedAt);
  const legacy = { playerRank: 50, lastDailyRewardDay: "2026-03-14" };
  const legacyAt = lastDailyRewardAt(legacy as never);
  check("a save from before the timestamp falls back to that day's midnight",
    legacyAt === new Date(2026, 2, 14, 0, 0, 0, 0).getTime(), String(legacyAt));
  check("a career that never claimed has no last reward", lastDailyRewardAt({ playerRank: 50 } as never) === null);

  // Winding the device clock back must not hand the chests over again.
  const tomorrow = todayKey(new Date(Date.now() + 86_400_000));
  const nextWeek = todayKey(new Date(Date.now() + 7 * 86_400_000));
  const setStamp = (day: string, at?: number) => localSaves.updateFighter(f.id, {
    careerRosterState: { ...rosterOf(f.id), lastDailyRewardDay: day, lastDailyRewardAt: at },
  } as never);
  setStamp(tomorrow, Date.now() + 86_400_000);
  check("a day already claimed on a faster clock is not due again",
    !dailyRewardAvailable(rosterOf(f.id) as never));
  check("and rolling the clock back pays nothing", claimDailyReward(f.id) === null);
  setStamp(nextWeek, Date.now() + 7 * 86_400_000);
  check("a week of rollback still pays nothing", claimDailyReward(f.id) === null);
  check("the stamp is left where it was", rosterOf(f.id)?.lastDailyRewardDay === nextWeek);
  // A legacy save carries no timestamp, so the day stamp alone has to hold.
  setStamp(nextWeek, undefined);
  check("a legacy save can't be farmed by rollback either", claimDailyReward(f.id) === null);
  // A clock that was wildly wrong when it stamped heals rather than locking out.
  const wayAhead = todayKey(new Date(Date.now() + 400 * 86_400_000));
  setStamp(wayAhead, Date.now() + 400 * 86_400_000);
  check("a stamp from a badly broken clock doesn't lock the chests away forever",
    dailyRewardAvailable(rosterOf(f.id) as never));
  // (the config is on a zero band by this point, so the claim is taken but empty)
  const healed = claimDailyReward(f.id);
  check("and that claim is taken", healed !== null);
  check("re-stamped to today", rosterOf(f.id)?.lastDailyRewardDay === todayKey());
  check("today's claim is then done", claimDailyReward(f.id) === null);

  drc.clearDailyRewardConfig();
  check("clearing the config restores the defaults",
    drc.loadDailyRewardConfig().bands.every(b => b.count === 1));
})();

console.log("14. refinement tomes stop dropping once every category is maxed");
await (async () => {
  const store: Record<string, string> = {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { for (const k of Object.keys(store)) delete store[k]; },
    key: () => null,
    length: 0,
  };
  // Real tome ids, so the effect table resolves their refinement grant.
  const TOME_IDS = ["journeyman", "contender", "elite", "champion", "undisputed", "goat"]
    .map(k => `refinement_tome_${k}`);
  const tomes = RARITIES.map((r, i) => item({
    id: TOME_IDS[i], rarity: r, isConsumable: true, obtainableLimit: 9999, rarityPercent: 50,
  }));
  store["handz_items_config"] = JSON.stringify([...fullCatalog, ...tomes]);

  const localSaves = await import("../client/src/lib/localSaves");
  const { rollCrateForFighter, rollRarityItemForFighter, isRefinementMaxed, REFINEMENT_CATEGORIES, REFINEMENT_MAX } =
    await import("../client/src/lib/itemInventory");

  const refWith = (over: Record<string, number> = {}) => {
    const ref: Record<string, unknown> = { availablePoints: 0 };
    for (const cat of REFINEMENT_CATEGORIES) ref[cat] = REFINEMENT_MAX;
    return { ...ref, ...over };
  };
  const tomesIn = (id: string, runs: number) => {
    let seen = 0;
    for (let n = 0; n < runs; n++) {
      const f = localSaves.getFighter(id);
      const drawn = rollCrateForFighter(f, "champion", 40);
      seen += drawn.itemIds.filter(i => TOME_IDS.includes(i)).length;
    }
    return seen;
  };

  const created = localSaves.createFighter({ name: "Tome Check" } as never);
  localSaves.updateFighter(created.id, { skillRefinement: refWith() } as never);
  check("a fully maxed career reads as maxed", isRefinementMaxed(localSaves.getFighter(created.id)));
  check("no chest hands out a refinement tome", tomesIn(created.id, 150) === 0);
  let looseTomes = 0;
  for (let n = 0; n < 150; n++) {
    const one = rollRarityItemForFighter(localSaves.getFighter(created.id), "Elite", 40);
    looseTomes += one.itemIds.filter(i => TOME_IDS.includes(i)).length;
  }
  check("nor a single-item reward draw", looseTomes === 0);

  // One point short anywhere and the tomes are worth having again.
  localSaves.updateFighter(created.id, { skillRefinement: refWith({ ironChin: REFINEMENT_MAX - 1 }) } as never);
  check("one category short is not maxed", !isRefinementMaxed(localSaves.getFighter(created.id)));
  check("and tomes drop again", tomesIn(created.id, 150) > 0);

  // The lockout rides the save itself, so it survives a download/upload.
  localSaves.updateFighter(created.id, { skillRefinement: refWith() } as never);
  const file = localSaves.exportSaveFile(localSaves.getFighter(created.id)!);
  localSaves.deleteFighter(created.id);
  const imported = localSaves.importSaveFile(file);
  check("an imported save is still maxed", isRefinementMaxed(localSaves.getFighter(imported.id)));
  check("and its chests still hold no tomes", tomesIn(imported.id, 150) === 0);
})();

console.log(failures === 0 ? "\nAll crate roll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
