import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { assemble } from "./assemble.js";
import {
  contentHashFromTitles,
  saveComposition,
  type FlowCompositionRecord,
} from "./flow-composition.js";
import { filmFinalSceneName } from "./film-numbers.js";
import { validatePlayableVideo } from "./media-download.js";
import { optionIsExactMedia } from "./media-ref.js";
import { downloadAsset, getFlowState, listAssets } from "./flow.js";

const OUTPUT_ROOT = process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out");
const projectDir = (project: string) => resolve(OUTPUT_ROOT, project.replace(/[^\w.-]+/g, "_"));

export type LocalMergeInput = {
  tedverseProject: string;
  clips: { stem: string; flow_title?: string }[];
  aspect_ratio?: "9:16" | "16:9";
  force?: boolean;
};

/** Download each scene clip from Flow, then concat with ffmpeg on this PC (no Scene Editor timeline). */
export async function mergeClipsLocally(input: LocalMergeInput): Promise<FlowCompositionRecord> {
  const compositionName = filmFinalSceneName(input.tedverseProject);
  const titles = input.clips.map((c, i) => ({
    order: i + 1,
    stem: c.stem,
    flow_title: (c.flow_title || `${input.tedverseProject}-${c.stem}`).trim(),
  }));
  const hash = contentHashFromTitles(titles.map((t) => t.flow_title));
  const now = new Date().toISOString();
  const dir = projectDir(input.tedverseProject);
  mkdirSync(dir, { recursive: true });

  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint ?? "Flow is not ready.");

  const assets = await listAssets();
  const flowProjectId = assets.find((a) => a.projectId)?.projectId;
  if (!flowProjectId) throw new Error("Open your Google Flow project in TedVerse Chrome, then retry merge.");
  const missing = titles.filter(
    (t) => !assets.some((a) => a.kind === "video" && optionIsExactMedia(a.name, t.flow_title)),
  );
  if (missing.length) {
    throw new Error(
      `Missing ${missing.length} clip(s) in Flow: ${missing.map((m) => m.flow_title).join(", ")}. Generate or rename them, then retry.`,
    );
  }

  let rec: FlowCompositionRecord = {
    tedverse_project: input.tedverseProject,
    flow_project_id: flowProjectId,
    composition_id: "local",
    composition_name: compositionName,
    scene_assets: titles,
    scene_count: titles.length,
    merge_status: "in_progress",
    publish_status: "not_ready",
    aspect_ratio: input.aspect_ratio ?? "9:16",
    content_hash: hash,
    updated_at: now,
  };
  saveComposition(rec);

  try {
    const localPaths: string[] = [];
    for (const clip of titles) {
      const base = join(dir, clip.stem.replace(/\.mp4$/i, ""));
      const target = `${base}.mp4`;
      if (!input.force && existsSync(target)) {
        try {
          validatePlayableVideo(target);
          localPaths.push(target);
          continue;
        } catch {
          /* re-download */
        }
      }
      const saved = await downloadAsset(clip.flow_title, base, "original", { overwrite: true });
      if (!saved.length) throw new Error(`Download failed for "${clip.flow_title}".`);
      localPaths.push(saved[0]!);
    }

    const outputStem = compositionName.replace(/[^\w.-]+/g, "_");
    const result = await assemble({
      dir,
      clips: localPaths,
      output_name: outputStem,
      hold_last_frame: true,
      loudness: -14,
      remove_watermark: true,
    });

    rec.merge_status = "completed";
    rec.publish_status = "ready_to_publish";
    rec.cached_video_path = result.output;
    rec.cached_video_hash = hash;
    rec.updated_at = new Date().toISOString();
    rec.error = undefined;
    saveComposition(rec);
    return rec;
  } catch (err) {
    rec.merge_status = "failed";
    rec.publish_status = "not_ready";
    rec.error = err instanceof Error ? err.message : String(err);
    rec.updated_at = new Date().toISOString();
    saveComposition(rec);
    throw err;
  }
}