import { readFileSync, statSync } from "node:fs";
import { loadPublishApiSettings, savePublishApiSettings, type PlatformApiFields } from "./settings.js";

const STUDIO_PORT = Number(process.env.FLOW_MCP_PORT ?? 8787);
const GRAPH = "https://graph.facebook.com/v21.0";

function redirectUri() {
  return `http://127.0.0.1:${STUDIO_PORT}/oauth/callback/facebook`;
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
    throw new Error("Facebook: connect and pick a Page in Settings → Publish API.");
  }
  return { token: fb.accessToken, pageId: fb.pageId };
}

/** Reel / video on a Facebook Page via Graph resumable upload. */
export async function facebookUploadReel(opts: { videoPath: string; description: string }) {
  const { token, pageId } = await pageToken();
  const appId = loadPublishApiSettings().facebook.appId || loadPublishApiSettings().facebook.clientId;
  if (!appId) throw new Error("Facebook App ID missing.");
  const size = statSync(opts.videoPath).size;
  const start = await fetch(
    `${GRAPH}/${appId}/videos?upload_phase=start&file_size=${size}&access_token=${encodeURIComponent(token)}`,
    { method: "POST" },
  );
  const startBody = (await start.json()) as { upload_session_id?: string; video_id?: string; error?: { message?: string } };
  if (!startBody.upload_session_id) throw new Error(startBody.error?.message ?? "Facebook upload session failed.");
  const sessionId = startBody.upload_session_id;
  const bytes = readFileSync(opts.videoPath);
  const transfer = await fetch(
    `${GRAPH}/${appId}/videos?upload_phase=transfer&upload_session_id=${sessionId}&start_offset=0&access_token=${encodeURIComponent(token)}`,
    { method: "POST", headers: { "content-type": "application/octet-stream" }, body: bytes },
  );
  const transferBody = (await transfer.json()) as { error?: { message?: string } };
  if (!transfer.ok) throw new Error(transferBody.error?.message ?? "Facebook video transfer failed.");
  const finishQ = new URLSearchParams({
    upload_phase: "finish",
    upload_session_id: sessionId,
    title: opts.description.slice(0, 80) || "Reel",
    description: opts.description.slice(0, 2000),
    access_token: token,
  });
  const finish = await fetch(`${GRAPH}/${pageId}/videos?${finishQ}`, { method: "POST" });
  const finishBody = (await finish.json()) as { id?: string; error?: { message?: string } };
  if (!finish.ok || !finishBody.id) throw new Error(finishBody.error?.message ?? "Facebook publish failed.");
  return { url: `https://www.facebook.com/reel/${finishBody.id}`, videoId: finishBody.id };
}