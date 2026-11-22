import type { Page } from "playwright-core";
import { getBrowserPage } from "../../chrome.js";
import type { PlatformJobInput, PlatformTouch } from "../shared/types.js";
import {
  PLATFORM_ENTRY,
  UPLOAD_URL,
  clickFirstRoleButton,
  clickNamedButton,
  uploadFileInput,
  waitAfterVideoUpload,
} from "../shared/browser.js";
import { ensureAuthenticated } from "../shared/auth.js";
import { scheduleParts } from "../shared/schedule.js";
import { makeRunCtx } from "../shared/run.js";

async function openUploadDialog(page: Page): Promise<boolean> {
  if (page.url().includes("/upload")) return true;
  const create = page.getByRole("button", { name: /create/i });
  if (!(await create.first().isVisible({ timeout: 12_000 }).catch(() => false))) {
    await page.goto(UPLOAD_URL.youtube, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return true;
  }
  await create.first().click({ timeout: 15_000 });
  await page.waitForTimeout(400);
  const uploadItem = page.getByRole("menuitem", { name: /upload videos?/i }).or(page.getByText(/upload videos?/i)).first();
  if (await uploadItem.isVisible({ timeout: 5000 }).catch(() => false)) {
    await uploadItem.click({ timeout: 15_000 });
    await page.waitForTimeout(800);
    return true;
  }
  await page.goto(UPLOAD_URL.youtube, { waitUntil: "domcontentloaded", timeout: 60_000 });
  return true;
}

async function advanceWizard(page: Page, maxSteps: number): Promise<void> {
  const next = page.getByRole("button", { name: /^next$/i });
  for (let i = 0; i < maxSteps; i++) {
    if (!(await next.isVisible({ timeout: 4000 }).catch(() => false))) break;
    await next.click({ timeout: 12_000 }).catch(() => undefined);
    await page.waitForTimeout(700);
  }
}

async function completeAudienceStep(page: Page, touch: PlatformTouch): Promise<boolean> {
  const kidsQ = page.getByText(/made for kids|audience/i).first();
  if (!(await kidsQ.isVisible({ timeout: 5000 }).catch(() => false))) return true;
  const pref = (process.env.FLOW_MCP_YOUTUBE_MADE_FOR_KIDS ?? "").toLowerCase();
  if (!pref) {
    touch({
      status: "needs_attention",
      error:
        'Set audience in the YouTube upload wizard, or set env FLOW_MCP_YOUTUBE_MADE_FOR_KIDS to "yes" or "no" and retry.',
      step: "audience",
    });
    return false;
  }
  const yes = page.getByRole("radio", { name: /yes.*made for kids|it's made for kids/i });
  const no = page.getByRole("radio", { name: /no.*not made for kids|isn't made for kids/i });
  if (pref === "yes" && (await yes.first().isVisible({ timeout: 3000 }).catch(() => false))) await yes.first().click();
  else if (pref === "no" && (await no.first().isVisible({ timeout: 3000 }).catch(() => false))) await no.first().click();
  else return false;
  return true;
}

async function setVisibility(page: Page, mode: "now" | "schedule", schedule?: PlatformJobInput["schedule"]): Promise<boolean> {
  if (mode === "now") {
    const pub = page.getByRole("radio", { name: /^public$/i });
    if (await pub.isVisible({ timeout: 8000 }).catch(() => false)) {
      await pub.click({ timeout: 10_000 });
      return true;
    }
    return clickNamedButton(page, /public/i);
  }
  const sched = page
    .getByRole("radio", { name: /schedule/i })
    .or(page.getByLabel(/schedule/i))
    .first();
  if (!(await sched.isVisible({ timeout: 10_000 }).catch(() => false))) return false;
  await sched.click({ timeout: 10_000 });
  await page.waitForTimeout(500);
  if (schedule) {
    const parts = scheduleParts(schedule);
    const dateInput = page.locator('input[type="date"]').first();
    if (await dateInput.isVisible({ timeout: 4000 }).catch(() => false)) await dateInput.fill(parts.dateIso);
    const timeInput = page.locator('input[type="time"]').first();
    if (await timeInput.isVisible({ timeout: 4000 }).catch(() => false)) await timeInput.fill(parts.timeHm);
  }
  return true;
}

export async function publishYouTube(input: PlatformJobInput, touch: PlatformTouch): Promise<void> {
  touch({ status: "preparing" });
  const page = await getBrowserPage(PLATFORM_ENTRY.youtube);
  const ctx = makeRunCtx(page, "youtube", input, touch);
  await ctx.step("open_youtube_studio");

  const authed = await ensureAuthenticated(page, "youtube", "YouTube", () =>
    touch({ status: "needs_attention", error: "Sign in to Google/YouTube in the Flow Chrome window.", step: "auth" }),
  );
  if (!authed) {
    touch({ status: "needs_attention", error: "YouTube sign-in timed out.", step: "auth" });
    return;
  }

  await ctx.step("create_upload");
  await openUploadDialog(page);

  touch({ status: "uploading" });
  await ctx.step("select_video_file");
  await uploadFileInput(page, input.videoPath);

  touch({ status: "processing" });
  await ctx.step("wait_processing");
  await waitAfterVideoUpload(page);

  await ctx.step("fill_title_description");
  const titleBox = page.getByRole("textbox", { name: /title/i }).first();
  if (await titleBox.isVisible({ timeout: 25_000 }).catch(() => false)) {
    await titleBox.fill(input.finalText);
  } else {
    touch({ status: "needs_attention", error: "YouTube title field not found.", step: "fill_title" });
    return;
  }
  const desc = page.getByRole("textbox", { name: /description/i }).first();
  if (await desc.isVisible({ timeout: 8000 }).catch(() => false)) await desc.fill(input.finalText);

  await advanceWizard(page, 2);
  if (!(await completeAudienceStep(page, touch))) return;
  await advanceWizard(page, 2);

  if (input.mode === "schedule") {
    touch({ status: "scheduling" });
    await ctx.step("visibility_schedule");
    if (!input.schedule) {
      touch({ status: "failed", error: "Missing schedule time.", step: "schedule" });
      return;
    }
    const when = input.schedule;
    const visOk = await setVisibility(page, "schedule", when);
    if (!visOk) {
      touch({
        status: "failed",
        error: "YouTube native Schedule visibility was not found.",
        step: "visibility_schedule",
      });
      return;
    }
    await advanceWizard(page, 2);
    await ctx.step("submit_schedule");
    const clicked = await clickFirstRoleButton(page, [/schedule/i, /publish/i, /done/i]);
    if (!clicked) {
      touch({ status: "needs_attention", error: "Confirm YouTube schedule in Studio.", step: "submit_schedule" });
      return;
    }
    await page.waitForTimeout(4000);
    const scheduled = page.getByText(/scheduled for|will be published/i).first();
    touch({
      status: (await scheduled.isVisible({ timeout: 8000 }).catch(() => false)) ? "scheduled" : "unknown",
      uncertain: !(await scheduled.isVisible({ timeout: 1000 }).catch(() => false)),
      scheduled_at: when.at.toISOString(),
      url: page.url(),
      error: !(await scheduled.isVisible({ timeout: 1000 }).catch(() => false))
        ? "Check YouTube Studio → Content for a Scheduled video."
        : undefined,
    });
    return;
  }

  touch({ status: "publishing" });
  await ctx.step("visibility_public");
  const visOk = await setVisibility(page, "now");
  if (!visOk) await clickNamedButton(page, /public|unlisted/i);

  await advanceWizard(page, 3);
  await ctx.step("publish");
  const clicked = await clickFirstRoleButton(page, [/publish/i, /save/i]);
  if (!clicked) {
    touch({ status: "needs_attention", error: "Click Publish in YouTube Studio.", step: "publish" });
    return;
  }
  await page.waitForTimeout(5000);
  const done = page.getByText(/video published|processing will begin|upload complete/i).first();
  const url = page.url();
  if ((await done.isVisible({ timeout: 10000 }).catch(() => false)) || /\/video\//i.test(url)) {
    touch({ status: "published", url, uncertain: false });
  } else {
    touch({
      status: "unknown",
      uncertain: true,
      url,
      error: "Confirm publication in YouTube Studio before retrying.",
    });
  }
}