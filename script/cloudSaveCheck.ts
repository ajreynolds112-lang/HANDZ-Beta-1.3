import assert from "node:assert/strict";
import { validateCareerSave, cloudWriteSchema, isCareerStorageKey } from "../shared/cloudSave";

const save = { version: 1, fighter: { id: "fighter-1", name: "Test", archetype: "BoxerPuncher", level: 1, xp: 0, wins: 0, losses: 0, draws: 0, knockouts: 0, skillPoints: null }, fightResults: [], browserState: { handz_gym_state: "{}" } };
assert.equal(validateCareerSave(save).fighter.name, "Test");
assert.throws(() => validateCareerSave({ ...save, version: 2 }));
assert.throws(() => validateCareerSave({ ...save, fighter: { ...save.fighter, level: -1 } }));
assert.throws(() => validateCareerSave({ ...save, browserState: { handz_cloud_guest: "{}" } }));
assert.throws(() => validateCareerSave({ ...save, browserState: { handz_career_pins: "{}" } }));
assert.throws(() => validateCareerSave(JSON.parse('{"version":1,"fighter":{"id":"f","name":"x","archetype":"BoxerPuncher","level":1,"__proto__":{}},"fightResults":[]}')));
assert(!isCareerStorageKey("session_token"));
assert(!isCareerStorageKey("handz_cloud_session"));
assert(isCareerStorageKey("handz_saves"));
assert(cloudWriteSchema.safeParse({ revision: 0, save, reason: "autosave" }).success);
assert(!cloudWriteSchema.safeParse({ revision: 1, save, reason: "import" }).success);
assert(!cloudWriteSchema.safeParse({ revision: 1, save, reason: "import", confirmations: ["replace-career"] }).success);
assert(cloudWriteSchema.safeParse({ revision: 1, save, reason: "import", confirmations: ["replace-career", "replace-cloud-save"] }).success);
assert(!cloudWriteSchema.safeParse({ revision: -1, save, reason: "autosave" }).success);
console.log("Cloud save validation and double-confirmation checks passed.");
