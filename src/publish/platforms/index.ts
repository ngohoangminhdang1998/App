import type { PlatformJobInput, PlatformTouch, PublishPlatform } from "../shared/types.js";
import { publishUsesApi, runApiPlatformPublish } from "../../publish-api/runner.js";
import { publishFacebook } from "./facebook.js";
import { publishTikTok } from "./tiktok.js";
import { publishYouTube } from "./youtube.js";

const BROWSER: Record<PublishPlatform, (input: PlatformJobInput, touch: PlatformTouch) => Promise<void>> = {
  tiktok: publishTikTok,
  youtube: publishYouTube,
  facebook: publishFacebook,
};

export function runPlatformPublish(platform: PublishPlatform, input: PlatformJobInput, touch: PlatformTouch): Promise<void> {
  if (publishUsesApi()) return runApiPlatformPublish(platform, input, touch);
  return BROWSER[platform](input, touch);
}