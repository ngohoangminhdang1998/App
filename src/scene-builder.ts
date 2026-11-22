import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { HOME_DIR } from "./chrome.js";
import { optionIsExactMedia } from "./media-ref.js";

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const assetOptionRe = (name: string) =>
  new RegExp(`^${escapeRe(name.trim())}(?:\\s+(?:Image|Video|Avatar))?$`, "i");
const optionByName = (list: Locator, name: string) =>
  list.getByRole("option", { name: assetOptionRe(name) }).first();

export type MergeUiState =
  | "MEDIA_PICKER_OPEN"
  | "ADD_CLIP_MENU"
  | "TIMELINE_WITH_CLIPS"
  | "EMPTY_TIMELINE"
  | "UNKNOWN";

function mergeStep(text: string): void {
  if (process.env.FLOW_MCP_DEBUG) console.error(`[flow-mcp merge] ${text}`);
}

/** Timeline / filmstrip — tag name varies; never block the whole merge on one selector. */
function timelineCandidates(page: Page): Locator[] {
  return [
    page.locator("flow-clip-filmstrip"),
    page.locator("flow-multi-clip-video-player"),
    page.locator("flow-scene-timeline"),
    page.locator('[class*="filmstrip"]'),
    page.locator('[class*="timeline-track"]'),
  ];
}

async function timelineRegion(page: Page): Promise<Locator> {
  for (const loc of timelineCandidates(page)) {
    if ((await loc.count()) > 0 && (await loc.first().isVisible({ timeout: 800 }).catch(() => false))) return loc.first();
  }
  return page.locator('[class*="timeline"], [class*="filmstrip"]').first();
}

async function inBottomEditComposer(locator: Locator): Promise<boolean> {
  return locator
    .evaluate((el) => {
      if (el.closest("flow-base-prompt-box")) return true;
      const host = el.closest("[class*='edit-composer'], [class*='scene-edit'], [class*='bottom-panel']");
      if (host?.textContent?.toLowerCase().includes("describe how to edit")) return true;
      return false;
    })
    .catch(() => false);
}

/** True when the filmstrip shows at least one placed clip (even if data-clip-id is missing). */
export async function sceneTimelineHasAnyClip(page: Page): Promise<boolean> {
  const n = await sceneTimelineClipCount(page);
  if (n > 0) return true;
  return page.evaluate(() => {
    const strip =
      document.querySelector("flow-clip-filmstrip") ||
      document.querySelector("[id^='flow-scene-timeline-area']") ||
      document.querySelector("flow-scene-timeline");
    if (!strip) return false;
    const isScrollbar = (el: Element) => !!el.closest("flow-timeline-scrollbar");
    for (const img of strip.querySelectorAll("img, video")) {
      if (isScrollbar(img)) continue;
      const r = (img as HTMLElement).getBoundingClientRect();
      if (r.width < 36 || r.height < 20) continue;
      const alt = img.getAttribute("alt") || "";
      if (/^generated video thumbnail$/i.test(alt) && r.width < 50) continue;
      return true;
    }
    const filled = strip.querySelector(
      "[data-clip-id], [class*='clip-card'], [class*='timeline-clip'], [class*='filmstrip-clip']",
    );
    if (filled && !isScrollbar(filled)) return true;
    return false;
  });
}

export async function sceneTimelineClipCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const isScrollbar = (el: Element) =>
      !!el.closest("flow-timeline-scrollbar") ||
      el.getAttribute("role") === "scrollbar" ||
      el.classList.contains("scrollbar-thumb");
    const roots = [
      document.querySelector("flow-clip-filmstrip"),
      document.querySelector("[id^='flow-scene-timeline-area']"),
      document.querySelector("flow-scene-timeline"),
      document.querySelector('[class*="filmstrip"]'),
    ].filter(Boolean) as Element[];
    for (const strip of roots.length ? roots : [document.body]) {
      const marked = [...strip.querySelectorAll("[data-clip-id]")].filter((el) => !isScrollbar(el));
      if (marked.length) return marked.length;
      const clips = [...strip.querySelectorAll("[class*='clip-card'], [class*='clip-tile'], [class*='timeline-clip']")].filter(
        (el) => !isScrollbar(el),
      );
      if (clips.length) return clips.length;
      const hostKeys = new Set<string>();
      for (const img of strip.querySelectorAll("img")) {
        if (isScrollbar(img)) continue;
        const r = img.getBoundingClientRect();
        if (r.width < 24 || r.height < 24 || r.width > 140) continue;
        const host =
          img.closest("[data-clip-id]") ||
          img.closest("[class*='clip-card'], [class*='timeline-clip'], [class*='filmstrip']") ||
          img.parentElement;
        if (!host || isScrollbar(host)) continue;
        const hr = host.getBoundingClientRect();
        if (hr.width < 40) continue;
        hostKeys.add(`${Math.round(hr.left)}:${Math.round(hr.top)}:${Math.round(hr.width)}`);
      }
      if (hostKeys.size > 0) return hostKeys.size;
      const containers = [...strip.querySelectorAll("[class*='filmstrip-clip'], [class*='clip-container']")].filter(
        (el) => !isScrollbar(el),
      );
      if (containers.length) return containers.length;
      const thumbs = [...strip.querySelectorAll("img")].filter((img) => {
        if (isScrollbar(img)) return false;
        const r = img.getBoundingClientRect();
        if (r.width < 24 || r.height < 24) return false;
        if (r.width > 140) return false;
        const alt = img.getAttribute("alt") || "";
        return !/^generated video thumbnail$/i.test(alt);
      });
      if (thumbs.length) return Math.max(1, new Set(thumbs.map((img) => img.parentElement)).size);
    }
    return 0;
  });
}

export async function sceneTimelineTitles(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const strip = document.querySelector("flow-clip-filmstrip");
    if (!strip) return out;
    for (const el of strip.querySelectorAll("[aria-label], [title]")) {
      const t = el.getAttribute("aria-label") || el.getAttribute("title");
      if (t?.trim()) out.push(t.trim());
    }
    for (const el of strip.querySelectorAll("img[alt]")) {
      const t = el.getAttribute("alt");
      if (t && !/^generated video thumbnail$/i.test(t)) out.push(t.trim());
    }
    return [...new Set(out)];
  });
}

export function timelineHasClip(titles: string[], want: string): boolean {
  return titles.some((t) => optionIsExactMedia(t, want));
}

export async function sceneMediaDialogOpen(page: Page): Promise<boolean> {
  if (await page.getByRole("listbox", { name: "Asset list" }).isVisible({ timeout: 400 }).catch(() => false)) return true;
  if (await page.getByRole("button", { name: "Add media", exact: true }).isVisible({ timeout: 400 }).catch(() => false))
    return true;
  if (await page.getByPlaceholder(/search assets/i).isVisible({ timeout: 400 }).catch(() => false)) return true;
  const dlg = page.getByRole("dialog").filter({ has: page.getByPlaceholder(/search assets/i) });
  if (await dlg.first().isVisible({ timeout: 400 }).catch(() => false)) return true;
  if (await page.getByText(/select media/i).first().isVisible({ timeout: 400 }).catch(() => false)) return true;
  return false;
}

/** After timeline + : menu offers Add clip vs Extend; sometimes + opens the picker in one click. */
async function chooseAddClipFromMenu(page: Page): Promise<boolean> {
  const candidates = [
    () => page.getByRole("menuitem", { name: /^\+?\s*Add clip$/i }).first(),
    () => page.getByRole("menuitem", { name: /add clip/i }).first(),
    () => page.locator('[role="menu"] [role="menuitem"], [role="menu"] button').filter({ hasText: /add clip/i }).first(),
    () => page.locator("button, [role='menuitem']").filter({ hasText: /^\+?\s*Add clip$/i }).first(),
  ];
  for (let pass = 0; pass < 24; pass++) {
    if (await sceneMediaDialogOpen(page)) return true;
    for (const pick of candidates) {
      const el = pick();
      if (!(await el.isVisible({ timeout: 250 }).catch(() => false))) continue;
      if (await inBottomEditComposer(el)) continue;
      mergeStep("menu → Add clip (not Extend)");
      await el.click({ timeout: 12_000 });
      await pause(page, 450);
      if (await sceneMediaDialogOpen(page)) return true;
    }
    await pause(page, 250);
  }
  return false;
}

async function ensureScenePickerVideosTab(page: Page): Promise<void> {
  const search = page.getByPlaceholder(/search assets/i);
  if (!(await search.isVisible({ timeout: 1500 }).catch(() => false))) return;
  const videos = page.getByRole("tab", { name: /^Videos$/i }).or(page.getByRole("button", { name: /^Videos$/i }));
  if (await videos.first().isVisible({ timeout: 800 }).catch(() => false)) {
    await videos.first().click({ timeout: 5000 }).catch(() => undefined);
    await pause(page, 300);
  }
}

async function waitForMediaPicker(page: Page): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await sceneMediaDialogOpen(page)) {
      await ensureScenePickerVideosTab(page);
      return;
    }
    await pause(page, 250);
  }
  const hint = await dumpMergeControlDebug(page, "MEDIA_PICKER_OPEN", "picker did not open");
  throw new Error(`Media picker did not open after clicking Add clip.${hint}`);
}

export async function detectMergeUiState(page: Page): Promise<MergeUiState> {
  if (await sceneMediaDialogOpen(page)) return "MEDIA_PICKER_OPEN";
  const menuItem = page.getByRole("menuitem", { name: /^\+?\s*Add clip$/i });
  const menuExtend = page.getByRole("menuitem", { name: /^>>?\s*Extend$/i });
  if (
    (await menuItem.isVisible({ timeout: 400 }).catch(() => false)) &&
    (await menuExtend.isVisible({ timeout: 400 }).catch(() => false))
  ) {
    return "ADD_CLIP_MENU";
  }
  const count = await sceneTimelineClipCount(page);
  const hasClip = await sceneTimelineHasAnyClip(page);
  if (count === 0 && !hasClip) return "EMPTY_TIMELINE";
  if (count > 0 || hasClip) return "TIMELINE_WITH_CLIPS";
  return "UNKNOWN";
}

/** Merge always works inside `/project/.../scene/...` — never the main grid. */
async function ensureSceneEditorTimeline(page: Page): Promise<void> {
  if (/\/project\/[0-9a-f-]{36}\/scene\/[0-9a-f-]{36}/i.test(page.url())) return;
  throw new Error(
    `Merge must stay on the Scene Editor timeline (not the grid). Current URL: ${page.url().slice(0, 120)}`,
  );
}

async function dismissMergeOverlaysOnly(page: Page): Promise<void> {
  if (await sceneMediaDialogOpen(page)) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await pause(page, 250);
    return;
  }
  const addClipItem = page.getByRole("menuitem", { name: /^\+?\s*Add clip$/i });
  const menuExtend = page.getByRole("menuitem", { name: /^>>?\s*Extend$/i });
  if (
    (await addClipItem.isVisible({ timeout: 300 }).catch(() => false)) &&
    (await menuExtend.isVisible({ timeout: 300 }).catch(() => false))
  ) {
    await page.keyboard.press("Escape").catch(() => undefined);
    await pause(page, 200);
  }
}

async function dumpMergeControlDebug(page: Page, state: MergeUiState, detail: string): Promise<string> {
  const dir = join(HOME_DIR, "merge-debug");
  mkdirSync(dir, { recursive: true });
  const stamp = Date.now();
  const shot = join(dir, `fail-${stamp}.png`);
  await page.screenshot({ path: shot, fullPage: true }).catch(() => undefined);
  const buttons = await page.evaluate(() => {
    return [...document.querySelectorAll("button, [role='button']")].map((b) => {
      const el = b as HTMLElement;
      return {
        text: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 100),
        aria: el.getAttribute("aria-label"),
        title: el.getAttribute("title"),
        role: el.getAttribute("role") || "button",
        inFilmstrip: !!el.closest("flow-clip-filmstrip"),
        inPrompt: !!el.closest("flow-base-prompt-box"),
        inDialog: !!el.closest('[role="dialog"]'),
      };
    });
  });
  const filmstrip = await page.evaluate(() => {
    const strip = document.querySelector("flow-clip-filmstrip");
    if (!strip) return { present: false, html: "" };
    return { present: true, html: strip.outerHTML.slice(0, 4000) };
  });
  const payload = { state, detail, screenshot: shot, buttons, filmstrip };
  console.error(`[flow-mcp merge debug] ${JSON.stringify(payload, null, 2)}`);
  return ` (debug screenshot: ${shot})`;
}

async function inComposer(locator: Locator): Promise<boolean> {
  return locator.evaluate((el) => !!el.closest("flow-base-prompt-box")).catch(() => false);
}

/** Empty timeline: centred white + (accessible name often "Add clip"). Not the bottom edit composer +. */
async function locateEmptyTimelineAddControl(page: Page): Promise<Locator> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const region = await timelineRegion(page);
    const scoped: Locator[] = [
      region.getByRole("button", { name: /^Add clip$/i }),
      region.locator('[aria-label="Add clip" i], [title="Add clip" i]'),
      region.locator("button").filter({ hasText: /^\+$/ }),
    ];
    const pageScoped: Locator[] = [
      page.getByRole("button", { name: /^Add clip$/i }),
      page.locator('button[aria-label="Add clip" i]'),
    ];
    for (const loc of [...scoped, ...pageScoped]) {
      const n = await loc.count();
      for (let i = 0; i < n; i++) {
        const btn = loc.nth(i);
        if (!(await btn.isVisible({ timeout: 500 }).catch(() => false))) continue;
        if (await inComposer(btn)) continue;
        if (await inBottomEditComposer(btn)) continue;
        const role = await btn.getAttribute("role").catch(() => "button");
        if (role === "menuitem") continue;
        mergeStep(`empty timeline + found (attempt ${attempt + 1})`);
        return btn;
      }
    }
    const hooked = await page.evaluate(() => {
      const isEditPanel = (el: Element) => {
        if (el.closest("flow-base-prompt-box")) return true;
        const t = el.textContent?.toLowerCase() ?? "";
        return t.includes("describe how to edit") || t.includes("omni 1.");
      };
      for (const el of document.querySelectorAll("button, [role='button']")) {
        if (isEditPanel(el)) continue;
        const bits = [el.getAttribute("aria-label"), el.getAttribute("title"), (el as HTMLElement).innerText]
          .filter(Boolean)
          .join(" ");
        if (!/add clip/i.test(bits) && bits.trim() !== "+") continue;
        const r = (el as HTMLElement).getBoundingClientRect();
        if (r.width < 8 || r.height < 8) continue;
        (el as HTMLElement).setAttribute("data-flow-mcp-merge-hook", "empty-add");
        return true;
      }
      return false;
    });
    if (hooked) return page.locator('[data-flow-mcp-merge-hook="empty-add"]');
    await pause(page, 500);
  }
  const hint = await dumpMergeControlDebug(page, "EMPTY_TIMELINE", "no timeline add control");
  throw new Error(`Could not find the white timeline + (Add clip) for the first video.${hint}`);
}

export async function openEmptyTimelineMediaPicker(page: Page): Promise<void> {
  if (await sceneMediaDialogOpen(page)) return;
  await ensureSceneEditorTimeline(page);
  mergeStep("EMPTY_TIMELINE → white + (opens media picker directly)");
  const btn = await locateEmptyTimelineAddControl(page);
  await btn.click({ timeout: 12_000 });
  await waitForMediaPicker(page);
}

async function timelineTailOffScreen(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const isScrollbar = (el: Element) => !!el.closest("flow-timeline-scrollbar");
    const area =
      document.querySelector("flow-clip-filmstrip") ||
      document.querySelector("[id^='flow-scene-timeline-area']") ||
      document.querySelector("flow-scene-timeline");
    if (!area) return false;
    const stripBox = (area as HTMLElement).getBoundingClientRect();
    let maxRight = 0;
    for (const el of area.querySelectorAll("[data-clip-id], img")) {
      if (isScrollbar(el)) continue;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 18 || r.height < 12) continue;
      maxRight = Math.max(maxRight, r.right);
    }
    return maxRight > stripBox.right + 4;
  });
}

/** Only when the last clip extends past the viewport — never scroll back left. */
async function maybeScrollTimelineEnd(page: Page): Promise<void> {
  if (!(await timelineTailOffScreen(page))) return;
  await scrollTimelineToRevealEnd(page);
}

/** White border on last clip — required before the filmstrip + appears. */
async function requireLastClipSelected(page: Page): Promise<void> {
  for (let i = 0; i < 10; i++) {
    if (await timelineClipSelected(page)) return;
    const prompt = await page.getByText(/select a clip to edit/i).isVisible({ timeout: 400 }).catch(() => false);
    mergeStep(`select last clip for white border (attempt ${i + 1}${prompt ? ", UI says Select a clip" : ""})`);
    await selectLastTimelineClipBody(page);
    await pause(page, 400);
    if (await timelineClipSelected(page)) return;
  }
  const hint = await dumpMergeControlDebug(page, "TIMELINE_WITH_CLIPS", "clip not selected");
  throw new Error(
    `Last clip must be selected on the timeline (white border) before + Add clip. Flow still shows "Select a clip to edit".${hint}`,
  );
}

/** Drag the scrollbar thumb toward the right (never from the left edge of the track). */
async function nudgeTimelineScrollbarRight(page: Page): Promise<void> {
  const track = page.locator("flow-timeline-scrollbar").first();
  if (!(await track.isVisible({ timeout: 1200 }).catch(() => false))) return;
  const plan = await page.evaluate(() => {
    const track = document.querySelector("flow-timeline-scrollbar");
    if (!track) return null;
    const tr = track.getBoundingClientRect();
    let thumb: HTMLElement | null = track.querySelector(".scrollbar-thumb");
    if (!thumb) {
      for (const el of track.querySelectorAll("*")) {
        const c = (el as HTMLElement).className?.toString() ?? "";
        if (/thumb/i.test(c)) {
          thumb = el as HTMLElement;
          break;
        }
      }
    }
    if (thumb) {
      const r = thumb.getBoundingClientRect();
      if (r.width < 4 || r.right >= tr.right - 6) return { done: true as const };
      return {
        done: false as const,
        mode: "drag" as const,
        fromX: r.left + r.width / 2,
        fromY: r.top + r.height / 2,
        toX: tr.right - 6,
        toY: r.top + r.height / 2,
      };
    }
    return {
      done: false as const,
      mode: "click" as const,
      toX: tr.right - 8,
      toY: tr.top + tr.height / 2,
    };
  });
  if (!plan || plan.done) return;
  mergeStep(plan.mode === "drag" ? "drag timeline thumb right" : "click timeline track (right end)");
  if (plan.mode === "drag") {
    await page.mouse.move(plan.fromX, plan.fromY);
    await page.mouse.down();
    await page.mouse.move(plan.toX, plan.toY, { steps: 10 });
    await page.mouse.up();
  } else {
    await page.mouse.click(plan.toX, plan.toY);
  }
  await pause(page, 220);
}

/** Long timelines: nudge scrollRight only until the last clip is visible (never scroll left). */
async function scrollTimelineToRevealEnd(page: Page): Promise<void> {
  const clipN = await sceneTimelineClipCount(page);
  const maxPass = Math.min(48, 14 + clipN * 4);
  mergeStep(`scroll timeline right only (clips≈${clipN})`);
  const filmstrip = page.locator("flow-clip-filmstrip, [id^='flow-scene-timeline-area']").first();
  const box = await filmstrip.boundingBox().catch(() => null);
  if (box) {
    await page.mouse.move(box.x + Math.min(box.width - 8, box.width * 0.88), box.y + box.height / 2);
  }
  for (let pass = 0; pass < maxPass; pass++) {
    const state = await page.evaluate(() => {
      const isScrollbar = (el: Element) => !!el.closest("flow-timeline-scrollbar");
      const probe = () => {
        const area =
          document.querySelector("flow-clip-filmstrip") ||
          document.querySelector("[id^='flow-scene-timeline-area']") ||
          document.querySelector("flow-scene-timeline");
        if (!area) return null;
        const pickScrollable = (): HTMLElement | null => {
          let el: Element | null = area;
          for (let i = 0; i < 10 && el; i++) {
            const h = el as HTMLElement;
            if (h.scrollWidth > h.clientWidth + 6) return h;
            el = el.parentElement;
          }
          const track = document.querySelector("flow-timeline-scrollbar");
          if (track) {
            const inner =
              (track.querySelector("[class*='scroll']") as HTMLElement | null) ||
              (track.firstElementChild as HTMLElement | null);
            if (inner && inner.scrollWidth > inner.clientWidth + 6) return inner;
          }
          return area as HTMLElement;
        };
        const scrollers: HTMLElement[] = [];
        const push = (h: HTMLElement | null) => {
          if (h && !scrollers.includes(h)) scrollers.push(h);
        };
        push(pickScrollable());
        for (let el: Element | null = area; el && scrollers.length < 6; el = el.parentElement) {
          const h = el as HTMLElement;
          if (h.scrollWidth > h.clientWidth + 4) push(h);
        }
        const stripBox = (area as HTMLElement).getBoundingClientRect();
        let maxRight = 0;
        for (const el of area.querySelectorAll("[data-clip-id], img")) {
          if (isScrollbar(el)) continue;
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.width < 18 || r.height < 12) continue;
          maxRight = Math.max(maxRight, r.right);
        }
        const tailVisible = maxRight > stripBox.left + 20 && maxRight <= stripBox.right + 8;
        const tailOffScreen = maxRight > stripBox.right + 4;
        return { scrollers, tailVisible, tailOffScreen };
      };
      const block = probe();
      if (!block?.scrollers.length) return null;
      let moved = false;
      for (const scroller of block.scrollers) {
        const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        const before = scroller.scrollLeft;
        if (max - before <= 2) continue;
        const step = Math.max(48, Math.min(scroller.clientWidth * 0.5, max - before));
        scroller.scrollLeft = Math.min(max, before + step);
        if (scroller.scrollLeft > before + 0.5) moved = true;
      }
      const after = probe();
      return {
        moved,
        tailVisible: after?.tailVisible ?? false,
        tailOffScreen: after?.tailOffScreen ?? false,
      };
    });
    if (!state) break;
    if (state.tailVisible) break;
    if (!state.moved && pass > 2) break;
    await pause(page, 110);
  }
  if (await timelineTailOffScreen(page)) {
    await nudgeTimelineScrollbarRight(page);
    if (box) {
      const wheels = Math.min(10, 3 + Math.min(clipN, 8));
      for (let w = 0; w < wheels; w++) {
        await page.mouse.wheel(140, 0).catch(() => undefined);
        await pause(page, 50);
      }
      await pause(page, 180);
    }
  }
}

async function lastTimelineClipRect(page: Page): Promise<{ left: number; top: number; right: number; bottom: number; width: number; height: number } | null> {
  await maybeScrollTimelineEnd(page);
  return page.evaluate(() => {
    const isScrollbar = (el: Element) =>
      !!el.closest("flow-timeline-scrollbar") ||
      el.getAttribute("role") === "scrollbar" ||
      el.classList.contains("scrollbar-thumb");
    const area =
      document.querySelector("flow-clip-filmstrip") ||
      document.querySelector("[id^='flow-scene-timeline-area']") ||
      document.querySelector("flow-scene-timeline");
    if (!area) return null;

    const marked = [...area.querySelectorAll("[data-clip-id]")].filter((el) => !isScrollbar(el));
    if (marked.length) {
      const sorted = marked
        .map((el) => (el as HTMLElement).getBoundingClientRect())
        .filter((r) => r.width > 20)
        .sort((a, b) => a.left - b.left);
      const r = sorted[sorted.length - 1];
      if (r) return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
    }

    type Host = { left: number; right: number; top: number; bottom: number; width: number; height: number };
    const hosts: Host[] = [];
    for (const img of area.querySelectorAll("img")) {
      if (isScrollbar(img)) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 24 || r.height < 24 || r.width > 200) continue;
      const host = (img.closest(
        "[data-clip-id], [class*='clip-card'], [class*='timeline-clip'], [class*='filmstrip-clip']",
      ) || img.parentElement) as HTMLElement | null;
      if (!host || isScrollbar(host)) continue;
      const hr = host.getBoundingClientRect();
      if (hr.width < 36 || hr.height < 18) continue;
      hosts.push({ left: hr.left, right: hr.right, top: hr.top, bottom: hr.bottom, width: hr.width, height: hr.height });
    }
    hosts.sort((a, b) => a.left - b.left);
    const merged: Host[] = [];
    for (const h of hosts) {
      const prev = merged[merged.length - 1];
      if (prev && h.left - prev.left < Math.max(prev.width * 0.45, 28)) {
        prev.right = Math.max(prev.right, h.right);
        prev.width = prev.right - prev.left;
        continue;
      }
      merged.push({ ...h });
    }
    const last = merged[merged.length - 1];
    return last ? last : null;
  });
}

async function timelineEndPlusCoords(
  page: Page,
  clipRect: { right: number; top: number; bottom: number; height: number } | null,
): Promise<{ x: number; y: number } | null> {
  if (clipRect && clipRect.right > 0 && (await timelineTailOffScreen(page))) {
    await scrollTimelineToRevealEnd(page);
  }
  return page.evaluate((clip) => {
    const isScrollbar = (el: Element) => !!el.closest("flow-timeline-scrollbar");
    const inComposer = (el: Element) => {
      if (el.closest("flow-base-prompt-box, flow-agent-panel")) return true;
      if (el.closest("[class*='edit-composer'], [class*='bottom-panel'], [class*='prompt-shelf']")) return true;
      const t = (el.textContent?.toLowerCase() ?? "");
      if (t.includes("describe how to edit") || /\bomni\s+1\./i.test(t)) return true;
      const strip =
        document.querySelector("flow-clip-filmstrip") ||
        document.querySelector("[id^='flow-scene-timeline-area']");
      const stripBox = strip?.getBoundingClientRect();
      const r = (el as HTMLElement).getBoundingClientRect();
      if (stripBox && r.top > stripBox.bottom + 20) return true;
      return false;
    };
    const strip =
      document.querySelector("flow-clip-filmstrip") ||
      document.querySelector("[id^='flow-scene-timeline-area']") ||
      document.querySelector("flow-scene-timeline");
    if (!strip) return null;

    const clipRight = clip?.right ?? 0;
    const clipMidY = clip ? (clip.top + clip.bottom) / 2 : 0;
    const stripBox = strip.getBoundingClientRect();

    type Hit = { x: number; y: number; score: number };
    const hits: Hit[] = [];
    const roots = [strip, strip.parentElement, document.querySelector("flow-scene-timeline")].filter(Boolean) as Element[];
    for (const root of roots) {
      for (const el of root.querySelectorAll("button, [role='button']")) {
        if (inComposer(el) || isScrollbar(el)) continue;
        const b = el as HTMLElement;
        const t = (b.innerText || "").replace(/\s+/g, " ").trim();
        const aria = b.getAttribute("aria-label") || "";
        if (t !== "+" && t !== "add" && !/^add clip$/i.test(t) && !/^add clip$/i.test(aria)) continue;
        const r = b.getBoundingClientRect();
        if (r.width < 10 || r.height < 10 || r.width > 72) continue;
        if (r.top < stripBox.top - 40 || r.bottom > stripBox.bottom + 120) continue;
        if (clip) {
          if (r.left < clipRight - 48) continue;
          if (r.left > clipRight + 200) continue;
          if (Math.abs(r.top + r.height / 2 - clipMidY) > 110) continue;
        }
        const score = clip ? r.left - clipRight : r.left;
        hits.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, score });
      }
    }
    hits.sort((a, b) => a.score - b.score);
    const best = hits.find((h) => h.score >= -30);
    return best ? { x: best.x, y: best.y } : hits[0] ?? null;
  }, clipRect);
}

async function sceneWantsClipSelection(page: Page): Promise<boolean> {
  return page.getByText(/select a clip to edit/i).isVisible({ timeout: 350 }).catch(() => false);
}

/** Filmstrip clip body (~72% from left) — center often misses the selectable chrome. */
async function clickTimelineClipAt(page: Page, rect: { left: number; top: number; width: number; height: number }): Promise<void> {
  const x = rect.left + rect.width * 0.72;
  const y = rect.top + rect.height / 2;
  await page.mouse.click(x, y);
  await pause(page, 220);
}

async function timelineClipSelected(page: Page): Promise<boolean> {
  if (await sceneWantsClipSelection(page)) return false;
  if (await timelineEndPlusCoords(page, await lastTimelineClipRect(page))) return true;
  return page.evaluate(() => {
    const isScrollbar = (el: Element) => !!el.closest("flow-timeline-scrollbar");
    const focused = document.querySelector("[data-clip-id].cdk-focused, [data-clip-id]:focus-visible");
    if (focused && !isScrollbar(focused)) return true;
    const selected = document.querySelector(
      "[data-clip-id][aria-selected='true'], flow-clip-filmstrip [aria-selected='true']",
    );
    if (selected && !isScrollbar(selected)) return true;
    const area = document.querySelector("flow-clip-filmstrip, [id^='flow-scene-timeline-area']");
    if (!area) return false;
    const looksSelected = (el: Element) => {
      if (isScrollbar(el)) return false;
      const cls = el.className?.toString() ?? "";
      if (/\b(selected|active|focused|is-selected)\b/i.test(cls)) return true;
      const s = getComputedStyle(el as HTMLElement);
      const w = Math.max(
        parseFloat(s.borderTopWidth) || 0,
        parseFloat(s.outlineWidth) || 0,
        parseFloat(s.borderWidth) || 0,
      );
      const col = `${s.borderTopColor} ${s.borderColor} ${s.outlineColor} ${s.boxShadow}`;
      if (w >= 1 && /255,\s*255,\s*255|rgb\(255,\s*255|#fff|white/i.test(col)) return true;
      if (s.boxShadow !== "none" && /255,\s*255,\s*255|rgb\(255/i.test(s.boxShadow)) return true;
      return false;
    };
    for (const el of area.querySelectorAll("[data-clip-id], [class*='clip-card'], [class*='timeline-clip'], [class*='filmstrip'] *")) {
      if (looksSelected(el)) return true;
    }
    return false;
  });
}

async function waitForTimelineClipSelected(page: Page): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await timelineClipSelected(page)) {
      mergeStep("timeline clip selected (+ at end / white border)");
      return;
    }
    await pause(page, 200);
  }
  mergeStep("warn: selection not detected in CSS — will still try + at last clip");
}

/** White + at the trailing edge of the last clip (visible once the clip is selected). */
async function clickPlusAfterSelectedClip(page: Page): Promise<void> {
  await requireLastClipSelected(page);
  let clipRect = await lastTimelineClipRect(page);
  if (!clipRect) {
    const hint = await dumpMergeControlDebug(page, "TIMELINE_WITH_CLIPS", "no last clip rect");
    throw new Error(`No clip found on the timeline filmstrip.${hint}`);
  }
  let hit: { x: number; y: number } | null = null;
  for (let attempt = 0; attempt < 6 && !hit; attempt++) {
    hit = await timelineEndPlusCoords(page, clipRect);
    if (hit) break;
    mergeStep(`no + yet (attempt ${attempt + 1}) — reselect last clip / scroll timeline`);
    if (await timelineTailOffScreen(page)) {
      await scrollTimelineToRevealEnd(page);
    }
    await requireLastClipSelected(page);
    clipRect = (await lastTimelineClipRect(page)) ?? clipRect;
    await clickTimelineClipAt(page, clipRect);
    await pause(page, 180);
    hit = await timelineEndPlusCoords(page, clipRect);
  }
  if (!hit) {
    const hint = await dumpMergeControlDebug(page, "TIMELINE_WITH_CLIPS", "end + not found");
    throw new Error(
      `Could not find the white + after the last clip. Select the clip on the timeline, then + appears at its right edge.${hint}`,
    );
  }
  mergeStep(`click white + after last clip (${Math.round(hit.x)},${Math.round(hit.y)})`);
  await page.mouse.click(hit.x, hit.y);
  await pause(page, 350);
  if (await sceneMediaDialogOpen(page)) return;
  const menuHit = await page.evaluate((pt) => {
    const inComposer = (el: Element) => {
      if (el.closest("flow-base-prompt-box")) return true;
      return (el.textContent?.toLowerCase() ?? "").includes("describe how to edit");
    };
    for (const el of document.querySelectorAll("button, [role='button'], [role='menuitem']")) {
      if (inComposer(el)) continue;
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!/add clip/i.test(t) || /extend/i.test(t)) continue;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 20) continue;
      if (Math.hypot(r.left + r.width / 2 - pt.x, r.top + r.height / 2 - pt.y) > 120) continue;
      (el as HTMLElement).setAttribute("data-flow-mcp-merge-hook", "adjacent-add-clip");
      return true;
    }
    return false;
  }, hit);
  if (menuHit) {
    const adj = page.locator('[data-flow-mcp-merge-hook="adjacent-add-clip"]');
    if (await adj.isVisible({ timeout: 1500 }).catch(() => false)) {
      mergeStep("+ opened a menu — click Add clip beside +");
      await adj.click({ timeout: 10_000 }).catch(() => undefined);
    }
  }
}

async function waitForTimelineClipCount(page: Page, atLeast: number, timeoutMs = 45_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let last = 0;
  while (Date.now() < deadline) {
    last = await sceneTimelineClipCount(page);
    if (last >= atLeast) return last;
    await pause(page, 350);
  }
  return last;
}

/** Clip 2+: must select the last clip (white border) before the end + appears. Never click timeline scrollbars. */
async function selectLastTimelineClip(page: Page): Promise<void> {
  await ensureSceneEditorTimeline(page);
  await dismissMergeOverlaysOnly(page);
  await selectLastTimelineClipBody(page);
}

async function selectLastTimelineClipBody(page: Page): Promise<void> {
  mergeStep("select last clip on timeline");
  await maybeScrollTimelineEnd(page);
  const filmstrip = page.locator("flow-clip-filmstrip").first();
  const byId = filmstrip.locator("[data-clip-id]");
  if ((await byId.count()) > 0) {
    const pick = await page.evaluate(() => {
      const isScrollbar = (el: Element) => !!el.closest("flow-timeline-scrollbar");
      const area = document.querySelector("flow-clip-filmstrip");
      if (!area) return null;
      const marked = [...area.querySelectorAll("[data-clip-id]")].filter((el) => !isScrollbar(el));
      if (!marked.length) return null;
      marked.sort(
        (a, b) =>
          (a as HTMLElement).getBoundingClientRect().left - (b as HTMLElement).getBoundingClientRect().left,
      );
      const last = marked[marked.length - 1] as HTMLElement;
      const r = last.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    if (pick) {
      await clickTimelineClipAt(page, pick);
      if (!(await timelineClipSelected(page))) await clickTimelineClipAt(page, pick);
      await waitForTimelineClipSelected(page).catch(() => undefined);
      return;
    }
    const last = byId.last();
    await last.click({ timeout: 10_000 });
    if (!(await timelineClipSelected(page))) await last.click({ timeout: 10_000 });
    await waitForTimelineClipSelected(page).catch(() => undefined);
    return;
  }
  const clipCards = filmstrip.locator("[class*='clip-card'], [class*='timeline-clip'], [class*='clip-tile']");
  if ((await clipCards.count()) > 0) {
    const last = clipCards.last();
    await last.click({ timeout: 10_000 });
    await waitForTimelineClipSelected(page).catch(() => undefined);
    return;
  }
  const thumbs = filmstrip.locator('img[alt*="Generated video" i], img[alt*="thumbnail" i]');
  if ((await thumbs.count()) > 0) {
    const last = thumbs.last();
    await last.click({ timeout: 10_000 });
    await waitForTimelineClipSelected(page).catch(() => undefined);
    return;
  }

  const target = await page.evaluate(() => {
    const isScrollbar = (el: Element) =>
      !!el.closest("flow-timeline-scrollbar") ||
      el.getAttribute("role") === "scrollbar" ||
      el.classList.contains("scrollbar-thumb");
    const area =
      document.querySelector("flow-clip-filmstrip") ||
      document.querySelector("[id^='flow-scene-timeline-area']") ||
      document.querySelector("flow-scene-timeline");
    if (!area) return null;

    const marked = [...area.querySelectorAll("[data-clip-id]")].filter((el) => !isScrollbar(el));
    if (marked.length) {
      marked.sort(
        (a, b) =>
          (a as HTMLElement).getBoundingClientRect().left - (b as HTMLElement).getBoundingClientRect().left,
      );
      const last = marked[marked.length - 1] as HTMLElement;
      const r = last.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    }

    type Host = { el: HTMLElement; left: number; width: number };
    const hosts: Host[] = [];
    for (const img of area.querySelectorAll("img")) {
      if (isScrollbar(img)) continue;
      const r = img.getBoundingClientRect();
      if (r.width < 24 || r.height < 24 || r.width > 140) continue;
      const host = (img.closest("[data-clip-id], [class*='filmstrip'], [class*='clip-card'], [class*='timeline-clip']") ||
        img.parentElement) as HTMLElement | null;
      if (!host || isScrollbar(host)) continue;
      const hr = host.getBoundingClientRect();
      if (hr.width < 40 || hr.height < 20) continue;
      hosts.push({ el: host, left: hr.left, width: hr.width });
    }
    hosts.sort((a, b) => a.left - b.left);
    const merged: Host[] = [];
    for (const h of hosts) {
      const prev = merged[merged.length - 1];
      if (prev && h.left - prev.left < Math.max(prev.width * 0.5, 30)) continue;
      merged.push(h);
    }
    const last = merged[merged.length - 1]?.el;
    if (!last) return null;
    const r = last.getBoundingClientRect();
    return { left: r.left, top: r.top, width: r.width, height: r.height };
  });

  if (target && (target.width ?? 0) > 0 && (target.height ?? 0) > 0) {
    await clickTimelineClipAt(page, target);
    if (!(await timelineClipSelected(page))) await clickTimelineClipAt(page, target);
    await waitForTimelineClipSelected(page).catch(() => undefined);
    return;
  }

  if (await filmstrip.isVisible({ timeout: 1500 }).catch(() => false)) {
    const box = await filmstrip.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width * 0.22, box.y + box.height / 2);
      await waitForTimelineClipSelected(page).catch(() => undefined);
      return;
    }
  }

  const hint = await dumpMergeControlDebug(page, "TIMELINE_WITH_CLIPS", "could not select last clip");
  throw new Error(`Could not select the last clip on the timeline (refusing to click the scrollbar).${hint}`);
}

export async function openNextClipMediaPicker(page: Page): Promise<void> {
  if (await sceneMediaDialogOpen(page)) return;
  await ensureSceneEditorTimeline(page);
  mergeStep("TIMELINE → select clip → white + → Add clip (not Extend)");
  await selectLastTimelineClip(page);
  await requireLastClipSelected(page);
  await pause(page, 300);

  const menuOpen =
    (await page.getByRole("menuitem", { name: /add clip/i }).isVisible({ timeout: 800 }).catch(() => false)) &&
    (await page.getByRole("menuitem", { name: /^Extend$/i }).isVisible({ timeout: 400 }).catch(() => false));
  if (menuOpen && (await chooseAddClipFromMenu(page))) {
    await ensureScenePickerVideosTab(page);
    return;
  }

  await clickPlusAfterSelectedClip(page);
  await pause(page, 500);

  if (await sceneMediaDialogOpen(page)) {
    await ensureScenePickerVideosTab(page);
    return;
  }

  if (await chooseAddClipFromMenu(page)) {
    await ensureScenePickerVideosTab(page);
    return;
  }

  const extendOnly = page.getByRole("menuitem", { name: /^Extend$/i });
  if (await extendOnly.isVisible({ timeout: 800 }).catch(() => false)) {
    const addVisible = await page
      .getByRole("menuitem", { name: /add clip/i })
      .isVisible({ timeout: 400 })
      .catch(() => false);
    if (!addVisible) {
      throw new Error('Add clip / Extend menu appeared but "Add clip" was not found — refusing Extend.');
    }
  }

  await waitForMediaPicker(page);
}

export async function selectVideoAsset(page: Page, title: string): Promise<void> {
  mergeStep(`select asset "${title}"`);
  await waitForMediaPicker(page).catch(() => undefined);
  const list = page.getByRole("listbox", { name: "Asset list" });
  if (await list.isVisible({ timeout: 3000 }).catch(() => false)) {
    const option = optionByName(list, title);
    if (await option.isVisible({ timeout: 12_000 }).catch(() => false)) {
      await option.click({ timeout: 10_000 });
      await pause(page, 250);
      return;
    }
  }
  const re = assetOptionRe(title);
  const row = page
    .getByRole("option", { name: re })
    .or(page.getByRole("button", { name: re }))
    .or(page.locator("mat-list-item, [role='listitem'], [class*='asset-row']").filter({ hasText: re }))
    .first();
  if (await row.isVisible({ timeout: 12_000 }).catch(() => false)) {
    await row.click({ timeout: 10_000 });
    await pause(page, 250);
    return;
  }
  await page.keyboard.press("Escape").catch(() => {});
  throw new Error(`Clip "${title}" was not found in the media picker.`);
}

async function sceneMediaPickerScope(page: Page) {
  const list = page.getByRole("listbox", { name: "Asset list" });
  const dialog = page.getByRole("dialog").filter({ has: list });
  if (await dialog.first().isVisible({ timeout: 400 }).catch(() => false)) return dialog.first();
  return page;
}

export async function confirmAddMedia(page: Page): Promise<void> {
  mergeStep("confirm → Add media");
  if (!(await sceneMediaDialogOpen(page))) {
    mergeStep("no media picker open — skip Add media");
    return;
  }
  const scope = await sceneMediaPickerScope(page);
  const confirm = scope.getByRole("button", { name: "Add media", exact: true });
  if (!(await confirm.isVisible({ timeout: 8000 }).catch(() => false))) {
    if (!(await sceneMediaDialogOpen(page))) return;
    throw new Error('Media picker is open but the "Add media" button did not appear.');
  }
  await confirm.click({ timeout: 10_000 });
  await page.getByRole("button", { name: "Add media", exact: true }).waitFor({ state: "hidden", timeout: 60_000 }).catch(() => {});
  await pause(page, 400);
}

export async function timelineHasEnoughClips(page: Page, want: number): Promise<boolean> {
  if (want <= 0) return true;
  const n = await sceneTimelineClipCount(page);
  return n >= want;
}

/** Top bar scene title (not grid "Editable text"): click title near Back → edit → tick to save. */
export async function renameSceneBuilderTitle(page: Page, want: string): Promise<void> {
  mergeStep(`rename scene title → ${want}`);
  const back = page.getByRole("button", { name: /Back button to go to previous page/i }).first();
  await back.waitFor({ state: "visible", timeout: 15_000 });
  const backBox = await back.boundingBox();
  if (!backBox) throw new Error("Could not read the Scene Editor back button position.");

  const titleHit = await page.evaluate((bb) => {
    const backRect = { left: bb.x, top: bb.y, right: bb.x + bb.width, bottom: bb.y + bb.height, cy: bb.y + bb.height / 2 };
    const candidates: { el: HTMLElement; score: number }[] = [];
    for (const el of document.querySelectorAll("button, [role='button'], [role='textbox'], input, [contenteditable='true'], span, div")) {
      if (el.closest("flow-base-prompt-box")) continue;
      const r = (el as HTMLElement).getBoundingClientRect();
      if (r.width < 40 || r.height < 14 || r.height > 56) continue;
      if (r.left < backRect.right - 4 || r.left > backRect.right + 520) continue;
      if (Math.abs(r.top + r.height / 2 - backRect.cy) > 36) continue;
      const tag = el.tagName.toLowerCase();
      const text = (el.textContent || "").trim();
      if (/^360p$/i.test(text) && r.width < 80) continue;
      let score = r.left;
      if (tag === "input" || el.getAttribute("role") === "textbox" || el.getAttribute("contenteditable") === "true") score -= 200;
      if (text.toLowerCase().includes("untitled scene") || text.toLowerCase().includes("scene")) score -= 100;
      candidates.push({ el: el as HTMLElement, score });
    }
    candidates.sort((a, b) => a.score - b.score);
    const pick = candidates[0]?.el;
    if (!pick) return null;
    pick.setAttribute("data-flow-mcp-scene-title", "1");
    const r = pick.getBoundingClientRect();
    return { x: r.left + Math.min(r.width * 0.35, 80), y: r.top + r.height / 2 };
  }, backBox);

  if (titleHit) await page.mouse.click(titleHit.x, titleHit.y);
  else await page.mouse.click(backBox.x + backBox.width + 140, backBox.y + backBox.height / 2);
  await pause(page, 450);

  const field = page
    .locator("[data-flow-mcp-scene-title]")
    .or(
      page
        .getByRole("textbox")
        .filter({ hasNot: page.locator("flow-base-prompt-box") })
        .filter({ hasNot: page.getByPlaceholder(/describe how to edit/i) }),
    )
    .or(page.locator("input:not(flow-base-prompt-box input)"))
    .first();

  await field.waitFor({ state: "visible", timeout: 12_000 });
  await field.click({ timeout: 5000 });
  await field.press("Control+A").catch(() => field.press("Meta+A").catch(() => undefined));
  await field.press("Backspace").catch(() => undefined);
  await field.fill(want);
  await pause(page, 250);

  const fieldBox = await field.boundingBox();
  const tickCandidates: Locator[] = [
    page.getByRole("button", { name: /confirm|save|apply|done/i }),
    page.locator("button[aria-label*='Confirm' i], button[aria-label*='Save' i]"),
  ];
  let saved = false;
  for (const tick of tickCandidates) {
    if (await tick.first().isVisible({ timeout: 800 }).catch(() => false)) {
      await tick.first().click({ timeout: 5000 });
      saved = true;
      break;
    }
  }
  if (!saved && fieldBox) {
    mergeStep("title tick — click by position (right of field)");
    await page.mouse.click(fieldBox.x + fieldBox.width + 36, fieldBox.y + fieldBox.height / 2);
    saved = true;
  }
  if (!saved) await field.press("Enter").catch(() => undefined);
  await pause(page, 600);
}

export async function verifyTimelineClipAdded(page: Page, title: string, beforeCount: number): Promise<void> {
  const after = await waitForTimelineClipCount(page, beforeCount + 1, 25_000);
  const titles = await sceneTimelineTitles(page);
  if (timelineHasClip(titles, title)) return;
  if (after > beforeCount) {
    mergeStep(`timeline count ${beforeCount} → ${after} (title "${title}" not in labels — ok)`);
    return;
  }
  if (beforeCount === 0 && (await sceneTimelineHasAnyClip(page))) {
    mergeStep("first clip visible on timeline (DOM count lag) — ok");
    return;
  }
  const retry = await sceneTimelineTitles(page);
  if (timelineHasClip(retry, title)) return;
  throw new Error(`"${title}" was not added to the timeline (count ${beforeCount} → ${after}).`);
}

export function parseAspectToggleLabel(text: string): "9:16" | "16:9" | undefined {
  const t = text.replace(/\s+/g, " ").trim();
  if (t === "9:16" || t === "16:9") return t;
  const m = t.match(/\b(16:9|9:16)\b/);
  return (m?.[1] as "9:16" | "16:9" | undefined) ?? undefined;
}

/** Left toolbar: aria-label "Toggle aspect ratio"; visible ratio is in .aspect-ratio-content ("16:9" / "9:16"). */
async function locateSceneAspectToggle(page: Page): Promise<Locator> {
  for (let attempt = 0; attempt < 12; attempt++) {
    const candidates = [
      page.locator("button.aspect-ratio-button").first(),
      page.getByRole("button", { name: /toggle aspect ratio/i }).first(),
      page.locator("button.left-toolbar-item.aspect-ratio-button").first(),
    ];
    for (const btn of candidates) {
      if (!(await btn.isVisible({ timeout: 800 }).catch(() => false))) continue;
      if (await inComposer(btn)) continue;
      return btn;
    }
    await pause(page, 500);
  }
  throw new Error("Could not find the Scene Editor aspect ratio toggle (button.aspect-ratio-button).");
}

async function readAspectFromToggle(toggle: Locator): Promise<"9:16" | "16:9" | undefined> {
  const content = toggle.locator(".aspect-ratio-content");
  let text = "";
  if ((await content.count()) > 0) text = await content.first().innerText().catch(() => "");
  if (!text) text = await toggle.innerText().catch(() => "");
  return parseAspectToggleLabel(text);
}

export async function readSceneBuilderAspect(page: Page): Promise<"9:16" | "16:9" | undefined> {
  try {
    const toggle = await locateSceneAspectToggle(page);
    return await readAspectFromToggle(toggle);
  } catch {
    return undefined;
  }
}

export async function setSceneBuilderAspectRatio(page: Page, want: "9:16" | "16:9"): Promise<void> {
  mergeStep(`aspect requested: ${want}`);
  const toggle = await locateSceneAspectToggle(page);
  let current = await readAspectFromToggle(toggle);
  mergeStep(`aspect current: ${current ?? "unknown"}`);

  if (current === want) {
    mergeStep(`aspect verified: ${want} (no click)`);
    return;
  }

  await toggle.click({ timeout: 10_000 });
  mergeStep("aspect toggle clicked: true");
  await pause(page, 600);

  const finalToggle = await locateSceneAspectToggle(page);
  const final = await readAspectFromToggle(finalToggle);
  mergeStep(`aspect final: ${final ?? "unknown"}`);

  if (final !== want) {
    throw new Error(`Scene Editor aspect is "${final ?? "unknown"}" after one toggle click; expected "${want}".`);
  }
  mergeStep(`aspect verified: ${final}`);
  await pause(page, 400);
}

export async function insertSceneBuilderClip(page: Page, title: string, opts: { isFirst: boolean }): Promise<void> {
  await ensureSceneEditorTimeline(page);
  const beforeTitles = await sceneTimelineTitles(page);
  if (timelineHasClip(beforeTitles, title)) {
    mergeStep(`skip "${title}" — already on timeline`);
    return;
  }
  let beforeCount = await sceneTimelineClipCount(page);
  if (beforeCount === 0 && (await sceneTimelineHasAnyClip(page))) {
    beforeCount = 1;
    mergeStep("timeline has clips but count was 0 — treating as 1 clip");
  }
  const ui = await detectMergeUiState(page);
  mergeStep(`insert "${title}" ui=${ui} first=${opts.isFirst} beforeCount=${beforeCount}`);

  const finishAdd = async () => {
    await selectVideoAsset(page, title);
    try {
      await confirmAddMedia(page);
    } catch (err) {
      const after = await waitForTimelineClipCount(page, beforeCount + 1, 8000);
      if (after > beforeCount) {
        mergeStep("Add media failed but clip count increased — ok");
      } else throw err;
    }
    await verifyTimelineClipAdded(page, title, beforeCount);
    await ensureSceneEditorTimeline(page);
    if (await sceneTimelineHasAnyClip(page)) {
      mergeStep("stay on timeline — select clip for next +");
      await selectLastTimelineClip(page);
      await requireLastClipSelected(page).catch(() => undefined);
    }
  };

  if (ui === "MEDIA_PICKER_OPEN") {
    await finishAdd();
    return;
  }
  if (ui === "ADD_CLIP_MENU") {
    if (beforeCount > 0) {
      await selectLastTimelineClip(page);
      await requireLastClipSelected(page);
    }
    await page.getByRole("menuitem", { name: /^\+?\s*Add clip$/i }).click({ timeout: 10_000 });
    await waitForMediaPicker(page);
    await finishAdd();
    return;
  }
  const empty = beforeCount === 0 && !(await sceneTimelineHasAnyClip(page));
  if (empty) await openEmptyTimelineMediaPicker(page);
  else await openNextClipMediaPicker(page);
  await finishAdd();
}