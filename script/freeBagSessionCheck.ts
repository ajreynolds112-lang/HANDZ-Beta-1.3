import assert from "node:assert/strict";
import { bagPunchLabel, getTopBagCombos, type BagSessionPunch } from "../client/src/game/freeBagSession";

const punch = (type: BagSessionPunch["type"], head = true): BagSessionPunch => ({ type, head });
const a = [punch("jab"), punch("cross"), punch("leftHook")];
const b = [punch("cross"), punch("jab"), punch("rightHook", false)];
const c = [punch("leftUppercut"), punch("rightUppercut"), punch("jab")];
const d = [punch("jab", false), punch("cross"), punch("leftHook")];

assert.deepEqual(getTopBagCombos([]), []);
assert.deepEqual(getTopBagCombos(a.slice(0, 2)), []);
assert.equal(getTopBagCombos([...a, ...a, ...b, punch("jab")])[0].count, 2);
assert.equal(getTopBagCombos([...a, ...b]).length, 2, "no overlapping strings");
const ranked = getTopBagCombos([...a, ...b, ...c, ...d, ...a, ...b, ...a]);
assert.deepEqual(ranked.map(x => x.count), [3, 2, 1]);
assert.equal(ranked[0].label, a.map(bagPunchLabel).join(" → "));
assert.equal(ranked[1].label, b.map(bagPunchLabel).join(" → "));
assert.equal(ranked[2].label, c.map(bagPunchLabel).join(" → "), "ties keep first occurrence");
assert.equal(getTopBagCombos([...a, ...d]).length, 2, "head and body are distinct");
assert.equal(bagPunchLabel(punch("rightUppercut", false)), "Body Right Uppercut");
assert.equal(bagPunchLabel(punch("jab")), "Jab");
console.log("All free bag session checks passed.");
