import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./chrome.js";

export type MergeStatus = "pending" | "in_progress" | "completed" | "failed";
export type ProjectPublishStatus = "not_ready" | "ready_to_publish";

export interface SceneAssetRef {
  order: number;
  stem: string;
  flow_title: string;
}

export interface FlowCompositionRecord {
  tedverse_project: string;
  flow_project_id: string;
  composition_id: string;
  composition_name: string;
  scene_assets: SceneAssetRef[];
  scene_count: number;
  merge_status: MergeStatus;
  publish_status: ProjectPublishStatus;
  aspect_ratio: "9:16";
  content_hash: string;
  updated_at: string;
  cached_video_path?: string;
  cached_video_hash?: string;
  error?: string;
}

const FILE = join(HOME_DIR, "flow-compositions.json");

export function compositionKey(project: string) {
  return project.replace(/[^\w.-]+/g, "_");
}

export function contentHashFromTitles(titles: string[]): string {
  return createHash("sha256").update(titles.join("\0")).digest("hex").slice(0, 16);
}

export function loadCompositions(): Record<string, FlowCompositionRecord> {
  try {
    return JSON.parse(readFileSync(FILE, "utf8")) as Record<string, FlowCompositionRecord>;
  } catch {
    return {};
  }
}

export function getComposition(project: string): FlowCompositionRecord | undefined {
  return loadCompositions()[compositionKey(project)];
}

export function getCompositionByFlowId(flowProjectId: string): FlowCompositionRecord | undefined {
  for (const rec of Object.values(loadCompositions())) {
    if (rec.flow_project_id === flowProjectId) return rec;
  }
  return undefined;
}

export function saveComposition(rec: FlowCompositionRecord): void {
  mkdirSync(HOME_DIR, { recursive: true });
  const all = loadCompositions();
  all[compositionKey(rec.tedverse_project)] = rec;
  writeFileSync(FILE, JSON.stringify(all, null, 2), "utf8");
}

export function invalidateCompositionCache(project: string): void {
  const rec = getComposition(project);
  if (!rec) return;
  rec.cached_video_path = undefined;
  rec.cached_video_hash = undefined;
  saveComposition(rec);
}

export function cacheIsValid(rec: FlowCompositionRecord, path?: string): boolean {
  const p = path ?? rec.cached_video_path;
  return Boolean(p && existsSync(p) && rec.cached_video_hash && rec.cached_video_hash === rec.content_hash);
}