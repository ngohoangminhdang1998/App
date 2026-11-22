import type { Page } from "playwright-core";
import { scheduleParts } from "./schedule.js";
import type { PlatformSchedule } from "./types.js";

/** Best-effort native schedule controls (varies by account). Returns false if not found. */
export async function applyNativeScheduleControls(page: Page, schedule: PlatformSchedule): Promise<boolean> {
  const parts = scheduleParts(schedule);
  const toggles = [
    page.getByRole("radio", { name: /schedule/i }),
    page.getByRole("switch", { name: /schedule/i }),
    page.getByLabel(/schedule/i),
    page.getByText(/^schedule$/i),
    page.getByRole("button", { name: /schedule/i }),
  ];
  let opened = false;
  for (const loc of toggles) {
    if (!(await loc.first().isVisible({ timeout: 2500 }).catch(() => false))) continue;
    await loc.first().click({ timeout: 8000 }).catch(() => undefined);
    opened = true;
    break;
  }
  if (!opened) return false;
  await page.waitForTimeout(400);

  const date = page.locator('input[type="date"]').first();
  if (await date.isVisible({ timeout: 5000 }).catch(() => false)) {
    await date.fill(parts.dateIso).catch(() => undefined);
  } else {
    const datePh = page.getByPlaceholder(/date|ngày/i).first();
    if (await datePh.isVisible({ timeout: 2000 }).catch(() => false)) await datePh.fill(parts.dateIso);
  }
  const time = page.locator('input[type="time"]').first();
  if (await time.isVisible({ timeout: 5000 }).catch(() => false)) {
    await time.fill(parts.timeHm).catch(() => undefined);
  } else {
    const timePh = page.getByPlaceholder(/time|giờ/i).first();
    if (await timePh.isVisible({ timeout: 2000 }).catch(() => false)) await timePh.fill(parts.timeHm);
  }
  return true;
}