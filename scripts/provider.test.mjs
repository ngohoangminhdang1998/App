import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cap = readFileSync(join(root, "dist", "providers", "capabilities.js"), "utf8");
assert.match(cap, /GOOGLE_FLOW_CAPABILITIES/);
assert.match(cap, /MUSE_CAPABILITIES/);
assert.match(cap, /flowSceneMerge: true/);
assert.match(cap, /flowSceneMerge: false/);
console.log("provider.test.mjs OK");