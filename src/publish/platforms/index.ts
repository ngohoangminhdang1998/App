import type { PlatformJobInput, PlatformTouch, PublishPlatform } from "../shared/types.js";
import { publishFacebook } from "./facebook.js";
import { publishTikTok } from "./tiktok.js";
import { publishYouTube } from "./youtube.js";

const RUNNERS: Record<PublishPlatform, (input: PlatformJobInput, touch: PlatformTouch) => Promise<void>> = {
  tiktok: publishTikTok,
  youtube: publishYouTube,
  facebook: publishFacebook,
};

export function runPlatformPublish(platform: PublishPlatform, input: PlatformJobInput, touch: PlatformTouch): Promise<void> {
  return RUNNERS[platform](input, touch);
}