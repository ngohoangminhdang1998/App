import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildFinalPublishText,
  buildPublishText,
  normalizeHashtags,
  validatePublishTextForPlatforms,
} from "../dist/publish-text.js";
import { publishManager } from "../dist/publish.js";

assert.deepEqual(normalizeHashtags("#AI #ShortFilm #AI"), ["#AI", "#ShortFilm"]);
assert.deepEqual(normalizeHashtags("AI, ShortFilm"), ["#AI", "#ShortFilm"]);
assert.deepEqual(normalizeHashtags("#Việt #việt"), ["#Việt"]);
assert.equal(buildFinalPublishText("Khi nào ăn cơm", ["#trend", "#ai"]), "Khi nào ăn cơm #trend #ai");
assert.equal(buildFinalPublishText("ABCD", []), "ABCD");
assert.equal(buildPublishText("ABCD", ["#AI", "#ShortFilm"]), "ABCD #AI #ShortFilm");

assert.throws(
  () => validatePublishTextForPlatforms(["youtube"], "x".repeat(101)),
  /YouTube Shorts title/,
);
assert.doesNotThrow(() => validatePublishTextForPlatforms(["tiktok"], "Khi nào ăn cơm #trend #ai"));

const home = mkdtempSync(join(tmpdir(), "flow-mcp-publish-"));
const prevHome = process.env.FLOW_MCP_HOME;
const prevMock = process.env.FLOW_MCP_PUBLISH_MOCK;
process.env.FLOW_MCP_HOME = home;
process.env.FLOW_MCP_PUBLISH_MOCK = "1";

const dir = join(home, "out", "MockFilm");
mkdirSync(dir, { recursive: true });
const video = join(dir, "MockFilm-final.mp4");
writeFileSync(video, "ftypmock", "utf8");

try {
  const rec = await publishManager.publish({
    project: "MockFilm",
    video,
    platforms: ["tiktok"],
    caption: "MockFilm",
    hashtags: ["#Test"],
  });
  assert.equal(rec.platforms.tiktok.status, "published");
  assert.match(rec.platforms.tiktok.url ?? "", /example\.test\/tiktok/);
  assert.equal(rec.platforms.youtube.status, "not_published");
  await assert.rejects(
    publishManager.publish({ project: "MockFilm", video, platforms: [], caption: "x", hashtags: [] }),
    /Select at least one platform/,
  );
} finally {
  if (prevHome === undefined) delete process.env.FLOW_MCP_HOME;
  else process.env.FLOW_MCP_HOME = prevHome;
  if (prevMock === undefined) delete process.env.FLOW_MCP_PUBLISH_MOCK;
  else process.env.FLOW_MCP_PUBLISH_MOCK = prevMock;
  rmSync(home, { recursive: true, force: true });
}

console.log("publish.test.mjs OK");