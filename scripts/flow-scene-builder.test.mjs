import assert from "node:assert/strict";
import { timelineHasClip, parseAspectToggleLabel } from "../dist/scene-builder.js";

assert.equal(parseAspectToggleLabel("16:9"), "16:9");
assert.equal(parseAspectToggleLabel("9:16"), "9:16");
assert.equal(parseAspectToggleLabel("Aspect 16:9"), "16:9");
assert.equal(parseAspectToggleLabel(""), undefined);

assert.equal(timelineHasClip(["MyFilm-scene-01"], "MyFilm-scene-01"), true);
assert.equal(timelineHasClip(["Other"], "MyFilm-scene-01"), false);
assert.equal(timelineHasClip(["MyFilm-scene-01", "MyFilm-scene-02"], "MyFilm-scene-02"), true);

console.log("flow-scene-builder.test.mjs OK");