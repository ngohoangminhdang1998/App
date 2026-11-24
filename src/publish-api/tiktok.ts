import { createHash, randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { publishOAuthRedirect } from "./oauth-base.js";
import { loadPublishApiSettings, savePublishApiSettings, type PlatformApiFields } from "./settings.js";

const PKCE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

/** TikTok desktop/web Login Kit: PKCE with SHA-256 code_challenge as hex (not base64url). */
export function tiktokPkcePair(): { verifier: string; challenge: string } {
  const bytes = randomBytes(64);
  let verifier = "";
  for (let i = 0; i < 64; i++) verifier += PKCE_CHARS[bytes[i]! % PKCE_CHARS.length];
  const challenge = createHash("sha256").update(verifier).digest("hex");
  return { verifier, challenge };
}

function redirectUri() {
  return publishOAuthRedirect("tiktok");
}

const SCOPES = ["user.info.basic", "video.upload", "video.publish"];

/** Unaudited / sandbox: SELF_ONLY + TikTok account must be Private in the app. After app audit: PUBLIC_TO_EVERYONE. */
function tiktokPrivacyLevel(): string {
  const v = process.env.FLOW_MCP_TIKTOK_PRIVACY?.trim();
  if (v) return v;
  return "SELF_ONLY";
}

export function tiktokAuthorizeUrl(state: string, codeChallenge: string): string {
  const tt = loadPublishApiSettings().tiktok;
  const key = (tt.clientKey || tt.clientId)?.trim();
  if (!key) throw new Error("TikTok: add Client key in Settings → Publish API.");
  if (key.length < 8) throw new Error("TikTok Client key looks too short — copy “Client key” from TikTok app Credentials (not Client secret).");
  const q = new URLSearchParams({
    client_key: key,
    scope: SCOPES.join(","),
    response_type: "code",
    redirect_uri: redirectUri(),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
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

export async function tiktokExchangeCode(code: string, codeVerifier: string): Promise<void> {
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
    code_verifier: codeVerifier,
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
        privacy_level: tiktokPrivacyLevel(),
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
    const code = init.error?.code ?? "";
    const msg = init.error?.message ?? JSON.stringify(init).slice(0, 400);
    let hint = "See docs/PUBLISH-API.md.";
    if (code === "unaudited_client_can_only_post_to_private_accounts") {
      hint =
        "App chưa audit: trong app TikTok đặt tài khoản Private, Publish dùng SELF_ONLY (mặc định TedVerse). Sau audit: export FLOW_MCP_TIKTOK_PRIVACY=PUBLIC_TO_EVERYONE và restart studio.";
    } else if (code === "scope_not_authorized") {
      hint = "Thiếu scope video.publish — Get token lại sau khi thêm scope trên TikTok Developer.";
    } else if (/integration guidelines/i.test(msg)) {
      hint = `Sandbox/chưa audit: privacy=${tiktokPrivacyLevel()}, tài khoản TikTok phải Private. Sau audit mới đăng public.`;
    }
    throw new Error(`TikTok init failed [${code || initRes.status}]: ${msg} ${hint}`);
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