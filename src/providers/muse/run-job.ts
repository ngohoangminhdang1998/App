import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job } from "../../queue.js";
import { getMuse } from "./muse-driver.js";

function extFor(contentType: string, type: "video" | "image"): string {
  if (type === "video") return ".mp4";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("png")) return ".png";
  return ".jpg";
}

function refsFromJob(job: Job): { path: string }[] {
  const out: { path: string }[] = [];
  for (const p of [job.params.first_frame, ...(job.params.reference_images ?? [])]) {
    if (p && !p.startsWith("asset:") && !p.startsWith("title:")) out.push({ path: p });
  }
  return out.slice(0, 3);
}

/** Queue runner path for Muse — serial chat automation, files written under output_dir. */
export async function runMuseJob(job: Job): Promise<string[]> {
  const muse = getMuse(false, "en");
  const aspect = job.params.aspect_ratio === "9:16" ? "9:16" : job.params.aspect_ratio === "1:1" ? "1:1" : "16:9";
  const carry = Boolean(job.params.chain_from || job.params.reference_from);
  const refs = refsFromJob(job);
  const base = join(job.params.output_dir, job.params.file_stem);

  if (job.params.type === "image") {
    const img = await muse.generateImage({
      prompt: job.params.prompt,
      aspect,
      refs: refs.length ? refs : undefined,
      carryCharacter: carry && !refs.length,
      previousFrame: Boolean(job.params.first_frame && refs.length),
      newChat: !carry && refs.length === 0,
    });
    const path = `${base}${extFor(img.contentType, "image")}`;
    writeFileSync(path, img.buffer);
    job.note = `Muse image ${img.width}×${img.height}`;
    return [path];
  }

  const vid = await muse.generateVideo({
    prompt: job.params.prompt,
    refs: refs.length ? refs : undefined,
    carryCharacter: carry && !refs.length,
    newChat: false,
    durationSec: job.params.duration ?? 10,
  });
  const path = `${base}${extFor(vid.contentType, "video")}`;
  writeFileSync(path, vid.buffer);
  job.note = `Muse video ${vid.width}×${vid.height}`;
  return [path];
}