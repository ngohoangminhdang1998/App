import type { Page } from "playwright-core";
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

async function openReelComposer(page: Page): Promise<void> {
  const reel = page
    .getByRole("link", { name: /reel|create reel/i })
    .or(page.getByRole("button", { name: /reel|create reel/i }))
    .or(page.getByText(/create reel/i))
    .first();
  if (await reel.isVisible({ timeout: 8000 }).catch(() => false)) {
    await reel.click({ timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
    return;
  }
  await page.goto(UPLOAD_URL.facebook, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => undefined);
}

/** Prefer Facebook Page destination; never auto-select Instagram. */
async function ensureFacebookPageTarget(page: Page): Promise<void> {
  const ig = page.getByRole("checkbox", { name: /instagram/i }).or(page.getByLabel(/instagram/i));
  if (await ig.first().isVisible({ timeout: 3000 }).catch(() => false)) {
    const checked = await ig.first().isChecked().catch(() => false);
    if (checked) await ig.first().uncheck({ timeout: 5000 }).catch(() => undefined);
  }
}

export async function publishFacebook(input: PlatformJobInput, touch: PlatformTouch): Promise<void> {
  touch({ status: "preparing" });
  const page = await getBrowserPage(PLATFORM_ENTRY.facebook);
  const ctx = makeRunCtx(page, "facebook", input, touch);
  await ctx.step("open_meta_business_suite");

  const authed = await ensureAuthenticated(page, "facebook", "Facebook", () =>
    touch({ status: "needs_attention", error: "Sign in to Facebook in the Flow Chrome window.", step: "auth" }),
  );
  if (!authed) {
    touch({ status: "needs_attention", error: "Facebook sign-in timed out.", step: "auth" });
    return;
  }

  await ctx.step("reel_composer");
  await openReelComposer(page);

  touch({ status: "uploading" });
  await ctx.step("select_video_file");
  await uploadFileInput(page, input.videoPath);

  touch({ status: "processing" });
  await ctx.step("wait_processing");
  await waitAfterVideoUpload(page);

  await ctx.step("page_destination");
  await ensureFacebookPageTarget(page);

  await ctx.step("fill_caption");
  const filled = await fillCaptionField(page, input.finalText);
  if (!filled) {
    touch({ status: "needs_attention", error: "Facebook Reel caption field not found.", step: "fill_caption" });
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
        error: "Facebook Page Reels native scheduling is not available on this account.",
        step: "native_schedule",
      });
      return;
    }
    const clicked = await clickFirstRoleButton(page, [/schedule/i, /done/i, /save/i]);
    await ctx.step("submit_schedule");
    if (!clicked) {
      touch({ status: "needs_attention", error: "Confirm Facebook schedule in Meta Business Suite.", step: "submit_schedule" });
      return;
    }
    touch({
      status: "scheduled",
      scheduled_at: when.at.toISOString(),
      url: page.url(),
      uncertain: true,
      error: "Verify the Reel appears under Planned/Scheduled posts in Business Suite.",
    });
    return;
  }

  touch({ status: "publishing" });
  await ctx.step("publish_now");
  await ensureFacebookPageTarget(page);
  const clicked = await clickFirstRoleButton(page, [/publish now/i, /^publish$/i, /post now/i, /share/i]);
  if (!clicked) {
    touch({ status: "needs_attention", error: "Click Publish in Meta Business Suite.", step: "publish_now" });
    return;
  }
  await page.waitForTimeout(5000);
  const okText = page.getByText(/published|scheduled|your reel is/i).first();
  if (await okText.isVisible({ timeout: 8000 }).catch(() => false)) {
    touch({ status: "published", url: page.url(), uncertain: false });
  } else {
    touch({
      status: "unknown",
      uncertain: true,
      error: "Confirm Facebook Reel publish before retrying.",
    });
  }
}