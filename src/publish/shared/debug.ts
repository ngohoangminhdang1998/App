import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { HOME_DIR } from "../../chrome.js";
import type { PublishPlatform } from "../../publish.js";

const DEBUG = () => process.env.FLOW_MCP_PUBLISH_DEBUG === "1" || process.env.FLOW_MCP_DEBUG === "1";

export function publishLog(platform: PublishPlatform, step: string, detail?: string): void {
  const line = detail ? `${step} — ${detail}` : step;
  if (DEBUG()) console.error(`[flow-mcp publish:${platform}] ${line}`);
}

export async function publishScreenshot(page: Page, platform: PublishPlatform, step: string): Promise<string | undefined> {
  if (!DEBUG()) return undefined;
  const dir = join(HOME_DIR, "publish-debug", platform);
  mkdirSync(dir, { recursive: true });
  const safe = step.replace(/[^\w.-]+/g, "_").slice(0, 80);
  const path = join(dir, `${Date.now()}-${safe}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => undefined);
  publishLog(platform, "screenshot", path);
  return path;
}

export class PublishStepError extends Error {
  constructor(
    readonly platform: PublishPlatform,
    readonly step: string,
    message: string,
    readonly screenshot?: string,
  ) {
    super(message);
    this.name = "PublishStepError";
  }
}