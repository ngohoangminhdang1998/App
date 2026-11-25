import { readFile } from "node:fs/promises";
import { statSync } from "node:fs";

import { publishOAuthRedirect } from "./oauth-base.js";
import { loadPublishApiSettings, savePublishApiSettings, type PlatformApiFields } from "./settings.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const UPLOAD_INIT = "https://www.googleapis.com/upload/youtube/v3/videos";

function redirectUri() {
  return publishOAuthRedirect("youtube");
}

const SCOPES = ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"];

export function youtubeAuthorizeUrl(state: string): string {
  const y = loadPublishApiSettings().youtube;
  if (!y.clientId?.trim()) throw new Error("YouTube: add Client ID in Settings → Publish API.");
  const q = new URLSearchParams({
    client_id: y.clientId.trim(),
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${AUTH_URL}?${q}`;
}

async function tokenRequest(body: Record<string, string>) {
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`YouTube token: ${data.error ?? res.status} ${data.error_description ?? ""}`.trim());
  return data;
}

export async function youtubeExchangeCode(code: string): Promise<void> {
  const y = loadPublishApiSettings().youtube;
  if (!y.clientId || !y.clientSecret) throw new Error("YouTube Client ID and Client secret are required.");
  const data = await tokenRequest({
    code,
    client_id: y.clientId,
    client_secret: y.clientSecret,
    redirect_uri: redirectUri(),
    grant_type: "authorization_code",
  });
  const fields: PlatformApiFields = {
    accessToken: String(data.access_token ?? ""),
    expiresAt: new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000).toISOString(),
  };
  if (data.refresh_token) fields.refreshToken = String(data.refresh_token);
  savePublishApiSettings({ platform: "youtube", fields });
  await youtubeRefreshChannelMeta(fields.accessToken!);
}

async function youtubeAccessToken(): Promise<string> {
  const y = loadPublishApiSettings().youtube;
  if (!y.clientId || !y.clientSecret) throw new Error("YouTube is not configured (Client ID / secret).");
  const exp = y.expiresAt ? Date.parse(y.expiresAt) : 0;
  if (y.accessToken && exp > Date.now() + 60_000) return y.accessToken;
  if (!y.refreshToken) throw new Error("YouTube: connect your Google account in Settings → Publish API.");
  const data = await tokenRequest({
    client_id: y.clientId,
    client_secret: y.clientSecret,
    refresh_token: y.refreshToken,
    grant_type: "refresh_token",
  });
  const accessToken = String(data.access_token ?? "");
  savePublishApiSettings({
    platform: "youtube",
    fields: {
      accessToken,
      expiresAt: new Date(Date.now() + Number(data.expires_in ?? 3600) * 1000).toISOString(),
    },
  });
  return accessToken;
}

export async function youtubeRefreshChannelMeta(accessToken?: string) {
  const token = accessToken ?? (await youtubeAccessToken());
  const res = await fetch("https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true", {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = (await res.json()) as { items?: { id: string; snippet?: { title?: string } }[]; error?: { message?: string } };
  if (!res.ok) throw new Error(data.error?.message ?? "Could not read YouTube channel.");
  const ch = data.items?.[0];
  if (!ch) throw new Error("No YouTube channel on this Google account.");
  savePublishApiSettings({
    platform: "youtube",
    fields: { channelId: ch.id, channelTitle: ch.snippet?.title ?? ch.id },
  });
}

export async function youtubeUploadVideo(opts: {
  videoPath: string;
  title: string;
  description: string;
  publishAt?: Date;
}) {
  const token = await youtubeAccessToken();
  const title = opts.title.slice(0, 100) || "Short";
  const description = opts.description.slice(0, 4900);
  const init = await fetch(
    `${UPLOAD_INIT}?uploadType=resumable&part=snippet,status`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json; charset=UTF-8",
        "x-upload-content-type": "video/mp4",
        "x-upload-content-length": String(statSync(opts.videoPath).size),
      },
      body: JSON.stringify({
        snippet: { title, description, categoryId: "22" },
        status: {
          privacyStatus: opts.publishAt ? "private" : "public",
          ...(opts.publishAt ? { publishAt: opts.publishAt.toISOString() } : {}),
          selfDeclaredMadeForKids: process.env.FLOW_MCP_YOUTUBE_MADE_FOR_KIDS === "yes",
        },
      }),
    },
  );
  if (!init.ok) {
    const err = await init.text();
    throw new Error(`YouTube upload init failed: ${err.slice(0, 400)}`);
  }
  const uploadUrl = init.headers.get("location");
  if (!uploadUrl) throw new Error("YouTube did not return an upload URL.");
  const bytes = await readFile(opts.videoPath);
  const res = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "content-length": String(bytes.length), "content-type": "video/mp4" },
    body: bytes,
  });
  const body = (await res.json()) as { id?: string; snippet?: { title?: string } };
  if (!res.ok) throw new Error(`YouTube upload failed: ${JSON.stringify(body).slice(0, 400)}`);
  const id = body.id;
  if (!id) throw new Error("YouTube upload finished without a video id.");
  return { url: `https://www.youtube.com/shorts/${id}`, videoId: id };
}