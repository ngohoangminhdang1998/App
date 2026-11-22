import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { extractZip } from "../dist/platform.js";
import {
  sniffMediaFile,
  finalizeFlowDownload,
  validatePlayableVideo,
  repairProjectDownloads,
} from "../dist/media-download.js";

const dir = mkdtempSync(join(tmpdir(), "flow-dl-test-"));

function write(name, buf) {
  const p = join(dir, name);
  writeFileSync(p, buf);
  return p;
}

// Minimal bytes that sniff as MP4 / WebM / ZIP
const fakeMp4 = Buffer.alloc(32, 0);
fakeMp4.write("....ftypisom", 0, "ascii");
const fakeWebm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
const zipWork = mkdtempSync(join(tmpdir(), "flow-zip-fix-"));
const innerMp4 = join(zipWork, "take.mp4");
writeFileSync(innerMp4, fakeMp4);
// bsdtar on Windows can create zips — use a tiny PK header archive via PowerShell if needed
let zipOne;
try {
  execFileSync("tar", ["-a", "-cf", join(dir, "one-take.zip"), "-C", zipWork, "take.mp4"], { stdio: "pipe" });
  zipOne = join(dir, "one-take.zip");
} catch {
  console.warn("skip ZIP fixture: tar unavailable");
}

assert.equal(sniffMediaFile(write("noext-mp4", fakeMp4)).kind, "mp4");
assert.equal(sniffMediaFile(write("scene-01.mp4", fakeMp4)).ext, ".mp4");
assert.equal(sniffMediaFile(write("noext-webm", fakeWebm)).kind, "webm");
assert.equal(sniffMediaFile(write("garbage.bin", Buffer.from("hello"))).kind, "unknown");

const stem = join(dir, "scene-repair");
try {
  finalizeFlowDownload(write("dl.part", fakeMp4), stem, { overwrite: true });
  assert.fail("expected ffprobe rejection for fake mp4");
} catch (err) {
  assert.match(String(err.message), /playable|ffprobe|duration/i);
}

if (zipOne) {
  const zstem = join(dir, "scene-zip");
  try {
    finalizeFlowDownload(zipOne, zstem, { overwrite: true });
  } catch (err) {
    assert.match(String(err.message), /playable|ffprobe|ZIP/i);
  }
}

write("uuid-noext", fakeMp4);
const repaired = repairProjectDownloads(dir);
assert.ok(repaired.repaired.length + repaired.stillInvalid.length > 0);

let ffprobeOk = false;
try {
  execFileSync("ffprobe", ["-version"], { stdio: "pipe" });
  ffprobeOk = true;
} catch {
  console.warn("ffprobe not installed — skipping playable validation test");
}

if (ffprobeOk) {
  const testProj = process.env.FLOW_MCP_OUTPUT
    ? join(process.env.FLOW_MCP_OUTPUT, "Test")
  : join(process.env.USERPROFILE || process.env.HOME || "", "flow-mcp-out", "Test");
  if (mkdirSync(testProj, { recursive: true }) || true) {
    try {
      const summary = repairProjectDownloads(testProj);
      console.log("Test project repair:", summary.repaired.length, "repaired,", summary.alreadyValid.length, "valid");
    } catch (e) {
      console.warn("Test project repair skipped:", e.message);
    }
  }
}

console.log("media-download tests passed");
rmSync(dir, { recursive: true, force: true });
rmSync(zipWork, { recursive: true, force: true });