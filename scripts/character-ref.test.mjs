import assert from "node:assert/strict";
import { cleanDisplayName, migrateRefSlot, mergePickerRows, voiceStatus } from "../dist/film-script.js";
import { optionHasNamePrefix, optionIsExactMedia } from "../dist/media-ref.js";

const TEDDY_ID = "2cd17a99-255e-4a7e-bf81-819133d181bc";

assert.equal(cleanDisplayName("Teddy Ngo favorite"), "Teddy Ngo");
const picker = mergePickerRows(
  [{ name: "Teddy Ngo favorite", voice: "fenrir", characterId: TEDDY_ID, projectId: "a18b9ba5-b6f5-4b9b-9826-e4a9ca09aa3d" }],
  [],
);
assert.equal(picker[0].displayName, "Teddy Ngo");
assert.equal(picker[0].assetId, TEDDY_ID);
assert.equal(voiceStatus(picker[0]), "Voice: fenrir");

const migrated = migrateRefSlot(
  { asset: "Teddy Ngo favorite", assetName: "Teddy Ngo favorite", assetType: "character", kind: "character" },
  picker,
);
assert.equal(migrated.displayName, "Teddy Ngo");
assert.equal(migrated.assetId, TEDDY_ID);
assert.equal(migrated.needsReselect, false);

const missing = migrateRefSlot(
  { assetId: "00000000-0000-4000-8000-000000000099", assetName: "Ghost", assetType: "character" },
  picker,
);
assert.equal(missing.needsReselect, true);

assert.ok(optionIsExactMedia("Teddy Ngo Avatar", "Teddy Ngo"));
assert.ok(optionHasNamePrefix("Teddy Ngo Avatar", "Teddy Ngo"));

console.log("character-ref tests passed");