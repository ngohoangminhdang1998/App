import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { resolveFfmpegBinary } from "../../platform.js";

export function assertPublishVideoFile(path: string): void {
  if (!existsSync(path)) throw new Error(`Video not found: ${path}`);
  if (!/\.(mp4|webm|mov)$/i.test(path)) throw new Error("Only MP4/WebM/MOV videos can be published.");
  const size = statSync(path).size;
  if (size < 1024) throw new Error("Video file is too small — download may have failed.");
  try {
    const ffprobe = resolveFfmpegBinary("ffprobe");
    const out = execFileSync(
      ffprobe,
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
      { encoding: "utf8", timeout: 15_000 },
    ).trim();
    const dur = Number(out);
    if (!Number.isFinite(dur) || dur <= 0) throw new Error("ffprobe could not read a video stream.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Video file is not a valid clip: ${msg}`);
  }
}