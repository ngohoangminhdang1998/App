import assert from "node:assert/strict";
import { timelineHasClip, parseAspectToggleLabel, combineTimelineClipCount } from "../dist/scene-builder.js";

assert.equal(parseAspectToggleLabel("16:9"), "16:9");
assert.equal(parseAspectToggleLabel("9:16"), "9:16");
assert.equal(parseAspectToggleLabel("Aspect 16:9"), "16:9");
assert.equal(parseAspectToggleLabel(""), undefined);

assert.equal(timelineHasClip(["MyFilm-scene-01"], "MyFilm-scene-01"), true);
assert.equal(timelineHasClip(["Other"], "MyFilm-scene-01"), false);
assert.equal(timelineHasClip(["MyFilm-scene-01", "MyFilm-scene-02"], "MyFilm-scene-02"), true);

assert.equal(combineTimelineClipCount(4, 2, 3, 0), 5);
assert.equal(combineTimelineClipCount(2, 2, 3, 5), 5);
assert.equal(combineTimelineClipCount(5, 2, 0, 0), 5);
assert.equal(combineTimelineClipCount(0, 0, 0, 5), 0);

console.log("flow-scene-builder.test.mjs OK");