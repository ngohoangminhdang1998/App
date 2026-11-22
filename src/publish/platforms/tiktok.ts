import { getBrowserPage } from "../../chrome.js";
import type { PlatformJobInput, PlatformTouch } from "../shared/types.js";
import {
  PLATFORM_ENTRY,
  UPLOAD_URL,
  clickFirstRoleButton,
  fillCaptionField,
  uploadFileInput,
  waitAfterVideoUpload,
} from "../shared/browser.js";
import { ensureAuthenticated } from "../shared/auth.js";
import { applyNativeScheduleControls } from "../shared/schedule-ui.js";
import { makeRunCtx } from "../shared/run.js";

async function openTikTokUpload(page: import("playwright-core").Page): Promise<void> {
  const uploadLink = page
    .getByRole("link", { name: /upload/i })
    .or(page.getByRole("button", { name: /upload/i }))
    .first();
  if (await uploadLink.isVisible({ timeout: 6000 }).catch(() => false)) {
    await uploadLink.click({ timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    return;
  }
  await page.goto(UPLOAD_URL.tiktok, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
}

export async function publishTikTok(input: PlatformJobInput, touch: PlatformTouch): Promise<void> {
  touch({ status: "preparing" });
  const page = await getBrowserPage(PLATFORM_ENTRY.tiktok);
  const ctx = makeRunCtx(page, "tiktok", input, touch);
  await ctx.step("open_tiktok_studio");

  const authed = await ensureAuthenticated(page, "tiktok", "TikTok", () =>
    touch({ status: "needs_attention", error: "Sign in to TikTok in the Flow Chrome window.", step: "auth" }),
  );
  if (!authed) {
    touch({
      status: "needs_attention",
      error: "TikTok sign-in timed out. Sign in manually, then retry.",
      step: "auth",
    });
    return;
  }

  await ctx.step("navigate_upload");
  await openTikTokUpload(page);

  touch({ status: "uploading" });
  await ctx.step("select_video_file");
  await uploadFileInput(page, input.videoPath);

  touch({ status: "processing" });
  await ctx.step("wait_processing");
  await waitAfterVideoUpload(page);

  await ctx.step("fill_caption");
  const filled = await fillCaptionField(page, input.finalText);
  if (!filled) {
    touch({
      status: "needs_attention",
      error: "Could not find TikTok caption field. Finish caption in the open tab.",
      step: "fill_caption",
    });
    return;
  }

  if (input.mode === "schedule") {
    if (!input.schedule) {
      touch({ status: "failed", error: "Missing schedule time.", step: "schedule" });
      return;
    }
    const when = input.schedule;
    touch({ status: "scheduling" });
    await ctx.step("native_schedule");
    const ok = await applyNativeScheduleControls(page, when);
    if (!ok) {
      touch({
        status: "failed",
        error: "TikTok native scheduling is not available on this account.",
        step: "native_schedule",
      });
      return;
    }
    const clicked = await clickFirstRoleButton(page, [/^schedule$/i, /schedule post/i, /post/i]);
    await ctx.step("submit_schedule");
    if (!clicked) {
      touch({ status: "needs_attention", error: "Confirm TikTok schedule in the open tab.", step: "submit_schedule" });
      return;
    }
    await page.waitForTimeout(3000);
    const schedList = page.getByText(/scheduled|content calendar/i).first();
    if (await schedList.isVisible({ timeout: 8000 }).catch(() => false)) {
      touch({
        status: "scheduled",
        scheduled_at: when.at.toISOString(),
        url: page.url(),
        uncertain: false,
      });
    } else {
      touch({
        status: "unknown",
        uncertain: true,
        scheduled_at: when.at.toISOString(),
        error: "TikTok schedule submitted — verify in TikTok Studio scheduled list.",
      });
    }
    return;
  }

  touch({ status: "publishing" });
  await ctx.step("publish_now");
  const clicked = await clickFirstRoleButton(page, [/post now/i, /^post$/i, /publish/i]);
  if (!clicked) {
    touch({ status: "needs_attention", error: "Tap Post in TikTok Studio to finish.", step: "publish_now" });
    return;
  }
  await page.waitForTimeout(5000);
  const success = page.getByText(/uploaded|published|your video is being uploaded/i).first();
  const leftUpload = !/\/upload/i.test(page.url());
  if ((await success.isVisible({ timeout: 6000 }).catch(() => false)) || leftUpload) {
    touch({ status: "published", url: page.url(), uncertain: false });
  } else {
    touch({
      status: "unknown",
      uncertain: true,
      error: "TikTok may have published — confirm in TikTok before retrying.",
    });
  }
}