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
  if (input.mode === "schedule") {
    throw new Error(`${platform}: API mode supports Publish now only. Use browser mode for native scheduling.`);
  }
  const description = input.finalText;
  const title = titleFromText(description);
  touch({ status: "uploading", step: "api-upload" });
  if (platform === "youtube") {
    const out = await youtubeUploadVideo({ videoPath: input.videoPath, title, description });
    touch({ status: "published", url: out.url, uncertain: false, step: "api-done" });
    return;
  }
  if (platform === "facebook") {
    const out = await facebookUploadReel({ videoPath: input.videoPath, description });
    touch({ status: "published", url: out.url, uncertain: false, step: "api-done" });
    return;
  }
  if (platform === "tiktok") {
    const out = await tiktokUploadVideo({ videoPath: input.videoPath, caption: description });
    touch({ status: "published", url: out.url, uncertain: false, step: "api-done" });
    return;
  }
  throw new Error(`Unknown platform: ${platform}`);
}