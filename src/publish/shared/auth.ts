import type { Page } from "playwright-core";
import { looksLikeLogin } from "./browser.js";
import { publishLog } from "./debug.js";
import type { PublishPlatform } from "../../publish.js";

const AUTH_WAIT_MS = Number(process.env.FLOW_MCP_PUBLISH_AUTH_MS ?? 4 * 60_000);

/** Pause for manual login/MFA; poll until session looks signed in or timeout. */
export async function ensureAuthenticated(
  page: Page,
  platform: PublishPlatform,
  label: string,
  onWaiting?: () => void,
): Promise<boolean> {
  if (!(await looksLikeLogin(page))) return true;
  publishLog(platform, "auth", `waiting for manual sign-in (${label})`);
  onWaiting?.();
  const deadline = Date.now() + AUTH_WAIT_MS;
  while (Date.now() < deadline) {
    await page.waitForTimeout(2500);
    if (!(await looksLikeLogin(page))) {
      publishLog(platform, "auth", "signed in");
      return true;
    }
  }
  return false;
}