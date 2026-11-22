import type { Page } from "playwright-core";

/** Entry URLs per spec — automation may navigate further inside each app. */
export const PLATFORM_ENTRY = {
  tiktok: "https://www.tiktok.com/tiktokstudio",
  youtube: "https://studio.youtube.com",
  facebook: "https://business.facebook.com",
} as const;

/** @deprecated legacy upload shortcuts; prefer PLATFORM_ENTRY workflows */
export const UPLOAD_URL = {
  tiktok: "https://www.tiktok.com/tiktokstudio/upload",
  youtube: "https://www.youtube.com/upload",
  facebook: "https://business.facebook.com/latest/reels_composer",
} as const;

export async function looksLikeLogin(page: Page): Promise<boolean> {
  const url = page.url();
  if (/login|signin|accounts\.google|checkpoint|auth|oauth/i.test(url)) return true;
  if (/tiktok\.com.*login/i.test(url)) return true;
  return page.getByText(/log in|sign in|create an account|đăng nhập/i).first().isVisible({ timeout: 2000 }).catch(() => false);
}

export async function waitForFileInput(page: Page, timeoutMs = 120_000) {
  const input = page.locator('input[type="file"]').last();
  await input.waitFor({ state: "attached", timeout: timeoutMs });
  return input;
}

export async function uploadFileInput(page: Page, videoPath: string, timeoutMs = 120_000): Promise<void> {
  const input = await waitForFileInput(page, timeoutMs);
  await input.setInputFiles(videoPath);
}

/** Wait until upload UI shows progress clearing or post fields appear. */
export async function waitAfterVideoUpload(page: Page, timeoutMs = 180_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const busy = page.getByText(/uploading|\d{1,3}%|processing|checking/i).first();
    const ready =
      (await page.getByRole("textbox", { name: /title|caption|description/i }).first().isVisible({ timeout: 400 }).catch(() => false)) ||
      (await page.locator('[contenteditable="true"]').first().isVisible({ timeout: 400 }).catch(() => false));
    if (ready && !(await busy.isVisible({ timeout: 300 }).catch(() => false))) return;
    if (ready) return;
    await page.waitForTimeout(1500);
  }
}

export async function clickNamedButton(page: Page, pattern: RegExp): Promise<boolean> {
  const btn = page.getByRole("button", { name: pattern });
  const n = await btn.count();
  for (let i = 0; i < n; i++) {
    const b = btn.nth(i);
    if (!(await b.isVisible({ timeout: 1500 }).catch(() => false))) continue;
    await b.click({ timeout: 15_000 });
    return true;
  }
  const link = page.getByRole("link", { name: pattern });
  if (await link.first().isVisible({ timeout: 2000 }).catch(() => false)) {
    await link.first().click({ timeout: 15_000 });
    return true;
  }
  return false;
}

export async function clickFirstRoleButton(page: Page, patterns: RegExp[]): Promise<boolean> {
  for (const re of patterns) {
    if (await clickNamedButton(page, re)) return true;
  }
  return false;
}

export async function fillCaptionField(page: Page, text: string): Promise<boolean> {
  const captionRole = page.getByRole("textbox", { name: /caption|description/i }).first();
  if (await captionRole.isVisible({ timeout: 8000 }).catch(() => false)) {
    await captionRole.fill(text);
    return true;
  }
  const editable = page.locator('[contenteditable="true"][data-text="true"], [contenteditable="true"]').first();
  if (await editable.isVisible({ timeout: 8000 }).catch(() => false)) {
    await editable.click();
    await page.keyboard.press("ControlOrMeta+A").catch(() => undefined);
    await page.keyboard.type(text, { delay: 3 });
    return true;
  }
  return false;
}