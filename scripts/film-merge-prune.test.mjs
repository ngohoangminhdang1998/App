import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { pruneProjectVideosExceptFinal } from "../dist/film-merge-local.js";

const dir = mkdtempSync(join(tmpdir(), "flow-prune-"));
mkdirSync(dir, { recursive: true });
const finalPath = join(dir, "0001-Final.mp4");
writeFileSync(finalPath, Buffer.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]));
writeFileSync(join(dir, "scene-01.mp4"), Buffer.from([1]));
writeFileSync(join(dir, "scene-02.webm"), Buffer.from([2]));
writeFileSync(join(dir, "clip-03.mp4"), Buffer.from([3]));
writeFileSync(join(dir, "0000-Final.mp4"), Buffer.from([4]));
writeFileSync(join(dir, "scene-01.jpeg"), Buffer.from([5]));

const { removed, kept } = pruneProjectVideosExceptFinal(dir, finalPath);
assert.equal(kept, finalPath);
assert.equal(removed.length, 4);
assert.ok(existsSync(finalPath));
assert.ok(existsSync(join(dir, "scene-01.jpeg")));
assert.ok(!existsSync(join(dir, "scene-01.mp4")));

console.log("film-merge-prune.test.mjs OK");