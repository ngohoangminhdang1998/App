import type { Page } from "playwright-core";
import type { PublishPlatform } from "../../publish.js";
import type { PlatformJobInput, PlatformTouch } from "./types.js";
import { publishLog, publishScreenshot } from "./debug.js";

export interface PlatformRunCtx {
  page: Page;
  platform: PublishPlatform;
  input: PlatformJobInput;
  touch: PlatformTouch;
  step: (name: string) => Promise<void>;
  fail: (step: string, message: string, status?: "failed" | "needs_attention") => Promise<never>;
}

export function wrapTouch(platform: PublishPlatform, touch: PlatformTouch, onStep?: (s: string) => void): PlatformTouch {
  return (patch) => {
    if (typeof patch.step === "string") onStep?.(patch.step);
    touch(patch);
  };
}

export function makeRunCtx(
  page: Page,
  platform: PublishPlatform,
  input: PlatformJobInput,
  touch: PlatformTouch,
): PlatformRunCtx {
  const t = wrapTouch(platform, touch, (s) => publishLog(platform, s));
  return {
    page,
    platform,
    input,
    touch: t,
    async step(name) {
      publishLog(platform, name);
      t({ step: name });
      await publishScreenshot(page, platform, name);
    },
    async fail(step, message, status = "failed") {
      await publishScreenshot(page, platform, `fail-${step}`);
      t({ status, error: message, step });
      throw new Error(message);
    },
  };
}