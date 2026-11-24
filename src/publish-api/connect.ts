import type { PublishPlatform } from "../publish.js";
import { facebookAuthorizeUrl } from "./facebook.js";
import { oauthStateNew } from "./oauth-state.js";
import { tiktokAuthorizeUrl } from "./tiktok.js";
import { youtubeAuthorizeUrl } from "./youtube.js";

export function publishOAuthBegin(platform: PublishPlatform): { url: string; state: string } {
  const state = oauthStateNew(platform);
  if (platform === "youtube") return { url: youtubeAuthorizeUrl(state), state };
  if (platform === "facebook") return { url: facebookAuthorizeUrl(state), state };
  if (platform === "tiktok") return { url: tiktokAuthorizeUrl(state), state };
  throw new Error(`Unknown platform: ${platform}`);
}