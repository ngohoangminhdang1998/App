import { readFileSync, statSync } from "node:fs";
import { publishOAuthRedirect } from "./oauth-base.js";
import { loadPublishApiSettings, savePublishApiSettings, type PlatformApiFields } from "./settings.js";

const GRAPH = "https://graph.facebook.com/v22.0";
const RUPLOAD = "https://rupload.facebook.com/video-upload/v22.0";

type GraphErr = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_msg?: string;
  error_user_title?: string;
  fbtrace_id?: string;
  is_transient?: boolean;
  error_data?: unknown;
};

function formatGraphError(step: string, body: { error?: GraphErr }, httpStatus?: number, raw?: string): string {
  const e = body.error;
  const parts: string[] = [`[${step}]`];
  if (httpStatus && !resOk(httpStatus)) parts.push(`HTTP ${httpStatus}`);
  if (e?.error_user_title) parts.push(e.error_user_title);
  if (e?.error_user_msg) parts.push(e.error_user_msg);
  if (e?.message && e.message !== e.error_user_msg) parts.push(e.message);
  if (e?.code != null) parts.push(`code=${e.code}`);
  if (e?.error_subcode != null) parts.push(`subcode=${e.error_subcode}`);
  if (e?.type) parts.push(`type=${e.type}`);
  if (e?.fbtrace_id) parts.push(`fbtrace=${e.fbtrace_id}`);
  if (e?.error_data != null) {
    try {
      parts.push(`error_data=${JSON.stringify(e.error_data)}`);
    } catch {
      parts.push("error_data=(unserializable)");
    }
  }
  if (!e && raw?.trim()) parts.push(raw.trim().slice(0, 400));
  if (parts.length === 1) parts.push("Unknown Graph API error");
  return parts.join(" · ");
}

function resOk(status: number) {
  return status >= 200 && status < 300;
}

function metaErr(step: string, body: { error?: GraphErr }, httpStatus?: number, raw?: string): never {
  throw new Error(formatGraphError(step, body, httpStatus, raw));
}

async function graphResponse(res: Response, step: string): Promise<Record<string, unknown>> {
  const raw = await res.text();
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    if (!resOk(res.status)) metaErr(step, {}, res.status, raw);
    return {};
  }
  if (!resOk(res.status) || body.error) metaErr(step, body as { error?: GraphErr }, res.status, raw);
  return body;
}

async function waitReelUploaded(videoId: string, token: string, maxMs = 180_000): Promise<void> {
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    const res = await fetch(
      `${GRAPH}/${videoId}?fields=status&access_token=${encodeURIComponent(token)}`,
    );
    const body = (await res.json()) as {
      status?: {
        video_status?: string;
        uploading_phase?: { status?: string; errors?: { message?: string }[] };
      };
      error?: { message?: string };
    };
    if (body.error) throw new Error(body.error.message ?? "Facebook reel status failed.");
    const vs = body.status?.video_status;
    const up = body.status?.uploading_phase?.status;
    if (vs === "ready" || vs === "upload_complete" || up === "complete" || up === "completed") return;
    if (vs === "upload_failed" || vs === "error") {
      const detail = body.status?.uploading_phase?.errors?.[0]?.message;
      throw new Error(detail ?? "Facebook rejected the video file during upload.");
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Facebook reel upload timed out waiting for ready status.");
}

function redirectUri() {
  return publishOAuthRedirect("facebook");
}

const SCOPES = [
  "pages_show_list",
  "pages_read_engagement",
  "pages_manage_posts",
  "pages_manage_engagement",
  "publish_video",
].join(",");

export function facebookAuthorizeUrl(state: string): string {
  const fb = loadPublishApiSettings().facebook;
  const appId = (fb.appId || fb.clientId)?.trim();
  if (!appId) throw new Error("Facebook: add App ID in Settings → Publish API.");
  const q = new URLSearchParams({
    client_id: appId,
    redirect_uri: redirectUri(),
    state,
    scope: SCOPES,
    response_type: "code",
  });
  return `https://www.facebook.com/v21.0/dialog/oauth?${q}`;
}

async function graphGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`${GRAPH}${path}${path.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`);
  const data = (await res.json()) as T & { error?: { message?: string } };
  if (!res.ok || (data as { error?: { message?: string } }).error) {
    throw new Error((data as { error?: { message?: string } }).error?.message ?? `Graph GET ${path}`);
  }
  return data;
}

export async function facebookExchangeCode(code: string): Promise<void> {
  const fb = loadPublishApiSettings().facebook;
  const appId = fb.appId || fb.clientId;
  const secret = fb.appSecret || fb.clientSecret;
  if (!appId || !secret) throw new Error("Facebook App ID and App secret are required.");
  const q = new URLSearchParams({
    client_id: appId,
    client_secret: secret,
    redirect_uri: redirectUri(),
    code,
  });
  const res = await fetch(`${GRAPH}/oauth/access_token?${q}`);
  const short = (await res.json()) as { access_token?: string; error?: { message?: string } };
  if (!short.access_token) throw new Error(short.error?.message ?? "Facebook token exchange failed.");
  const longRes = await fetch(
    `${GRAPH}/oauth/access_token?grant_type=fb_exchange_token&client_id=${appId}&client_secret=${secret}&fb_exchange_token=${short.access_token}`,
  );
  const long = (await longRes.json()) as { access_token?: string; error?: { message?: string } };
  const userToken = long.access_token ?? short.access_token;
  const pages = await graphGet<{ data?: { id: string; name: string; access_token: string }[] }>(
    "/me/accounts?fields=id,name,access_token",
    userToken,
  );
  const wantPage = fb.pageId?.trim();
  const page = wantPage ? pages.data?.find((p) => p.id === wantPage) : pages.data?.[0];
  if (!page?.access_token) {
    throw new Error(
      wantPage
        ? `Facebook Page ${wantPage} not found on this account. Check Page ID in Settings.`
        : "No Facebook Page on this account. Create a Page or enter Page ID in Settings.",
    );
  }
  const fields: PlatformApiFields = {
    accessToken: page.access_token,
    pageId: page.id,
    pageName: page.name,
    refreshToken: userToken,
  };
  savePublishApiSettings({ platform: "facebook", fields });
}

async function pageToken(): Promise<{ token: string; pageId: string }> {
  const fb = loadPublishApiSettings().facebook;
  if (!fb.pageId || !fb.accessToken) {
    throw new Error("Facebook: điền Page ID + Page access token trong Settings → Publish API.");
  }
  return { token: fb.accessToken, pageId: fb.pageId };
}

function shouldFallbackFromReels(msg: string): boolean {
  return /invalid parameter|unknown path|nonexisting field|not support/i.test(msg);
}

/** Chunked upload to /{page-id}/videos — works with Page token + pages_manage_posts (no Reels product required). */
async function publishViaPageVideos(
  pageId: string,
  token: string,
  opts: { videoPath: string; description: string },
  size: number,
): Promise<{ url: string; videoId: string }> {
  const startQ = new URLSearchParams({
    upload_phase: "start",
    file_size: String(size),
    access_token: token,
  });
  const start = await fetch(`${GRAPH}/${pageId}/videos?${startQ}`, { method: "POST" });
  const startBody = (await graphResponse(start, "FB page video · start")) as { upload_session_id?: string };
  const sessionId = startBody.upload_session_id;
  if (!sessionId) throw new Error("[FB page video · start] · No upload_session_id in response.");
  const bytes = readFileSync(opts.videoPath);
  const transferQ = new URLSearchParams({
    upload_phase: "transfer",
    upload_session_id: sessionId,
    start_offset: "0",
    access_token: token,
  });
  const transfer = await fetch(`${GRAPH}/${pageId}/videos?${transferQ}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  await graphResponse(transfer, "FB page video · transfer");
  const desc = opts.description.trim().slice(0, 2000);
  const finish = new URLSearchParams({
    upload_phase: "finish",
    upload_session_id: sessionId,
    title: desc.slice(0, 80) || "Video",
    description: desc,
    published: "true",
    is_ai_generated: "true",
    access_token: token,
  });
  const finishRes = await fetch(`${GRAPH}/${pageId}/videos?${finish}`, { method: "POST" });
  const finishBody = (await graphResponse(finishRes, "FB page video · publish")) as { id?: string };
  if (!finishBody.id) throw new Error("[FB page video · publish] · No video id in response.");
  const videoId = finishBody.id;
  return { url: `https://www.facebook.com/reel/${videoId}`, videoId };
}

/** Meta Reels API (video_reels + rupload) when the app has Reels publishing enabled. */
async function publishViaReelsApi(
  pageId: string,
  token: string,
  opts: { videoPath: string; description: string },
  size: number,
): Promise<{ url: string; videoId: string }> {
  const start = await fetch(`${GRAPH}/${pageId}/video_reels`, {
    method: "POST",
    body: new URLSearchParams({ upload_phase: "start", access_token: token }),
  });
  const startRaw = await start.text();
  let startBody = {} as {
    video_id?: string;
    upload_url?: string;
    error?: GraphErr;
  };
  try {
    startBody = JSON.parse(startRaw) as typeof startBody;
  } catch {
    if (!resOk(start.status)) metaErr("FB reel API · start", {}, start.status, startRaw);
  }
  if (startBody.error) {
    if (startBody.error.code === 100 && /permission/i.test(startBody.error.message ?? "")) {
      throw new Error(
        `${formatGraphError("FB reel API · start", startBody, start.status)} · Dùng Page token (Explorer → chọn fanpage → copy), quyền pages_manage_posts.`,
      );
    }
    metaErr("FB reel API · start", startBody, start.status, startRaw);
  }
  if (!startBody.video_id) {
    throw new Error(formatGraphError("FB reel API · start", startBody, start.status, startRaw || "no video_id"));
  }
  const videoId = startBody.video_id!;
  let uploadUrl = startBody.upload_url?.trim();
  if (uploadUrl && !uploadUrl.includes("://")) uploadUrl = `https://rupload.facebook.com${uploadUrl.startsWith("/") ? "" : "/"}${uploadUrl}`;
  if (!uploadUrl) uploadUrl = `${RUPLOAD}/${videoId}`;
  const bytes = readFileSync(opts.videoPath);
  const transfer = await fetch(uploadUrl, {
    method: "POST",
    headers: { Authorization: `OAuth ${token}`, offset: "0", file_size: String(size) },
    body: bytes,
  });
  const transferRaw = await transfer.text();
  let transferBody: { success?: boolean; error?: { message?: string; error_user_msg?: string } } = {};
  try {
    transferBody = JSON.parse(transferRaw) as typeof transferBody;
  } catch {
    /* empty body ok */
  }
  if (!transfer.ok && !transferBody.success) {
    metaErr("FB reel API · rupload", transferBody, transfer.status, transferRaw.slice(0, 500));
  }
  await waitReelUploaded(videoId, token);
  const desc = opts.description.trim().slice(0, 2000);
  const finishBodyForm = new URLSearchParams({
    access_token: token,
    video_id: videoId,
    upload_phase: "finish",
    video_state: "PUBLISHED",
    is_ai_generated: "true",
  });
  if (desc) finishBodyForm.set("description", desc);
  const finish = await fetch(`${GRAPH}/${pageId}/video_reels`, { method: "POST", body: finishBodyForm });
  const finishParsed = (await graphResponse(finish, "FB reel API · publish")) as { success?: boolean };
  if (finishParsed.success !== true) {
    throw new Error("[FB reel API · publish] · Graph did not return success:true.");
  }
  return { url: `https://www.facebook.com/reel/${videoId}`, videoId };
}

/** Page video / Reel on Facebook (tries Reels API, falls back to classic Page video upload). */
export async function facebookUploadReel(opts: { videoPath: string; description: string }) {
  const { token, pageId } = await pageToken();
  const me = await graphGet<{ id?: string }>("/me?fields=id", token);
  if (me.id && me.id !== pageId) {
    throw new Error(
      `Page ID trong Settings (${pageId}) không khớp token (đang là ${me.id}). Explorer: chọn fanpage → copy token → Page ID = ${me.id}.`,
    );
  }
  const size = statSync(opts.videoPath).size;
  try {
    return await publishViaReelsApi(pageId, token, opts, size);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!shouldFallbackFromReels(msg)) throw err;
    try {
      return await publishViaPageVideos(pageId, token, opts, size);
    } catch (fallbackErr) {
      const fb = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
      throw new Error(`Reels API failed: ${msg}\n\nPage video fallback: ${fb}`);
    }
  }
}