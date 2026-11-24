import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { extractZip, FFMPEG_HINT, resolveFfmpegBinary } from "./platform.js";

export type MediaSniff =
  | { kind: "mp4"; ext: ".mp4"; video: true }
  | { kind: "webm"; ext: ".webm"; video: true }
  | { kind: "zip"; ext: ".zip"; video: false }
  | { kind: "jpeg"; ext: ".jpeg"; video: false }
  | { kind: "png"; ext: ".png"; video: false }
  | { kind: "webp"; ext: ".webp"; video: false }
  | { kind: "gif"; ext: ".gif"; video: false }
  | { kind: "unknown"; ext: ".bin"; video: false };

export function readHead(file: string, len = 12): Buffer {
  const head = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, head, 0, len, 0);
  } finally {
    closeSync(fd);
  }
  return head;
}

/** Magic-byte sniffing — never trust the filename Chrome gives a blob download. */
export function sniffMediaFile(file: string): MediaSniff {
  const head = readHead(file);
  if (head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return { kind: "webm", ext: ".webm", video: true };
  if (head.subarray(4, 8).toString("latin1") === "ftyp") return { kind: "mp4", ext: ".mp4", video: true };
  if (head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04) return { kind: "zip", ext: ".zip", video: false };
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return { kind: "jpeg", ext: ".jpeg", video: false };
  if (head[0] === 0x89 && head.subarray(1, 4).toString("latin1") === "PNG") return { kind: "png", ext: ".png", video: false };
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return { kind: "webp", ext: ".webp", video: false };
  if (head.subarray(0, 4).toString("latin1") === "GIF8") return { kind: "gif", ext: ".gif", video: false };
  return { kind: "unknown", ext: ".bin", video: false };
}

export function validatePlayableVideo(file: string): number {
  if (!existsSync(file)) throw new Error(`Missing file: ${basename(file)}`);
  const sniff = sniffMediaFile(file);
  if (!sniff.video) throw new Error(`"${basename(file)}" is not a video (${sniff.kind}).`);
  let stdout: string;
  const ffprobe = resolveFfmpegBinary("ffprobe");
  try {
    stdout = execFileSync(ffprobe, ["-v", "error", "-show_entries", "stream=codec_type:format=duration", "-of", "json", file], { encoding: "utf8" });
  } catch (err) {
    try {
      execFileSync(ffprobe, ["-version"], { stdio: "ignore", timeout: 8000 });
    } catch {
      throw new Error(
        `ffprobe is not installed (merge & publish need ffmpeg). Try: ${FFMPEG_HINT}, or download ffmpeg+ffprobe from https://evermeet.cx/ffmpeg/ into ~/bin and add to PATH.`,
      );
    }
    throw new Error(`"${basename(file)}" isn't a playable video — ffprobe could not read it.`);
  }
  const data = JSON.parse(stdout) as { streams?: { codec_type: string; duration?: string }[]; format?: { duration?: string } };
  const hasVideo = data.streams?.some((s) => s.codec_type === "video");
  if (!hasVideo) throw new Error(`"${basename(file)}" has no video stream.`);
  const v = data.streams?.find((s) => s.codec_type === "video");
  const duration = Number(v?.duration ?? data.format?.duration ?? 0);
  if (!duration || duration <= 0) throw new Error(`"${basename(file)}" has no duration — the download may be incomplete.`);
  return duration;
}

function isPlayableVideo(file: string): boolean {
  try {
    validatePlayableVideo(file);
    return true;
  } catch {
    return false;
  }
}

export interface FinalizeOptions {
  /** Replace a target only when the existing file is missing or invalid. */
  overwrite?: boolean;
  /** When a ZIP holds several takes, keep this many starting at the first (default 1 = first take only). */
  zipTakeCount?: number;
}

function assertCanWrite(target: string, overwrite?: boolean) {
  if (!existsSync(target)) return;
  if (overwrite || !isPlayableVideo(target)) return;
  throw new Error(`"${basename(target)}" already exists and is a valid video. Re-download with force, or pick another name.`);
}

function unpackZipTakes(zip: string, targetStem: string, takeCount = 1): string[] {
  const work = mkdtempSync(join(tmpdir(), "flow-takes-"));
  const takes = extractZip(zip, work)
    .map((p) => ({ p, sniff: sniffMediaFile(p) }))
    .filter((t) => t.sniff.video)
    .sort((a, b) => a.p.localeCompare(b.p, undefined, { numeric: true }));
  if (!takes.length) throw new Error("Flow sent a ZIP with no playable video inside.");
  const out: string[] = [];
  const n = Math.min(Math.max(1, takeCount), takes.length);
  for (let i = 0; i < n; i++) {
    const dest = `${targetStem}${i ? `-v${i + 1}` : ""}${takes[i].sniff.ext}`;
    assertCanWrite(dest, true);
    renameSync(takes[i].p, dest);
    validatePlayableVideo(dest);
    out.push(dest);
  }
  try {
    renameSync(zip, `${targetStem}-takes.zip`);
  } catch {
    rmSync(zip, { force: true });
  }
  rmSync(work, { recursive: true, force: true });
  return out;
}

/**
 * Turns a raw browser download (any name, often a UUID with no extension) into correctly named project files.
 */
export function finalizeFlowDownload(rawPath: string, targetStem: string, opts: FinalizeOptions = {}): string[] {
  if (!existsSync(rawPath)) throw new Error("Download did not land on disk.");
  if (statSync(rawPath).size <= 0) throw new Error("Download is empty.");
  mkdirSync(dirname(targetStem), { recursive: true });
  const sniff = sniffMediaFile(rawPath);
  if (sniff.kind === "zip") {
    const zipDest = `${targetStem}-takes.zip`;
    if (rawPath !== zipDest) renameSync(rawPath, zipDest);
    return unpackZipTakes(zipDest, targetStem, opts.zipTakeCount ?? 1);
  }
  const target = `${targetStem}${sniff.ext}`;
  assertCanWrite(target, opts.overwrite);
  if (sniff.video) {
    renameSync(rawPath, target);
    validatePlayableVideo(target);
    return [target];
  }
  if (sniff.kind !== "unknown") {
    renameSync(rawPath, target);
    return [target];
  }
  const invalid = `${targetStem}${sniff.ext}`;
  renameSync(rawPath, invalid);
  throw new Error(`Download format is not recognized (${sniff.kind}). Kept as ${basename(invalid)} for inspection.`);
}

const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v"]);

export interface RepairResult {
  dir: string;
  repaired: string[];
  alreadyValid: string[];
  stillInvalid: { path: string; reason: string }[];
}

export function repairProjectDownloads(dir: string): RepairResult {
  if (!existsSync(dir)) throw new Error(`Project folder not found: ${dir}`);
  const repaired: string[] = [];
  const alreadyValid: string[] = [];
  const stillInvalid: { path: string; reason: string }[] = [];
  const entries = readdirSync(dir).map((f) => join(dir, f)).filter((p) => statSync(p).isFile());
  const stems = new Map<string, string>();

  for (const path of entries) {
    const base = basename(path);
    const ext = extname(path).toLowerCase();
    const stemKey = base.replace(/-v\d+$/i, "").replace(/\.[^.]+$/, "");
    if (ext === ".zip" && /takes\.zip$/i.test(base)) {
      try {
        const stem = join(dir, base.replace(/-takes\.zip$/i, ""));
        repaired.push(...unpackZipTakes(path, stem, 1));
        continue;
      } catch (err) {
        stillInvalid.push({ path, reason: err instanceof Error ? err.message : String(err) });
        continue;
      }
    }
    if (!ext || !VIDEO_EXT.has(ext) || ext === ".bin") {
      try {
        const sniff = sniffMediaFile(path);
        if (sniff.video) {
          const target = join(dir, `${stemKey}${sniff.ext}`);
          assertCanWrite(target, true);
          if (path !== target) renameSync(path, target);
          validatePlayableVideo(target);
          repaired.push(target);
          continue;
        }
        if (sniff.kind === "zip") {
          const stem = join(dir, stemKey);
          repaired.push(...unpackZipTakes(path, stem, 1));
          continue;
        }
        stillInvalid.push({ path, reason: `Unrecognized format (${sniff.kind})` });
      } catch (err) {
        stillInvalid.push({ path, reason: err instanceof Error ? err.message : String(err) });
      }
      continue;
    }
    if (isPlayableVideo(path)) {
      alreadyValid.push(path);
      stems.set(stemKey, path);
      continue;
    }
    try {
      const sniff = sniffMediaFile(path);
      if (sniff.video) {
        const target = join(dir, `${stemKey}${sniff.ext}`);
        if (path !== target) {
          assertCanWrite(target, true);
          renameSync(path, target);
        }
        validatePlayableVideo(target);
        repaired.push(target);
        continue;
      }
      stillInvalid.push({ path, reason: `Looks like ${sniff.kind}, not a playable video` });
    } catch (err) {
      stillInvalid.push({ path, reason: err instanceof Error ? err.message : String(err) });
    }
  }
  return { dir, repaired, alreadyValid, stillInvalid };
}