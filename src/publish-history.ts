import type { PublishPlatform, PublishRecord, PublishStatusKind } from "./publish.js";
import { findRecordForFlowClip, isTestPublishRecord, readPublishRecordMap, writePublishRecordMap } from "./publish.js";

export const PUBLISH_HISTORY_KEEP =
  Number.parseInt(process.env.FLOW_MCP_PUBLISH_HISTORY_KEEP ?? "", 10) || 20;

export type HistoryPlatformCell =
  | "—"
  | "wait"
  | "run"
  | "ok"
  | "fail"
  | "auth"
  | "unknown";

export interface PublishHistoryRow {
  id: string;
  source: "direct";
  created_at: string;
  project: string;
  publish_at: string;
  status: string;
  platforms: string[];
  tiktok: HistoryPlatformCell;
  youtube: HistoryPlatformCell;
  facebook: HistoryPlatformCell;
}

const PLATFORMS: PublishPlatform[] = ["tiktok", "youtube", "facebook"];

function displayProject(caption: string | undefined, project: string, flowName?: string): string {
  const cap = caption?.trim();
  if (cap && cap !== project) return cap;
  if (flowName?.trim()) return flowName.trim();
  return cap || project;
}

function cellFromStatus(st: PublishStatusKind | undefined, selected: boolean): HistoryPlatformCell {
  if (!selected) return "—";
  switch (st) {
    case "published":
    case "scheduled":
      return "ok";
    case "failed":
      return "fail";
    case "needs_attention":
    case "auth_required":
      return "auth";
    case "unknown":
      return "unknown";
    case "preparing":
    case "uploading":
    case "processing":
    case "publishing":
    case "scheduling":
      return "run";
    case "not_published":
    default:
      return "—";
  }
}

function cellsFromRecord(rec: PublishRecord | undefined, selected: PublishPlatform[]): Record<PublishPlatform, HistoryPlatformCell> {
  const sel = new Set(selected);
  const out = {} as Record<PublishPlatform, HistoryPlatformCell>;
  for (const id of PLATFORMS) {
    if (!sel.has(id)) {
      out[id] = "—";
      continue;
    }
    out[id] = cellFromStatus(rec?.platforms[id]?.status, true);
  }
  return out;
}

function directRow(key: string, rec: PublishRecord): PublishHistoryRow | null {
  if (isTestPublishRecord(rec)) return null;
  const states = Object.values(rec.platforms ?? {}).filter(Boolean);
  if (!states.length) return null;
  const times = states.map((p) => p.updatedAt).filter(Boolean);
  if (!times.length) return null;
  const created_at = times.reduce((a, b) => (a < b ? a : b));
  const published = states.filter((p) => p.status === "published" || p.status === "scheduled");
  const publish_at = published.length
    ? published.map((p) => p.updatedAt).reduce((a, b) => (a > b ? a : b))
    : times.reduce((a, b) => (a > b ? a : b));
  const anyPublished = published.length > 0;
  const anyFailed = states.some((p) => p.status === "failed" || p.status === "needs_attention" || p.status === "auth_required");
  const status = anyPublished && !anyFailed ? "published" : anyFailed ? "failed" : states[0]!.status;
  const platforms = (Object.keys(rec.platforms ?? {}) as PublishPlatform[]).filter(
    (p) => rec.platforms[p]?.status !== "not_published",
  );
  if (!platforms.length) return null;
  const cells = cellsFromRecord(rec, platforms);
  return {
    id: `direct:${key}`,
    source: "direct",
    created_at,
    project: displayProject(rec.caption, rec.project, rec.flow_video_name),
    publish_at,
    status,
    platforms,
    tiktok: cells.tiktok,
    youtube: cells.youtube,
    facebook: cells.facebook,
  };
}

function collectPublishHistoryRows(): PublishHistoryRow[] {
  const rows: PublishHistoryRow[] = [];
  for (const [key, rec] of Object.entries(readPublishRecordMap())) {
    const row = directRow(key, rec);
    if (row) rows.push(row);
  }
  rows.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  return rows;
}

export function prunePublishHistoryStores(keep = PUBLISH_HISTORY_KEEP): { prunedState: number } {
  const keepRows = collectPublishHistoryRows().slice(0, keep);
  const keepStateKeys = new Set(keepRows.map((r) => r.id.replace(/^direct:/, "")));

  const map = readPublishRecordMap();
  const next: Record<string, PublishRecord> = {};
  let prunedState = 0;
  for (const [key, rec] of Object.entries(map)) {
    if (keepStateKeys.has(key) || isTestPublishRecord(rec)) next[key] = rec;
    else prunedState++;
  }
  if (prunedState > 0) writePublishRecordMap(next);
  return { prunedState };
}

export function buildPublishHistory(limit = PUBLISH_HISTORY_KEEP): PublishHistoryRow[] {
  return collectPublishHistoryRows().slice(0, limit);
}

export function historyForFlowClip(flowProjectId: string, handle: string): PublishHistoryRow | undefined {
  const rec = findRecordForFlowClip(flowProjectId, handle);
  if (!rec) return undefined;
  const key = `${rec.project}::${rec.video}`;
  return directRow(key, rec) ?? undefined;
}