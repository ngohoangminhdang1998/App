import type { PublishPlatform } from "../publish.js";
import type { PlatformJobInput, PlatformTouch } from "../publish/shared/types.js";
import { facebookUploadReel } from "./facebook.js";
import { loadPublishApiSettings } from "./settings.js";
import { tiktokUploadVideo } from "./tiktok.js";
import { youtubeUploadVideo } from "./youtube.js";

function titleFromText(text: string) {
  const line = text.trim().split(/\n/)[0] ?? text;
  return line.slice(0, 100);
}

export function publishUsesApi(): boolean {
  if (process.env.FLOW_MCP_PUBLISH_ENGINE === "api") return true;
  if (process.env.FLOW_MCP_PUBLISH_ENGINE === "browser") return false;
  return loadPublishApiSettings().engine === "api";
}

export async function runApiPlatformPublish(
  platform: PublishPlatform,
  input: PlatformJobInput,
  touch: PlatformTouch,
): Promise<void> {
  const description = input.finalText;
  const title = titleFromText(description);
  const publishAt = input.mode === "schedule" ? input.schedule?.at : undefined;
  if (input.mode === "schedule" && !publishAt) {
    throw new Error(`${platform}: missing schedule time.`);
  }
  touch({ status: publishAt ? "scheduling" : "uploading", step: publishAt ? "api-schedule" : "api-upload" });
  if (platform === "youtube") {
    const out = await youtubeUploadVideo({ videoPath: input.videoPath, title, description, publishAt });
    if (publishAt) {
      touch({
        status: "scheduled",
        scheduled_at: publishAt.toISOString(),
        url: out.url,
        uncertain: false,
        step: "api-scheduled",
      });
    } else {
      touch({ status: "published", url: out.url, uncertain: false, step: "api-done" });
    }
    return;
  }
  if (platform === "facebook") {
    const out = await facebookUploadReel({ videoPath: input.videoPath, description, publishAt });
    if (publishAt) {
      touch({
        status: "scheduled",
        scheduled_at: publishAt.toISOString(),
        url: out.url,
        uncertain: false,
        step: "api-scheduled",
      });
    } else {
      touch({ status: "published", url: out.url, uncertain: false, step: "api-done" });
    }
    return;
  }
  if (platform === "tiktok") {
    const out = await tiktokUploadVideo({ videoPath: input.videoPath, caption: description, publishAt });
    if (publishAt) {
      touch({
        status: "scheduled",
        scheduled_at: publishAt.toISOString(),
        url: out.url,
        uncertain: false,
        step: "api-scheduled",
      });
    } else {
      touch({ status: "published", url: out.url, uncertain: false, step: "api-done" });
    }
    return;
  }
  throw new Error(`Unknown platform: ${platform}`);
}