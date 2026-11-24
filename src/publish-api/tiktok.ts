import { readFileSync, statSync } from "node:fs";
import { publishOAuthRedirect } from "./oauth-base.js";
import { loadPublishApiSettings, savePublishApiSettings, type PlatformApiFields } from "./settings.js";

function redirectUri() {
  return publishOAuthRedirect("tiktok");
}

const SCOPES = ["video.upload", "video.publish"];

export function tiktokAuthorizeUrl(state: string): string {
  const tt = loadPublishApiSettings().tiktok;
  const key = (tt.clientKey || tt.clientId)?.trim();
  if (!key) throw new Error("TikTok: add Client key in Settings → Publish API.");
  const q = new URLSearchParams({
    client_key: key,
    scope: SCOPES.join(","),
    response_type: "code",
    redirect_uri: redirectUri(),
    state,
  });
  return `https://www.tiktok.com/v2/auth/authorize/?${q}`;
}

async function tokenPost(body: Record<string, string>) {
  const res = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = (await res.json()) as { access_token?: string; refresh_token?: string; open_id?: string; error?: string; error_description?: string };
  if (!res.ok || data.error) throw new Error(data.error_description ?? data.error ?? "TikTok token failed.");
  return data;
}

export async function tiktokExchangeCode(code: string): Promise<void> {
  const tt = loadPublishApiSettings().tiktok;
  const key = tt.clientKey || tt.clientId;
  const secret = tt.clientSecret;
  if (!key || !secret) throw new Error("TikTok Client key and Client secret are required.");
  const data = await tokenPost({
    client_key: key,
    client_secret: secret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri(),
  });
  savePublishApiSettings({
    platform: "tiktok",
    fields: {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      openId: data.open_id,
    },
  });
}

async function tiktokAccessToken(): Promise<string> {
  const tt = loadPublishApiSettings().tiktok;
  if (tt.accessToken) return tt.accessToken;
  if (!tt.refreshToken || !(tt.clientKey || tt.clientId) || !tt.clientSecret) {
    throw new Error("TikTok: connect your account in Settings → Publish API.");
  }
  const data = await tokenPost({
    client_key: tt.clientKey || tt.clientId!,
    client_secret: tt.clientSecret,
    grant_type: "refresh_token",
    refresh_token: tt.refreshToken,
  });
  savePublishApiSettings({
    platform: "tiktok",
    fields: { accessToken: data.access_token, refreshToken: data.refresh_token ?? tt.refreshToken },
  });
  return data.access_token!;
}

export async function tiktokUploadVideo(opts: { videoPath: string; caption: string }) {
  const token = await tiktokAccessToken();
  const size = statSync(opts.videoPath).size;
  const initRes = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=UTF-8",
    },
    body: JSON.stringify({
      post_info: {
        title: opts.caption.slice(0, 150),
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: { source: "FILE_UPLOAD", video_size: size, chunk_size: size, total_chunk_count: 1 },
    }),
  });
  const init = (await initRes.json()) as {
    data?: { publish_id?: string; upload_url?: string };
    error?: { code?: string; message?: string };
  };
  if (!initRes.ok || init.error) {
    const msg = init.error?.message ?? JSON.stringify(init).slice(0, 300);
    throw new Error(
      `TikTok init failed: ${msg}. Content Posting API needs TikTok app review — see docs/PUBLISH-API.md.`,
    );
  }
  const uploadUrl = init.data?.upload_url;
  if (!uploadUrl) throw new Error("TikTok did not return upload_url.");
  const bytes = readFileSync(opts.videoPath);
  const up = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-type": "video/mp4", "content-length": String(bytes.length) },
    body: bytes,
  });
  if (!up.ok) throw new Error(`TikTok upload failed (${up.status}).`);
  const publishId = init.data?.publish_id;
  return {
    url: publishId ? `https://www.tiktok.com/@me/video/${publishId}` : "https://www.tiktok.com",
    publishId,
  };
}