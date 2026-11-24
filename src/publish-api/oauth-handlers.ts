import type { PublishPlatform } from "../publish.js";
import { facebookExchangeCode } from "./facebook.js";
import { oauthStateTake } from "./oauth-state.js";
import { tiktokExchangeCode } from "./tiktok.js";
import { youtubeExchangeCode } from "./youtube.js";

export async function handleOAuthCallback(
  platform: PublishPlatform,
  code: string | null,
  state: string | null,
  err?: string | null,
): Promise<{ ok: boolean; message: string }> {
  if (err) return { ok: false, message: err };
  if (!code || !state) return { ok: false, message: "Missing code or state." };
  const expect = oauthStateTake(state);
  if (!expect || expect.platform !== platform) {
    return { ok: false, message: "OAuth state expired or invalid. Try Get token again." };
  }
  try {
    if (platform === "youtube") await youtubeExchangeCode(code);
    else if (platform === "facebook") await facebookExchangeCode(code);
    else if (platform === "tiktok") {
      if (!expect.codeVerifier) {
        return { ok: false, message: "TikTok PKCE session missing. Close this tab and press Get token again." };
      }
      await tiktokExchangeCode(code, expect.codeVerifier);
    }
    else return { ok: false, message: "Unknown platform." };
    return { ok: true, message: `${platform} connected.` };
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : String(e) };
  }
}