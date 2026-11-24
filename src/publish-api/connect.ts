import type { PublishPlatform } from "../publish.js";
import { facebookAuthorizeUrl } from "./facebook.js";
import { publishOAuthRedirect } from "./oauth-base.js";
import { oauthStateNew } from "./oauth-state.js";
import { tiktokAuthorizeUrl, tiktokPkcePair } from "./tiktok.js";
import { youtubeAuthorizeUrl } from "./youtube.js";

export function publishOAuthBegin(platform: PublishPlatform): { url: string; state: string; redirect_uri: string } {
  if (platform === "youtube") {
    const state = oauthStateNew(platform);
    return { url: youtubeAuthorizeUrl(state), state, redirect_uri: publishOAuthRedirect("youtube") };
  }
  if (platform === "facebook") {
    const state = oauthStateNew(platform);
    return { url: facebookAuthorizeUrl(state), state, redirect_uri: publishOAuthRedirect("facebook") };
  }
  if (platform === "tiktok") {
    const { verifier, challenge } = tiktokPkcePair();
    const state = oauthStateNew(platform, verifier);
    return {
      url: tiktokAuthorizeUrl(state, challenge),
      state,
      redirect_uri: publishOAuthRedirect("tiktok"),
    };
  }
  throw new Error(`Unknown platform: ${platform}`);
}