import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "flow-mcp-composition-"));
const prevHome = process.env.FLOW_MCP_HOME;
const prevMock = process.env.FLOW_MCP_MERGE_MOCK;
process.env.FLOW_MCP_HOME = home;
process.env.FLOW_MCP_MERGE_MOCK = "1";

const { contentHashFromTitles, getComposition, saveComposition, cacheIsValid } = await import("../dist/flow-composition.js");
const { mergeClipsIntoFlowScene, downloadFlowComposition } = await import("../dist/flow.js");

assert.equal(contentHashFromTitles(["a", "b"]), contentHashFromTitles(["a", "b"]));
assert.notEqual(contentHashFromTitles(["a", "b"]), contentHashFromTitles(["a", "c"]));

const rec = await mergeClipsIntoFlowScene({
  tedverseProject: "Demo",
  clips: [{ stem: "scene-01", flow_title: "Demo-scene-01" }, { stem: "scene-02" }],
});
assert.equal(rec.merge_status, "completed");
assert.equal(rec.publish_status, "ready_to_publish");
assert.equal(rec.composition_name, "Final");
assert.equal(rec.scene_count, 2);
assert.equal(getComposition("Demo")?.composition_id, rec.composition_id);

const stem = join(home, "out", "Demo", "Demo-final");
const path = await downloadFlowComposition(rec, stem);
assert.match(path, /\.mp4$/i);
saveComposition({ ...rec, cached_video_path: path, cached_video_hash: rec.content_hash });
assert.equal(cacheIsValid(getComposition("Demo")), true);

try {
  if (prevHome === undefined) delete process.env.FLOW_MCP_HOME;
  else process.env.FLOW_MCP_HOME = prevHome;
  if (prevMock === undefined) delete process.env.FLOW_MCP_MERGE_MOCK;
  else process.env.FLOW_MCP_MERGE_MOCK = prevMock;
  rmSync(home, { recursive: true, force: true });
} catch { /* temp */ }

console.log("flow-composition.test.mjs OK");