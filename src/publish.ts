import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "./chrome.js";
import { buildFinalPublishText, validatePublishTextForPlatforms } from "./publish-text.js";
import { runPlatformPublish } from "./publish/platforms/index.js";
import type { PublishMode, PlatformSchedule } from "./publish/shared/types.js";
import { parsePublishSchedule } from "./publish/shared/schedule.js";
import { assertPublishVideoFile } from "./publish/shared/video.js";

export type PublishPlatform = "tiktok" | "youtube" | "facebook";
export type PublishStatusKind =
  | "not_published"
  | "preparing"
  | "uploading"
  | "processing"
  | "publishing"
  | "published"
  | "scheduling"
  | "scheduled"
  | "failed"
  | "needs_attention"
  | "auth_required"
  | "unknown";

export interface PlatformPublishState {
  status: PublishStatusKind;
  url?: string;
  error?: string;
  updatedAt: string;
  uncertain?: boolean;
  scheduled_at?: string;
  /** Last automation step — for debugging (set FLOW_MCP_PUBLISH_DEBUG=1 for screenshots). */
  step?: string;
}

export interface PublishRecord {
  project: string;
  video: string;
  caption: string;
  hashtags: string[];
  platforms: Partial<Record<PublishPlatform, PlatformPublishState>>;
  running: boolean;
  flow_project_id?: string;
  flow_video_handle?: string;
  flow_video_name?: string;
  mode?: PublishMode;
}

export type ClipPlatformSummary = Partial<Record<PublishPlatform, PublishStatusKind>>;

export interface ClipPublishSummary {
  flow_project_id: string;
  flow_video_handle: string;
  platforms: ClipPlatformSummary;
  posted: PublishPlatform[];
  labels: string;
}

const STATE_FILE = join(HOME_DIR, "publish-state.json");

function loadState(): Record<string, PublishRecord> {
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as Record<string, PublishRecord>;
  } catch {
    return {};
  }
}

export function readPublishRecords(): PublishRecord[] {
  return Object.values(loadState());
}

export function readPublishRecordMap(): Record<string, PublishRecord> {
  return loadState();
}

export function writePublishRecordMap(all: Record<string, PublishRecord>) {
  saveState(all);
}

export function isTestPublishRecord(rec: PublishRecord): boolean {
  if (process.env.FLOW_MCP_PUBLISH_HISTORY_INCLUDE_TEST === "1") return false;
  if (/flow-mcp-publish-/i.test(rec.video ?? "")) return true;
  for (const st of Object.values(rec.platforms ?? {})) {
    if (st?.url && /example\.test/i.test(st.url)) return true;
  }
  return false;
}

function saveState(all: Record<string, PublishRecord>) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(STATE_FILE, JSON.stringify(all, null, 2), "utf8");
}

function stateKey(project: string, video: string) {
  return `${project}::${video}`;
}

export function clipPublishKey(flowProjectId: string, handle: string) {
  return `${flowProjectId.toLowerCase()}::${handle}`;
}

const PLATFORM_LABEL: Record<PublishPlatform, string> = {
  tiktok: "TikTok",
  youtube: "YouTube",
  facebook: "Facebook",
};

export function findRecordForFlowClip(flowProjectId: string, handle: string): PublishRecord | undefined {
  const want = clipPublishKey(flowProjectId, handle);
  const all = loadState();
  for (const rec of Object.values(all)) {
    if (rec.flow_project_id && rec.flow_video_handle && clipPublishKey(rec.flow_project_id, rec.flow_video_handle) === want) {
      return rec;
    }
  }
  return undefined;
}

function isPosted(st: PublishStatusKind | undefined): boolean {
  return st === "published" || st === "scheduled";
}

export function summarizeClipPublish(flowProjectId: string, handle: string): ClipPublishSummary {
  const rec = findRecordForFlowClip(flowProjectId, handle);
  const platforms: ClipPlatformSummary = {};
  const posted: PublishPlatform[] = [];
  const bits: string[] = [];
  for (const id of ["tiktok", "youtube", "facebook"] as PublishPlatform[]) {
    const st = rec?.platforms[id]?.status ?? "not_published";
    platforms[id] = st;
    const label = PLATFORM_LABEL[id];
    if (st === "published" || st === "scheduled") {
      posted.push(id);
      bits.push(`${label} ✓`);
    } else if (st === "failed" || st === "needs_attention" || st === "auth_required") bits.push(`${label} ✗`);
    else if (st === "unknown") bits.push(`${label} ?`);
    else bits.push(`${label} —`);
  }
  return {
    flow_project_id: flowProjectId,
    flow_video_handle: handle,
    platforms,
    posted,
    labels: bits.join(" · "),
  };
}

function freshPlatform(): PlatformPublishState {
  return { status: "not_published", updatedAt: new Date().toISOString() };
}

function mockMode() {
  return process.env.FLOW_MCP_PUBLISH_MOCK === "1";
}

async function runPlatform(
  platform: PublishPlatform,
  videoPath: string,
  opts: {
    finalText: string;
    mode: PublishMode;
    schedule?: PlatformSchedule;
  },
  onUpdate: (patch: Partial<PlatformPublishState>) => void,
): Promise<void> {
  if (mockMode()) {
    onUpdate({ status: "preparing" });
    await new Promise((r) => setTimeout(r, 30));
    onUpdate({ status: "uploading" });
    await new Promise((r) => setTimeout(r, 30));
    onUpdate({ status: "processing" });
    await new Promise((r) => setTimeout(r, 30));
    if (opts.mode === "schedule") {
      onUpdate({
        status: "scheduled",
        scheduled_at: opts.schedule?.at.toISOString(),
        url: `https://example.test/${platform}/scheduled`,
      });
      return;
    }
    onUpdate({ status: "published", url: `https://example.test/${platform}/mock`, uncertain: false });
    return;
  }
  try {
    await runPlatformPublish(
      platform,
      {
        videoPath,
        finalText: opts.finalText,
        mode: opts.mode,
        schedule: opts.schedule,
      },
      (patch) => onUpdate(patch as Partial<PlatformPublishState>),
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onUpdate({ status: "failed", error: msg });
  }
}

export class PublishManager {
  private running = false;

  isRunning() {
    return this.running;
  }

  getRecord(project: string, video: string): PublishRecord | undefined {
    return loadState()[stateKey(project, video)];
  }

  snapshot(project: string, video?: string, flowClip?: { flow_project_id: string; flow_video_handle: string }) {
    const all = loadState();
    let records: PublishRecord[];
    if (flowClip?.flow_project_id && flowClip.flow_video_handle) {
      const hit = findRecordForFlowClip(flowClip.flow_project_id, flowClip.flow_video_handle);
      records = hit ? [hit] : [];
    } else {
      records = Object.values(all).filter((r) => r.project === project && (!video || r.video === video));
    }
    return { running: this.running, records };
  }

  async publish(opts: {
    project: string;
    video: string;
    platforms: PublishPlatform[];
    caption: string;
    hashtags: string[];
    confirm_uncertain?: boolean;
    flow_project_id?: string;
    flow_video_handle?: string;
    flow_video_name?: string;
    mode?: PublishMode;
    schedule_at?: string;
    schedule_timezone?: string;
    /** @deprecated use mode=schedule */
    schedule_at_local?: string;
  }) {
    if (this.running) throw new Error("A publish operation is already running.");
    if (!opts.platforms.length) throw new Error("Select at least one platform.");
    if (!mockMode()) assertPublishVideoFile(opts.video);
    else if (!existsSync(opts.video)) throw new Error(`Video not found: ${opts.video}`);

    const mode: PublishMode = opts.mode ?? "now";
    let schedule: PlatformSchedule | undefined;
    if (mode === "schedule") {
      const at = opts.schedule_at ?? opts.schedule_at_local;
      if (!at) throw new Error("Pick a date and time for scheduling.");
      schedule = parsePublishSchedule(at, opts.schedule_timezone);
    }

    const key = stateKey(opts.project, opts.video);
    const all = loadState();
    let record = all[key];
    if (!record) {
      record = {
        project: opts.project,
        video: opts.video,
        caption: opts.caption,
        hashtags: opts.hashtags,
        platforms: { tiktok: freshPlatform(), youtube: freshPlatform(), facebook: freshPlatform() },
        running: false,
        mode,
      };
    }
    record.caption = opts.caption;
    record.hashtags = opts.hashtags;
    record.mode = mode;
    if (opts.flow_project_id) record.flow_project_id = opts.flow_project_id;
    if (opts.flow_video_handle) record.flow_video_handle = opts.flow_video_handle;
    if (opts.flow_video_name) record.flow_video_name = opts.flow_video_name;
    all[key] = record;
    saveState(all);

    const finalText = buildFinalPublishText(opts.caption, opts.hashtags);
    validatePublishTextForPlatforms(opts.platforms, finalText);
    this.running = true;
    record.running = true;
    all[key] = record;
    saveState(all);

    try {
      for (const platform of opts.platforms) {
        const prev = record.platforms[platform] ?? freshPlatform();
        if (isPosted(prev.status) && prev.url && !prev.uncertain) continue;
        if (prev.uncertain && !opts.confirm_uncertain) {
          throw new Error(
            `${platform}: last attempt outcome is uncertain. Verify in Chrome, or publish again with confirm_uncertain.`,
          );
        }
        const touch = (patch: Partial<PlatformPublishState>) => {
          const cur = loadState()[key];
          if (!cur) return;
          cur.platforms[platform] = {
            ...(cur.platforms[platform] ?? freshPlatform()),
            ...patch,
            updatedAt: new Date().toISOString(),
          };
          all[key] = cur;
          saveState(all);
        };
        touch({ status: "preparing", error: undefined, uncertain: false });
        await runPlatform(
          platform,
          opts.video,
          { finalText, mode, schedule },
          touch,
        );
      }
    } finally {
      this.running = false;
      const fin = loadState()[key];
      if (fin) {
        fin.running = false;
        all[key] = fin;
        saveState(all);
      }
    }
    return loadState()[key];
  }

  async retry(opts: { project: string; video: string; platforms?: PublishPlatform[]; confirm_uncertain?: boolean }) {
    const rec = this.getRecord(opts.project, opts.video);
    if (!rec) throw new Error("No publish record for this project and video.");
    const pool = opts.platforms ?? (["tiktok", "youtube", "facebook"] as PublishPlatform[]);
    const failed = pool.filter((p) => {
      const st = rec.platforms[p];
      return st && (st.status === "failed" || st.status === "needs_attention" || st.status === "auth_required" || st.status === "unknown");
    });
    if (!failed.length) throw new Error("Nothing to retry — only failed or uncertain platforms are retried.");
    return this.publish({
      project: opts.project,
      video: opts.video,
      platforms: failed,
      caption: rec.caption,
      hashtags: rec.hashtags,
      confirm_uncertain: opts.confirm_uncertain ?? true,
      mode: rec.mode,
      flow_project_id: rec.flow_project_id,
      flow_video_handle: rec.flow_video_handle,
      flow_video_name: rec.flow_video_name,
    });
  }
}

export const publishManager = new PublishManager();

export function listPublishableVideos(projectDir: string): { path: string; name: string; mtime: number }[] {
  if (!existsSync(projectDir)) return [];
  return readdirSync(projectDir)
    .filter((f) => /\.(mp4|webm|mov)$/i.test(f))
    .map((f) => {
      const path = join(projectDir, f);
      return { path, name: f, mtime: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

export function guessDefaultVideo(projectDir: string, projectName: string): string | null {
  const files = listPublishableVideos(projectDir);
  if (!files.length) return null;
  const stem = projectName.replace(/[^\w.-]+/g, "_");
  const prefer = [`${stem}-final.mp4`, `${projectName}-final.mp4`, "final.mp4"];
  for (const name of prefer) {
    const hit = files.find((f) => f.name.toLowerCase() === name.toLowerCase());
    if (hit) return hit.path;
  }
  const finalish = files.find((f) => /final/i.test(f.name));
  return (finalish ?? files[0]).path;
}