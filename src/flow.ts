import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import type { Download, Locator, Page } from "playwright-core";
import { HOME_DIR, getFlowPage, inEnglish } from "./chrome.js";
import { isMediaId, mediaRefLabel, optionHasNamePrefix, optionIsExactMedia, parseStoredRef } from "./media-ref.js";
import {
  type FlowCompositionRecord,
  contentHashFromTitles,
  getComposition,
  getCompositionByFlowId,
  saveComposition,
} from "./flow-composition.js";
import { filmFinalSceneName } from "./film-numbers.js";
import { normalizeLookEntry } from "./film-script.js";
import {
  insertSceneBuilderClip,
  renameSceneBuilderTitle,
  waitForSceneEditorReady,
  sceneTimelineClipCount,
  sceneTimelineClipCountAfterScroll,
  sceneTimelineTitles,
  setSceneBuilderAspectRatio,
  timelineHasClip,
  timelineHasEnoughClips,
  mergePaceMs,
  mergeSettle,
  timelineMergeSatisfied,
} from "./scene-builder.js";
import type { Job } from "./queue.js";
import { finalizeFlowDownload, sniffMediaFile } from "./media-download.js";
import { extractZip } from "./platform.js";

export interface FlowState {
  url: string;
  signedIn: boolean;
  inProject: boolean;
  plan?: string;
  credits_remaining?: number;
  composer?: string;
  user_display_name?: string;
  hint?: string;
}

const PLAN_LABEL = /^(ULTRA|PRO|FREE|PREMIUM|STANDARD|BASIC|GOOGLE FLOW)/i;

function firstName(name: string): string {
  const bit = name.trim().split(/\s+/)[0];
  return bit && !bit.includes("@") ? bit : "";
}

const UI_CHROME = /^(close|open|back|done|cancel|menu|more|upgrade|user|account)$/i;
const UI_CHROME_PHRASE =
  /sign out|switch account|manage subscription|manage account|watermark|privacy|terms|license|recaptcha|create avatar|google flow|resets?\s|account panel/i;

/** Best-effort display name from Flow's account UI — never reads email. */
function parseDisplayName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (!t || t.length > 80 || /@/.test(t)) return undefined;
  if (/^(connecting|loading)(\s*\.{0,3})?$/i.test(t)) return undefined;
  if (PLAN_LABEL.test(t)) return undefined;
  if (UI_CHROME.test(t)) return undefined;
  if (/credit|sign out|manage account/i.test(t)) return undefined;
  if (UI_CHROME_PHRASE.test(t)) return undefined;
  if (!/[A-Za-z\u00C0-\u024F]/.test(t)) return undefined;
  return t;
}

function scoreDisplayName(candidate: string): number {
  const t = candidate.trim();
  if (!parseDisplayName(t)) return -100;
  if (/^[A-Z][\p{L}'-]+(\s+[A-Z][\p{L}'-]+)+$/u.test(t)) return 30;
  if (/^[A-Z][\p{L}'-]+(\s+[\p{L}'-]+)+$/u.test(t)) return 20;
  if (t.split(/\s+/).length >= 2) return 10;
  return 5;
}

async function readAccountButtonLines(page: Page): Promise<string[]> {
  return page
    .getByRole("button", { name: "Account details" })
    .innerText()
    .then((t) => t.trim().split("\n").map((l) => l.trim()).filter(Boolean))
    .catch(() => [] as string[]);
}

function pickNameFromAccountLines(lines: string[]): string | undefined {
  const fromButton = lines.map((l) => parseDisplayName(l)).filter(Boolean) as string[];
  fromButton.sort((a, b) => scoreDisplayName(b) - scoreDisplayName(a));
  return fromButton[0];
}

async function readProfileDisplayName(page: Page): Promise<string | undefined> {
  const fromLabel = await page
    .getByRole("button", { name: "Account details" })
    .getAttribute("aria-label")
    .then((a) => {
      if (!a) return undefined;
      const stripped = a.replace(/account\s*details/gi, "").trim();
      return parseDisplayName(stripped);
    })
    .catch(() => undefined);
  if (fromLabel) return fromLabel;

  return pickNameFromAccountLines(await readAccountButtonLines(page));
}

const IMAGE_TIMEOUT_MS = 3 * 60_000;
const VIDEO_TIMEOUT_MS = 12 * 60_000;
const FAILURE_TEXT = /failed|couldn.t|unable/i;

const pause = (page: Page, ms: number) => page.waitForTimeout(ms);

// `detailed` opens the account panel to read the balance, so it must not run while a generation is driving the page.
export async function getFlowState(detailed = false): Promise<FlowState> {
  const page = await getFlowPage();
  const url = page.url();
  // Signed-out visitors are bounced to the marketing page or Google's sign-in.
  const signedIn = !/\/about|accounts\.google\.com/.test(url);
  const inProject = /\/project\//.test(url);
  const state: FlowState = { url, signedIn, inProject };
  if (!signedIn) state.hint = "Not signed in. Run `npm run login` and sign in to Google in the Flow Chrome window.";
  else if (!inProject) state.hint = "Signed in, but no project is open. Open or create a project in the Flow Chrome window.";
  else if (detailed) {
    // Plan + display name live on the closed Account details button. Never open the account panel here — it blocks
    // the grid and races with generation. Credits are read only when the user already left the panel open.
    await dismissOverlays(page);
    await scrollToTop(page);
    const accountLines = await readAccountButtonLines(page);
    state.plan = accountLines.find((l) => PLAN_LABEL.test(l)) ?? accountLines[0];
    state.user_display_name = (await readProfileDisplayName(page)) ?? pickNameFromAccountLines(accountLines);
    const panel = await readAccountPanelIfOpen(page, { needName: !state.user_display_name }).catch(
      (): { credits?: number; user_display_name?: string } => ({}),
    );
    state.credits_remaining = panel.credits;
    if (!state.user_display_name) state.user_display_name = panel.user_display_name;
    if (!state.user_display_name) {
      state.user_display_name = pickNameFromAccountLines(await readAccountButtonLines(page));
    }
    state.composer = await settingsTrigger(page).innerText().then((t) => t.replace(/\s+/g, " ").trim(), () => undefined);
  }
  return state;
}

// Menus close on Escape; the account panel does not and needs its own close button.
async function dismissOverlays(page: Page): Promise<void> {
  await leaveSideMenu(page);
  await page.keyboard.press("Escape");
  const closePanel = page.getByRole("button", { name: "Close account panel" });
  if (await closePanel.isVisible().catch(() => false)) await closePanel.click({ timeout: 5000 }).catch(() => {});
  await clearBackdrops(page);
}

// Some of Flow's menus ignore Escape (the agent's model menu did, 2026-10-13), and the invisible backdrop behind an
// open menu ("cdk-overlay-backdrop settings-menu-backdrop") then swallows every click on the page: that is how an agent
// batch failed with "Could not switch Agent mode on". Clicking the backdrop is how such a menu closes, picking nothing.
async function clearBackdrops(page: Page): Promise<void> {
  const showing = page.locator(".cdk-overlay-backdrop.cdk-overlay-backdrop-showing");
  for (let i = 0; i < 4 && (await showing.count().catch(() => 0)); i++) {
    await showing.last().click({ force: true, timeout: 4000 }).catch(() => {});
    await pause(page, 500);
  }
}

async function waitNoBackdrop(page: Page, timeoutMs = 12_000): Promise<void> {
  const showing = page.locator(".cdk-overlay-backdrop.cdk-overlay-backdrop-showing");
  const gone = await showing
    .first()
    .waitFor({ state: "hidden", timeout: timeoutMs })
    .then(() => true, () => false);
  if (gone) return;
  await dismissOverlays(page);
  if (await showing.count().catch(() => 0)) {
    throw new Error("Flow still has a menu overlay open (.cdk-overlay-backdrop-showing). Close it by hand, then retry.");
  }
}

// Ingredients / frame picker (Asset list + search). If it stays open while a prompt is typed, keystrokes land in search.
async function assetPickerOpen(page: Page): Promise<boolean> {
  const list = page.getByRole("listbox", { name: "Asset list" });
  if (await list.isVisible().catch(() => false)) return true;
  const shell = page.locator(".cdk-overlay-pane").filter({
    has: page.getByRole("tab", { name: "All", exact: true }),
  });
  return shell.first().isVisible().catch(() => false);
}

async function waitAssetPickerClosed(page: Page, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await assetPickerOpen(page))) {
      await pause(page, 350);
      if (!(await assetPickerOpen(page))) return;
    }
    await page.keyboard.press("Escape").catch(() => {});
    await clearBackdrops(page);
    await pause(page, 450);
  }
  throw new Error("Flow's asset picker stayed open. Close All media by hand, then retry.");
}

function composerEditor(page: Page): Locator {
  return page.locator("flow-base-prompt-box .ProseMirror").first();
}

/** Attach opens Flow's All media picker on purpose; typing must not. Close every overlay before the prompt step. */
async function sealComposerAfterAttach(page: Page): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await page.keyboard.press("Escape").catch(() => {});
    await dismissOverlays(page);
    await waitNoBackdrop(page).catch(() => {});
    try {
      await waitAssetPickerClosed(page, 8000);
    } catch {
      /* one more round */
    }
    if (!(await assetPickerOpen(page))) {
      await pause(page, 700);
      if (!(await assetPickerOpen(page))) return;
    }
    await pause(page, 500);
  }
  if (await assetPickerOpen(page)) {
    throw new Error(
      "Flow's asset picker is still open after attaching references. It should close before the prompt is typed — close All media in the Flow window and retry.",
    );
  }
}

async function composerHasReference(page: Page, hint: { name: string; thumb?: string }): Promise<boolean> {
  const box = page.locator("flow-base-prompt-box");
  const chips = box.getByRole("button", { name: "Ingredient" });
  const count = await chips.count().catch(() => 0);
  const token = thumbToken(hint.thumb);
  for (let i = 0; i < count; i++) {
    const chip = chips.nth(i);
    const text = (await chip.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
    if (optionIsExactMedia(text, hint.name) || optionHasNamePrefix(text, hint.name)) return true;
    if (token) {
      const src = await chip.locator("img").first().getAttribute("src").catch(() => "");
      if (src && src.includes(token)) return true;
    }
  }
  return false;
}

// The agent's own image model, set to the newest Nano Banana like single images. Best effort: a batch never fails over it.
async function pickAgentImageModel(page: Page): Promise<void> {
  const button = page.locator("flow-agent-panel").getByRole("button", { name: "Image generation default model" });
  if (!(await button.isVisible().catch(() => false))) return;
  await button.click({ timeout: 5000 }).catch(() => {});
  const items = page.getByRole("menuitem");
  if (!(await items.first().isVisible().catch(() => false))) await items.first().waitFor({ state: "visible", timeout: 4000 }).catch(() => {});
  const names = (await items.allInnerTexts().catch(() => [] as string[])).map((t) => t.replace(/\s+/g, " ").trim());
  const index = newestNanoBanana(names);
  const shown = (await button.innerText().catch(() => "")).replace(/\s+/g, " ");
  if (index >= 0 && !shown.includes(names[index])) await items.nth(index).click({ timeout: 4000 }).catch(() => {});
  else await page.keyboard.press("Escape");
  await pause(page, 400);
  await clearBackdrops(page);
}

// The agent settings panel replaces the composer, hiding the Agent button; Back closes it without saving.
async function closeAgentSettings(page: Page): Promise<void> {
  const back = page.locator("flow-agent-panel").getByRole("button", { name: "Back", exact: true });
  if (await back.isVisible().catch(() => false)) {
    await clearBackdrops(page);
    await back.click({ timeout: 5000 }).catch(() => {});
    await pause(page, 800);
  }
}

async function readUserNameFromPanelDom(page: Page): Promise<string | undefined> {
  const panel = page.locator("flow-account-panel");
  const heading = parseDisplayName(await panel.getByRole("heading").first().innerText().catch(() => undefined));
  if (heading) return heading;
  return page
    .evaluate(() => {
      const panel =
        document.querySelector("flow-account-panel") ??
        document.querySelector("[class*='account-panel'], [class*='accountPanel']");
      if (!panel) return null;
      const skip =
        /sign out|credit|google flow|ultra|pro|premium|manage|switch account|@|^close$|^google$|upgrade|watermark|privacy|terms|license|recaptcha|create avatar|resets?\s|connecting/i;
      const score = (t: string) => {
        if (t.length < 2 || t.length > 80 || skip.test(t) || /^\d[\d,.\s]*$/.test(t)) return -100;
        if (/^[A-Z][\p{L}'-]+(\s+[A-Z][\p{L}'-]+)+$/u.test(t)) return 30;
        if (t.split(/\s+/).length >= 2) return 12;
        return 1;
      };
      let best: { t: string; s: number } | null = null;
      for (const el of panel.querySelectorAll("h1,h2,h3,strong,b,span,div,p")) {
        if (el.children.length > 4) continue;
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        const s = score(t);
        if (s > (best?.s ?? -100)) best = { t, s };
      }
      return best && best.s > 0 ? best.t : null;
    })
    .then((t) => parseDisplayName(t ?? undefined))
    .catch(() => undefined);
}

/** Credits link often paints before the display name; poll only when the header button had no name yet. */
async function readAccountUserName(page: Page, maxMs = 4000): Promise<string | undefined> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const name = await readUserNameFromPanelDom(page);
    if (name) return name;
    await pause(page, 250);
  }
  return undefined;
}

/** Read balance from the account panel only when it is already open — never clicks Account details. */
async function readAccountPanelIfOpen(
  page: Page,
  opts: { needName?: boolean } = {},
): Promise<{ credits?: number; user_display_name?: string }> {
  const needName = opts.needName !== false;
  const link = page.getByRole("link", { name: /Google Flow credits/ });
  const panelOpen = await link.isVisible().catch(() => false);
  if (!panelOpen) {
    return { credits: undefined, user_display_name: undefined };
  }
  let credits: number | undefined;
  try {
    const n = Number((await link.innerText()).replace(/[^\d]/g, ""));
    credits = Number.isNaN(n) ? undefined : n;
  } catch {
    credits = undefined;
  }
  const user_display_name = needName ? await readAccountUserName(page) : undefined;
  return { credits, user_display_name };
}

async function readCredits(page: Page): Promise<number | undefined> {
  const out = await readAccountPanelIfOpen(page, { needName: false });
  return out.credits;
}

/** Opens the account panel once, reads the balance, closes it — for pre-merge refresh only. */
export async function refreshFlowCreditsOnce(): Promise<number | undefined> {
  const state = await getFlowState(false);
  if (!state.signedIn || !state.inProject) return undefined;
  const page = await getFlowPage();
  const open = await readAccountPanelIfOpen(page, { needName: false });
  if (open.credits !== undefined) {
    await dismissOverlays(page).catch(() => undefined);
    return open.credits;
  }
  await dismissOverlays(page);
  await scrollToTop(page);
  try {
    await page.getByRole("button", { name: "Account details" }).click({ timeout: 5000 });
    await page
      .locator("flow-account-panel, [class*='account-panel']")
      .first()
      .waitFor({ state: "attached", timeout: 8000 })
      .catch(() => undefined);
    const link = page.getByRole("link", { name: /Google Flow credits/ });
    await link.waitFor({ state: "visible", timeout: 8000 });
    const n = Number((await link.innerText()).replace(/[^\d]/g, ""));
    const credits = Number.isNaN(n) ? undefined : n;
    await dismissOverlays(page);
    await pause(page, 300);
    return credits;
  } catch {
    await dismissOverlays(page).catch(() => undefined);
    return undefined;
  }
}

export function displayNameForHeader(name: string | undefined): string {
  if (!name) return "User";
  return firstName(name) || "User";
}

const settingsTrigger = (page: Page) => page.getByRole("button", { name: "Settings trigger" });

// Every finished tile carries its media id in data-media-id; some thumbnails also have it in the URL, but Flow
// serves signed /asb/ links with no uuid, so the attribute comes first and the URL is only a fallback.
// Video tiles at rest expose neither, and their signed thumbnail URL is re-signed over time - using it as a handle
// made old tiles look new. Titles are stable, so an id-less tile is identified by its title instead.
const TILE_ID_JS = `(tile) => {
  if (tile.querySelector("flow-collection-tile")) return undefined;
  const media = tile.querySelector("img[data-media-id], video[data-media-id], img[src], video[src]");
  const id = media && (media.getAttribute("data-media-id") || media.getAttribute("src")?.match(/[0-9a-f]{8}-[0-9a-f-]{27}/)?.[0]);
  if (id) return id;
  const title = tile.getAttribute("aria-label");
  return title ? "title:" + title : undefined;
}`;

export async function mediaIds(page: Page): Promise<string[]> {
  return page.evaluate(
    (js) => [...document.querySelectorAll("flow-grid-tile-container")].map(eval(js)).filter(Boolean) as string[],
    TILE_ID_JS,
  );
}

// The grid is virtualised and the top bar hides once it is scrolled, so every step starts from the top,
// where new tiles appear.
async function scrollToTop(page: Page): Promise<void> {
  await page.evaluate(() => document.querySelectorAll(".page-container").forEach((e) => (e.scrollTop = 0)));
  await pause(page, 400);
}

// Titles survive re-scans; the signed thumbnail URL used as a fallback handle does not (Flow re-signs it), so
// anything that has to find the same tile again should go through here.
const tileOf = (page: Page, asset: FlowAsset) =>
  asset.name
    ? page.locator(`flow-grid-tile-container[aria-label="${asset.name.replace(/"/g, '\\"')}"]`).first()
    : mediaTile(page, asset.id!);

const mediaTile = (page: Page, id: string) =>
  page
    .locator(
      id.startsWith("title:")
        ? `flow-grid-tile-container[aria-label="${id.slice(6).replace(/"/g, '\\"')}"]`
        : `flow-grid-tile-container:has([data-media-id="${id}"]), flow-grid-tile-container:has([src*="${id}"])`,
    )
    .first();

// A failed generation becomes a <flow-error-tile> ("Failed ... You have not been charged") with Flow's own Retry
// button. Old failures can sit anywhere in the grid, so only error tiles above the first already-known tile count.
export async function newErrorTiles(page: Page, known: Iterable<string>): Promise<number> {
  return page.evaluate(([ids, js]: [string[], string]) => {
    const seen = new Set(ids);
    let errors = 0;
    for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
      const id = (eval(js) as (t: Element) => string | undefined)(tile);
      if (id && seen.has(id)) break;
      if (tile.querySelector("flow-error-tile")) errors++;
    }
    return errors;
  }, [[...known], TILE_ID_JS] as [string[], string]);
}

// Flow says WHY on the tile (".error-message-text"): a busy server, or a policy refusal such as "This prompt might
// violate our policies about generating prominent people". The second never succeeds on retry, so it must not be
// retried and the user must see Flow's own words, not a generic "failed".
async function errorReason(page: Page): Promise<string> {
  return page
    .locator("flow-grid-tile-container flow-error-tile")
    .first()
    .evaluate((el) => ((el.querySelector(".error-message-text") as HTMLElement | null)?.innerText || (el as HTMLElement).innerText).replace(/\s+/g, " ").trim())
    .catch(() => "");
}
const POLICY =
  /polic|violat|prominent|safety|not allowed|guideline|reputational|misrepresent|current events|unusual activity|help center for more information/i;

function policyHint(reason: string): string {
  if (/unusual activity|browser extensions|help center/i.test(reason)) {
    return " Flow thinks this browser session looks unusual (often CDP automation or an extension). Close other tools attached to the same Chrome profile, turn off extensions on the Flow profile, wait a few minutes, try one clip manually in flow.google.com, then retry. Retrying the same prompt immediately usually fails again.";
  }
  if (/reputational|misrepresent|current event|news/i.test(reason)) {
    return ' Reframe as clearly fictional comedy or fantasy (e.g. "staged satire", "impossible weather for a comedy sketch") — avoid "breaking news", "news report", "live TV bulletin", or anything that looks like real current events. Retrying the same wording will not help.';
  }
  if (/prominent|public figure|celebrit/i.test(reason)) {
    return " Flow thinks a face looks like a real, well-known person, usually from an uploaded photo. Retrying will not change that: use flow_character with `describe` instead of a photo, or soften the scene.";
  }
  return " Retrying the same prompt will not change that.";
}

// Flow's Retry replaces the failed tile with a fresh render of the same prompt and settings, free of charge.
// Tiles produced by Agent mode only offer Delete, so the button may not be there at all.
async function retryErrorTile(page: Page, tile: Locator): Promise<boolean> {
  await hoverTile(page, tile);
  const retry = tile.getByRole("button", { name: "Retry" });
  if (!(await retry.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  await retry.click({ timeout: 10_000 });
  await pause(page, 1500);
  await scrollToTop(page);
  return true;
}

// Big batches put more new tiles in the grid than Flow renders at once, so this walks down from the top, pressing
// Retry on every failed tile it meets, until it reaches a tile that existed before the job (or the end of the grid).
// Agent-mode failures offer no Retry button; the walk then stops and reports what it counted.
export async function retryNewErrorTiles(
  page: Page,
  known: Iterable<string>,
  dryRun = false,
): Promise<{ errors: number; reachedKnown: boolean; retried: number }> {
  const ids = [...known];
  let errors = 0;
  let retried = 0;
  let reachedKnown = false;
  let retryable = true;
  for (let pass = 0; pass < 80; pass++) {
    await scrollToTop(page);
    let found = false;
    for (let step = 0; step < 60 && !found && !reachedKnown; step++) {
      const state = await page.evaluate(([known, js]: [string[], string]) => {
        const seen = new Set(known);
        for (const tile of document.querySelectorAll("flow-grid-tile-container")) {
          const id = (eval(js) as (t: Element) => string | undefined)(tile);
          const name = tile.getAttribute("aria-label");
          if ((id && seen.has(id)) || (name && seen.has(name))) return "known";
          if (tile.querySelector("flow-error-tile")) return "error";
        }
        return "none";
      }, [ids, TILE_ID_JS] as [string[], string]);
      if (state === "known") reachedKnown = true;
      else if (state === "error") {
        found = true;
        errors++;
        if (dryRun) break;
        retryable = await retryErrorTile(page, page.locator("flow-grid-tile-container:has(flow-error-tile)").first());
        if (!retryable) break;
        retried++;
      } else {
        const moved = await page.evaluate(() => {
          const el = document.querySelector(".page-container");
          if (!el) return false;
          const top = el.scrollTop;
          el.scrollTop = top + el.clientHeight * 0.8;
          return el.scrollTop > top;
        });
        if (!moved) reachedKnown = true;
        await pause(page, 400);
      }
    }
    // A successful Retry reshuffles the grid (the new render jumps to the top), so the walk starts again.
    if (!found || dryRun || !retryable) break;
  }
  await scrollToTop(page);
  return { errors, reachedKnown, retried };
}

type MediaKind = "image" | "video";

// New tiles that can be the result we are waiting for. Three things looked "new" here without being it (2026-10-09:
// 31 finished clips reported failed with "tile menu has no Download item. It offered: Delete"):
// - our OWN uploads (first/last frames, references - always named fm-<job>-...): an upload's tile shows up while it is
//   still processing and only gets its final id a moment later, after the "before" snapshot, so it read as new;
// - a tile of the wrong kind, such as the still that "Save frame" makes on the way to a continuation clip;
// - a tile still rendering ("NN%").
export async function freshMedia(page: Page, before: string[], kind?: MediaKind): Promise<string[]> {
  const tiles = await page.evaluate(
    (js) => {
      const idOf = eval(js) as (t: Element) => string | undefined;
      return [...document.querySelectorAll("flow-grid-tile-container")].map((t) => ({
        id: idOf(t),
        kind: t.querySelector("flow-video-tile") ? "video" : t.querySelector("flow-image-tile") ? "image" : "other",
        label: t.getAttribute("aria-label") ?? "",
        // For the first seconds after Start generation, before any "NN%" shows, a new video tile is titled with the
        // prompt itself and has no thumbnail; then it takes a short title of Flow's own and counts up; finished, it
        // has its thumbnail (watched live 2026-10-16, a 4 s clip: prompt title at 9 s, "0%" at 12 s, 100% at 34 s,
        // thumbnail at 35 s). The old test - no "NN%" means done - took the tile in those first seconds and lost a
        // user's clip. A video without its thumbnail counts as busy.
        busy:
          /\d+%/.test((t as HTMLElement).innerText) ||
          (!!t.querySelector("flow-video-tile") && !t.querySelector('img[alt="Generated video thumbnail"], video')),
      }));
    },
    TILE_ID_JS,
  );
  const ours = tiles.filter((t) => t.id && !before.includes(t.id) && !t.label.startsWith("fm-") && !t.busy && (!kind || t.kind === kind));
  return [...new Set(ours.map((t) => t.id!))];
}

async function waitForNewMedia(page: Page, before: string[], count: number, timeoutMs: number, job?: Job, kind?: MediaKind): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let retriesLeft = job?.params.retries ?? 1;
  let failures = 0;
  let seen = "";
  while (Date.now() < deadline) {
    await pause(page, 2000);
    const fresh = await freshMedia(page, before, kind);
    // New tiles are listed first, so anything beyond the requested count is not ours.
    if (fresh.length >= count) {
      const picked = fresh.slice(0, count);
      // A video has no media id and is tracked by its title, which Flow may still change right after finishing: take
      // it only once the same titles show twice running, or the download looks for a name that no longer exists.
      const settled = !picked.some((id) => id.startsWith("title:")) || picked.join("|") === seen;
      if (settled) return picked;
      seen = picked.join("|");
      if (job) job.progress = "Flow is finishing the video";
      continue;
    }
    const progress = await page.evaluate(() =>
      [...document.querySelectorAll("flow-grid-tile-container")].slice(0, 8).map((t) => (t as HTMLElement).innerText.match(/\d+%/)?.[0]).filter(Boolean),
    );
    if (job) job.progress = progress.join(", ") || undefined;
    const errors = progress.length ? 0 : await newErrorTiles(page, before);
    if (!errors) continue;
    failures += errors;
    const reason = await errorReason(page);
    if (POLICY.test(reason)) {
      throw new Error(`Flow refused this generation on policy grounds: "${reason}" Nothing was charged.${policyHint(reason)}`);
    }
    if (retriesLeft > 0) {
      retriesLeft--;
      if (job) job.progress = "Flow failed, retrying";
      const retried = await retryErrorTile(page, page.locator("flow-grid-tile-container:has(flow-error-tile)").first());
      if (retried) continue;
    }
    if (fresh.length) return fresh;
    throw new Error(`Flow failed this generation ${failures} time(s) ("${reason || "Sorry, this image/video failed to generate"}"). Nothing was charged. Try again later or reword the prompt.`);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Flow to finish.`);
}

async function mediaStillRendering(page: Page, ids: string[]): Promise<boolean> {
  if (!ids.length) return false;
  return page.evaluate(
    ({ needle, js }) => {
      const tiles = [...document.querySelectorAll("flow-grid-tile-container")];
      const resolve = eval(js) as (t: Element) => string | undefined;
      for (const id of needle) {
        const match = id.startsWith("title:") ? id.slice(6) : id;
        const tile = tiles.find((el) => resolve(el) === id || (el.getAttribute("aria-label") ?? "") === match);
        if (!tile) continue;
        if (/\d+%/.test((tile as HTMLElement).innerText)) return true;
      }
      return false;
    },
    { needle: ids, js: TILE_ID_JS },
  );
}

/** Returns as soon as Flow shows progress on new tiles, or when they already finished. */
async function waitForPipelineHandoff(
  page: Page,
  before: string[],
  count: number,
  job: Job,
  timeoutMs: number,
): Promise<{ done: boolean; ids: string[] }> {
  const deadline = Date.now() + Math.min(timeoutMs, 180_000);
  let seen = "";
  while (Date.now() < deadline) {
    await pause(page, 1200);
    const fresh = await freshMedia(page, before, "video");
    const progress = await page.evaluate(() =>
      [...document.querySelectorAll("flow-grid-tile-container")]
        .slice(0, 8)
        .map((t) => (t as HTMLElement).innerText.match(/\d+%/)?.[0])
        .filter(Boolean),
    );
    if (job) job.progress = progress.join(", ") || undefined;
    if (fresh.length < count) continue;
    const picked = fresh.slice(0, count);
    const rendering = await mediaStillRendering(page, picked);
    const settled = !picked.some((id) => id.startsWith("title:")) || picked.join("|") === seen;
    if (!rendering && settled) return { done: true, ids: picked };
    seen = picked.join("|");
    if (rendering || fresh.length >= count) return { done: false, ids: picked };
  }
  throw new Error(`Timed out after ${Math.round(Math.min(timeoutMs, 180_000) / 1000)}s waiting for Flow to start rendering.`);
}

function filmClipTitleLocked(name: string, hint?: string): boolean {
  if (!name?.trim()) return false;
  const batch = hint?.match(/^(\d{4})-\d/)?.[1];
  if (batch) return new RegExp(`^${batch}-\\d+(-v\\d+)?$`).test(name.trim());
  return /^\d{4}-\d+(-v\d+)?$/.test(name.trim());
}

function tileHandle(asset: FlowAsset): string {
  return asset.id ?? (asset.name ? `title:${asset.name}` : "");
}

/** Flow retitles clips while they render; pipeline must find the finished tile on the grid before rename. */
async function resolvePipelineTileIds(page: Page, job: Job): Promise<string[]> {
  const variants = job.params.variants ?? 1;
  const want = flowTileRenameTitle(job.params, job.params.file_stem, 0, variants);
  const hint = job.params.flow_title;
  await ensureProjectGrid(page);
  await dismissOverlays(page);
  await showAllMedia(page);
  await scrollToTop(page);
  await pause(page, 500);

  let grid = await scanGrid(page);
  const already = grid.filter((a) => a.kind === "video" && a.name === want);
  if (already.length >= variants) return already.slice(0, variants).map(tileHandle).filter(Boolean);

  const before = job.pipelineBefore ?? [];
  let fresh = await freshMedia(page, before, "video");
  const unmounted = fresh.length < variants;
  if (unmounted) {
    await scanGrid(page, (seen) => fresh.every((id) => seen.some((a) => a.id === id || (id.startsWith("title:") && a.name === id.slice(6)))));
    fresh = await freshMedia(page, before, "video");
    grid = await scanGrid(page);
  }

  const picks: string[] = [];
  for (const id of [...fresh].reverse()) {
    const name = id.startsWith("title:") ? id.slice(6) : grid.find((a) => a.id === id)?.name ?? "";
    if (name && !filmClipTitleLocked(name, hint)) picks.push(id);
    if (picks.length >= variants) break;
  }
  if (picks.length >= variants) return picks.slice(0, variants);

  for (const id of job.pipelineMedia ?? []) {
    if (picks.includes(id)) continue;
    const loc = await tileLocator(page, id, grid);
    if (loc) picks.push(id);
    if (picks.length >= variants) break;
  }

  if (fresh.length >= variants) return fresh.slice(-variants);
  return picks.length ? picks : fresh;
}

async function tileLocator(page: Page, id: string, grid?: FlowAsset[]): Promise<Locator | null> {
  const loc = mediaTile(page, id);
  if (await loc.count().catch(() => 0)) return loc;
  const name = id.startsWith("title:") ? id.slice(6) : grid?.find((a) => a.id === id)?.name;
  if (!name) return null;
  await scanGrid(page, (seen) => seen.some((a) => a.name === name)).catch(() => undefined);
  const hit = page.locator(`flow-grid-tile-container[aria-label="${name.replace(/"/g, '\\"')}"]`).first();
  return (await hit.count().catch(() => 0)) ? hit : null;
}

async function waitForPipelineSettled(page: Page, ids: string[], job: Job, timeoutMs: number): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  let seen = "";
  while (Date.now() < deadline) {
    await pause(page, 2000);
    if (await mediaStillRendering(page, ids)) {
      job.progress = "Rendering on Flow…";
      continue;
    }
    const settled = !ids.some((id) => id.startsWith("title:")) || ids.join("|") === seen;
    if (settled) return ids;
    seen = ids.join("|");
    job.progress = "Flow is finishing the video";
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for Flow to finish rendering.`);
}

async function saveGeneratedTiles(page: Page, job: Job, fresh: string[]): Promise<string[]> {
  const s = job.params;
  mkdirSync(s.output_dir, { recursive: true });
  const files: string[] = [];
  await ensureProjectGrid(page);
  await scrollToTop(page);
  const grid = await scanGrid(page);
  for (const [i, id] of fresh.entries()) {
    const label = fresh.length > 1 ? `${s.file_stem}-v${i + 1}` : s.file_stem;
    const newTitle = flowTileRenameTitle(s, label, i, fresh.length);
    const tile = (await tileLocator(page, id, grid)) ?? mediaTile(page, id);
    await tile.scrollIntoViewIfNeeded().catch(() => {});
    let renamed = await renameTile(page, tile, newTitle).catch(() => false);
    if (!renamed) {
      const again = await tileLocator(page, id, await scanGrid(page));
      if (again) renamed = await renameTile(page, again, newTitle).catch(() => false);
    }
    if (renamed) job.note = [job.note, `renamed in Flow to ${newTitle}`].filter(Boolean).join(" · ");
    else job.note = [job.note, `rename to ${newTitle} failed — could not find the clip on the grid`].filter(Boolean).join(" · ");
    await pause(page, 800);
    const stem = join(s.output_dir, label);
    const handle = renamed ? `title:${newTitle}` : id;
    const flowProjectId = projectIdFromUrl(page.url());
    const title = renamed ? newTitle : id.startsWith("title:") ? id.slice(6) : newTitle;
    if (s.skip_download) {
      job.flow_assets ??= [];
      job.flow_assets.push({ id: handle, title, project_id: flowProjectId });
      job.note = [job.note, `saved in Flow as ${title} (no local download)`].filter(Boolean).join(" · ");
      await pause(page, 600);
      continue;
    }
    files.push(...(await downloadMedia(page, handle, stem, s.download_quality)));
    await pause(page, 1500);
  }
  return files;
}

/** Rename Flow clips that still carry auto titles so merge can find 0002-3, 0002-4, … */
export async function repairMissingFilmTitles(project: string, clips: { flow_title: string }[]): Promise<string[]> {
  if (!/^\d{4}$/.test(project.trim())) return [];
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  const fixed: string[] = [];
  let grid = await scanGrid(page);
  for (const { flow_title } of clips) {
    const want = flow_title.trim();
    if (!want || grid.some((a) => a.name === want)) continue;
    const unrenamed = grid.filter((a) => a.kind === "video" && !filmClipTitleLocked(a.name, want));
    if (!unrenamed.length) continue;
    const victim = unrenamed[unrenamed.length - 1];
    const loc = await tileLocator(page, tileHandle(victim), grid);
    if (!loc) continue;
    if (await renameTile(page, loc, want).catch(() => false)) {
      fixed.push(want);
      grid = await scanGrid(page);
    }
  }
  return fixed;
}

export async function finalizePipelineGeneration(job: Job): Promise<string[]> {
  if (!job.pipelineMedia?.length) throw new Error("Nothing left to finish on Flow for this job.");
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  await scrollToTop(page);
  await waitForPipelineSettled(page, job.pipelineMedia, job, VIDEO_TIMEOUT_MS);
  const resolved = await resolvePipelineTileIds(page, job);
  job.progress = undefined;
  job.flow_assets = [];
  return saveGeneratedTiles(page, job, resolved.length ? resolved : job.pipelineMedia);
}

async function openSettings(page: Page): Promise<void> {
  const probe = page.getByRole("radio", { name: "Image", exact: true });
  for (let attempt = 0; attempt < 3; attempt++) {
    if (await probe.isVisible().catch(() => false)) return;
    await settingsTrigger(page).click();
    await probe.waitFor({ state: "visible", timeout: 3000 }).catch(() => {});
  }
  if (!(await probe.isVisible().catch(() => false))) throw new Error("Could not open Flow's generation settings popover.");
}

async function pickRadio(page: Page, name: string | RegExp): Promise<void> {
  const radio = page.getByRole("radio", { name, exact: typeof name === "string" }).first();
  // The Escape that closes the model menu when no model change is needed can close the whole settings popover with
  // it (a brand-new project already on the newest Nano Banana: "Flow has no "x2" option"), so reopen it and look again.
  if (!(await radio.isVisible().catch(() => false))) await openSettings(page).catch(() => undefined);
  if (!(await radio.isVisible().catch(() => false))) {
    throw new Error(`Flow has no "${name}" option for the current mode/model.`);
  }
  if (!(await radio.isChecked())) {
    await radio.click();
    await pause(page, 500);
  }
}

// Image jobs use the newest Nano Banana unless another model is named (the user's call, 2026-10-13: "should always
// default to latest"). The menu then held Nano Banana Pro, 2 Lite and 2.1 - the plain "Nano Banana 2" was gone, and
// asking for it by name picked whichever came first. The newest is the highest version number that is not a Lite model,
// read from Flow's own menu, so a later 2.2 or 3 is picked with no code change.
export const LATEST_IMAGE_MODEL = "latest";
const LEGACY_IMAGE_MODEL = /^\s*(nano banana( 2)?|latest)?\s*$/i;
export function newestNanoBanana(names: string[]): number {
  const version = (n: string) => /nano banana\s+(\d+(?:\.\d+)*)/i.exec(n)?.[1]?.split(".").map(Number);
  let best = -1;
  names.forEach((n, i) => {
    const v = version(n);
    if (!v || /\blite\b/i.test(n)) return;
    const b = best < 0 ? undefined : version(names[best])!;
    const newer = !b || v.some((x, k) => x !== (b[k] ?? 0) && v.slice(0, k).every((y, j) => y === (b[j] ?? 0)) && x > (b[k] ?? 0));
    if (newer) best = i;
  });
  return best;
}

async function pickModel(page: Page, model: string): Promise<void> {
  const button = page.getByRole("button", { name: "Select model family" });
  const latest = model === LATEST_IMAGE_MODEL;
  if (!latest && (await button.innerText()).toLowerCase().includes(model.toLowerCase())) return;
  await button.click();
  const items = page.getByRole("menuitem");
  await items.first().waitFor({ state: "visible", timeout: 5000 });
  const names = (await items.allInnerTexts()).map((t) => t.replace(/\s+/g, " ").trim());
  const index = latest ? newestNanoBanana(names) : names.findIndex((n) => n.toLowerCase().includes(model.toLowerCase()));
  const shown = (await button.innerText()).replace(/\s+/g, " ");
  if (index < 0 || (latest && shown.includes(names[index]))) {
    // Nothing to change (already the newest, or no numbered Nano Banana here at all): close the menu, pick nothing.
    await page.keyboard.press("Escape");
    await clearBackdrops(page);
    if (index < 0 && !latest) throw new Error(`Model "${model}" not found. Available here: ${names.join(", ")}`);
    return;
  }
  await items.nth(index).click();
  await pause(page, 700);
}

// Applies the scene settings and returns the credit cost Flow quotes for them.
// One Escape does not always shut the settings popover (2026-10-30: it stayed open after a run and its credit label
// swallowed the next click on the prompt box, so flow_character timed out). Check it is gone, and try again.
async function closeSettings(page: Page): Promise<void> {
  const popover = page.locator(".cdk-overlay-pane:has(.credit-cost-label)");
  for (let i = 0; i < 3; i++) {
    if (!(await popover.count())) return;
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    await page.keyboard.press("Escape");
    await pause(page, 400);
  }
  if (await popover.count()) await page.getByRole("button", { name: "Settings trigger" }).click({ timeout: 5000 }).catch(() => undefined);
}

async function applySettings(page: Page, job: Job): Promise<number> {
  const s = job.params;
  const framesMode = Boolean(s.first_frame || s.last_frame);
  await openSettings(page);
  await pickRadio(page, s.type === "image" ? "Image" : "Video");
  if (s.type === "video") await pickRadio(page, framesMode ? "Frames" : "Ingredients");
  if (s.aspect_ratio) await pickRadio(page, s.aspect_ratio);
  const model = s.type === "image" && LEGACY_IMAGE_MODEL.test(s.model ?? "") ? LATEST_IMAGE_MODEL : s.model;
  if (model) await pickModel(page, model);
  if (s.type === "video" && s.resolution) await pickRadio(page, new RegExp(`^${s.resolution}`));
  if (s.type === "video" && s.duration) await pickRadio(page, `${s.duration}s`);
  await pickRadio(page, `x${s.variants ?? 1}`);
  await pause(page, 600);
  // The quote is "<N> credits". Low balances add an "Add AI credits" banner link that the old /credits?$/ also matched.
  const costText = await page.getByRole("link", { name: /^\d[\d,]*\s+credits?$/ }).first().innerText();
  const cost = Number(costText.match(/\d+/)?.[0] ?? NaN);
  await closeSettings(page);
  if (Number.isNaN(cost)) throw new Error(`Could not read the credit cost from Flow ("${costText}").`);
  return cost;
}

const ASSET_PREFIX = "asset:";

// Waits for THIS upload by its own name until Flow has finished processing it (its picture carries a media id), so
// a half-processed upload can never be taken for the next generation's result.
async function waitForUpload(page: Page, name: string, timeoutMs: number): Promise<void> {
  const tile = page.locator(`flow-grid-tile-container[aria-label="${name.replace(/"/g, '\\"')}"]:has([data-media-id])`);
  await tile
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs })
    .catch(() => {
      throw new Error(`Flow did not finish processing the upload "${name}" within ${Math.round(timeoutMs / 1000)}s.`);
    });
  await pause(page, 1000);
}

// Uploads under a unique filename so the asset can be picked unambiguously afterwards.
// "asset:<name>" refers to something already in the Flow project (image, video, character) and skips the upload.
async function uploadAsset(page: Page, job: Job, file: string, label: string): Promise<string> {
  if (file.startsWith("flowref:")) {
    const parsed = parseStoredRef(file);
    if (parsed?.kind === "flow") return parsed.pick.assetName;
  }
  if (file.startsWith(ASSET_PREFIX)) return file.slice(ASSET_PREFIX.length).trim();
  if (!existsSync(file)) throw new Error(`File not found: ${file}`);
  const name = `fm-${job.id}-${label}${extname(file).toLowerCase()}`;
  const staged = join(mkdtempSync(join(tmpdir(), "flow-mcp-")), name);
  copyFileSync(file, staged);
  await scrollToTop(page);
  await page.getByRole("button", { name: "Add media menu" }).click();
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
  await page.getByRole("menuitem", { name: "Upload", exact: true }).click();
  await (await chooser).setFiles(staged);
  await waitForUpload(page, name, 90_000);
  return name;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Options read "<name>", "<name> Image|Video|Avatar" or "<voice> <description>", so match on the leading name.
const optionByName = (list: Locator, name: string) =>
  list.getByRole("option", { name: new RegExp(`^${escapeRe(name)}`, "i") }).first();

// The signed /asb/<token> path is stable for the few seconds between a grid scan and the picker.
// It is not stored as the asset id. Picker options have no data-media-id (verified 2026-11-19).
const thumbToken = (src?: string) => src?.match(/\/asb\/([^/=?#]+)/)?.[1] ?? "";

export type GridMatch = { name: string; assetId?: string; thumbnail?: string; byId: boolean; ambiguousName: boolean; onGrid: boolean };

// Resolves a stored reference against assets already scanned from the OPEN project. Does not touch the picker.
export function matchProjectAsset(assets: FlowAsset[], stored: string, openProjectId?: string): GridMatch {
  const parsed = parseStoredRef(stored);
  if (!parsed || parsed.kind === "file") throw new Error(`Not a Flow asset reference: ${stored}`);
  const wantedName = parsed.kind === "flow" ? parsed.pick.assetName : parsed.name;
  const wantedId = parsed.kind === "flow" ? parsed.pick.assetId : undefined;
  if (parsed.kind === "flow" && parsed.pick.projectId && openProjectId && parsed.pick.projectId !== openProjectId) {
    throw new Error(
      `Asset "${wantedName}" belongs to project ${parsed.pick.projectId}, but the open Flow project is ${openProjectId}. It was not attached.`,
    );
  }
  if (wantedId && isMediaId(wantedId)) {
    const hit = assets.find((a) => a.id === wantedId);
    if (!hit) {
      const sameName = assets.filter((a) => a.name.toLowerCase() === wantedName.toLowerCase());
      if (sameName.length) {
        throw new Error(
          `Asset id mismatch: "${wantedName}" in this project is ${sameName.map((a) => a.id || "no id").join(", ")}, not ${wantedId}. The other file was not attached.`,
        );
      }
      throw new Error(`Asset "${wantedName}" (${wantedId}) is not in the open project. It may have been deleted or moved to Trash. Nothing was attached.`);
    }
    const twins = assets.filter((a) => a.id !== hit.id && a.name.toLowerCase() === hit.name.toLowerCase());
    return { name: hit.name, assetId: hit.id, thumbnail: hit.thumbnail, byId: true, ambiguousName: twins.length > 0, onGrid: true };
  }
  const exact = assets.filter((a) => a.name.toLowerCase() === wantedName.toLowerCase());
  if (exact.length > 1) {
    throw new Error(
      `Duplicate filenames: ${exact.length} assets in this project are called "${wantedName}". Nothing was attached. Rename one in Flow, then pick it again in TedVerse so it is stored by id.`,
    );
  }
  if (exact.length === 1) {
    return { name: exact[0].name, assetId: isMediaId(exact[0].id) ? exact[0].id : undefined, thumbnail: exact[0].thumbnail, byId: false, ambiguousName: false, onGrid: true };
  }
  return { name: wantedName, byId: false, ambiguousName: false, onGrid: false };
}

type PickerRow = { name: string; thumb: string };

async function pickerRows(list: Locator): Promise<PickerRow[]> {
  return list.evaluate((el) =>
    [...el.querySelectorAll('[role="option"]')].map((o) => ({
      name: (o.getAttribute("aria-label") || (o as HTMLElement).innerText || "").replace(/\s+/g, " ").trim(),
      thumb: o.querySelector("img")?.getAttribute("src") || "",
    })),
  );
}

// The Asset list is a CDK virtual scroll (the listbox element itself). Options that exist in the project
// are not in the DOM until scrolled into view — a name lookup times out even when the file is there.
async function scrollAssetList(page: Page, list: Locator, visit: (rows: PickerRow[]) => boolean): Promise<void> {
  await list.evaluate((el) => {
    (el as HTMLElement).scrollTop = 0;
  });
  await pause(page, 250);
  let lastTop = -1;
  for (let step = 0; step < 80; step++) {
    if (visit(await pickerRows(list))) return;
    const top = await list.evaluate((el) => {
      const node = el as HTMLElement;
      const before = node.scrollTop;
      node.scrollTop = before + Math.max(120, node.clientHeight * 0.75);
      return node.scrollTop > before + 1 ? node.scrollTop : -1;
    });
    if (top < 0 || top === lastTop) return;
    lastTop = top;
    await pause(page, 180);
  }
}

async function finishAttach(page: Page, list: Locator): Promise<void> {
  const add = page.getByRole("button", { name: "Add to prompt", exact: true });
  if (await add.waitFor({ state: "visible", timeout: 1500 }).then(() => true, () => false)) await add.click().catch(() => {});
  await list.waitFor({ state: "hidden", timeout: 10_000 });
  await pause(page, 500);
  await waitAssetPickerClosed(page).catch(() => {});
}

// The frame pickers attach on click; the ingredients picker only previews and needs "Add to prompt".
// Option names are "<asset name>" or "<asset name> Image|Video". The list is virtual, so it is scrolled.
// exact: require the whole media name (no prefix collision). thumb: the grid tile's current /asb token, used
// only when several rows share that name so a different file is never clicked.
export async function attachAsset(page: Page, opener: Locator, assetName: string, hint?: { exact?: boolean; thumb?: string; assetId?: string; character?: boolean }): Promise<void> {
  const name = assetName.trim();
  if (!name) throw new Error("attachAsset was called with an empty asset name; nothing was generated.");
  if (await composerHasReference(page, { name, thumb: hint?.thumb })) {
    await dismissOverlays(page);
    await waitNoBackdrop(page).catch(() => {});
    return;
  }
  const list = page.getByRole("listbox", { name: "Asset list" });
  const all = page.getByRole("tab", { name: "All", exact: true });
  const shows = (l: Locator, ms: number) => l.waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);
  // Twice on 2026-10-09 (a character, then an uploaded still) the click on the opener produced no picker at all, and
  // the job died waiting for it. It never reproduced when replayed, so it was something transient in the way - most
  // likely the upload menu still closing. Like the settings popover, the picker gets three tries, with Escape in
  // between to clear whatever caught the click. The Start/End frame pickers have no tabs, hence list OR All tab.
  let opened = false;
  for (let attempt = 0; attempt < 3 && !opened; attempt++) {
    if (attempt) {
      await page.keyboard.press("Escape");
      await pause(page, 800);
    }
    await opener.click();
    opened = await Promise.race([shows(list, 5000), shows(all, 5000)]);
  }
  if (!opened) throw new Error(`Flow's media picker did not open (three tries) while attaching "${name}". Nothing was generated.`);
  // The picker reopens on whichever tab was used last (Characters, after a character), so start from All each time.
  if ((await all.isVisible().catch(() => false)) && (await all.getAttribute("aria-selected")) !== "true") {
    await all.click();
    await pause(page, 1000);
  }
  await list.waitFor({ state: "visible", timeout: 10_000 });

  const token = thumbToken(hint?.thumb);
  const tabs = hint?.exact ? ["Images", "Videos", "Uploads"] : ["Voices", "Characters", "Avatars", "Uploads", "Images", "Videos"];
  const findOnCurrentTab = async (): Promise<"clicked" | "duplicate" | "miss"> => {
    if (token) {
      let saw = false;
      await scrollAssetList(page, list, (rows) => {
        if (rows.some((r) => thumbToken(r.thumb) === token)) {
          saw = true;
          return true;
        }
        return false;
      });
      if (saw) {
        const opt = list.locator(`[role="option"]:has(img[src*="${token}"])`);
        const n = await opt.count();
        if (n !== 1) {
          throw new Error(`Asset "${name}" (${hint?.assetId ?? token}) matched ${n} picker rows by thumbnail. Nothing was attached.`);
        }
        await opt.click();
        return "clicked";
      }
    }
    if (hint?.exact) {
      const keys = new Set<string>();
      await scrollAssetList(page, list, (rows) => {
        for (const row of rows) {
          if (!optionIsExactMedia(row.name, name)) continue;
          keys.add(thumbToken(row.thumb) || row.name.toLowerCase());
        }
        return false;
      });
      if (keys.size > 1) return "duplicate";
      if (keys.size === 0) return "miss";
      let ready = false;
      await scrollAssetList(page, list, (rows) => {
        if (rows.some((r) => optionIsExactMedia(r.name, name))) {
          ready = true;
          return true;
        }
        return false;
      });
      if (!ready) return "miss";
      await list.getByRole("option", { name: new RegExp(`^${escapeRe(name)}(?:\\s+(?:Image|Video|Avatar))?$`, "i") }).first().click();
      return "clicked";
    }
    let ready = false;
    await scrollAssetList(page, list, (rows) => {
      if (rows.some((r) => optionHasNamePrefix(r.name, name))) {
        ready = true;
        return true;
      }
      return false;
    });
    if (!ready) return "miss";
    await optionByName(list, name).click();
    return "clicked";
  };

  let result = await findOnCurrentTab();
  if (result === "miss" && hint?.character) {
    const t = page.getByRole("tab", { name: "Characters", exact: true });
    if (await t.isVisible().catch(() => false)) {
      await t.click();
      await pause(page, 800);
      result = await findOnCurrentTab();
    }
  }
  if (result === "miss") {
    for (const tab of tabs) {
      const t = page.getByRole("tab", { name: tab, exact: true });
      if (!(await t.isVisible().catch(() => false))) continue;
      await t.click();
      await pause(page, 800);
      result = await findOnCurrentTab();
      if (result !== "miss") break;
    }
  }
  if (result === "duplicate") {
    const idBit = hint?.assetId ? ` (${hint.assetId})` : "";
    throw new Error(`Reference ${name}${idBit} could not be attached: duplicate picker rows share that name. Rename one in Flow.`);
  }
  if (result !== "clicked") {
    const idBit = hint?.assetId ? ` (${hint.assetId})` : "";
    throw new Error(`Reference ${name}${idBit} could not be attached. It is not in this Flow project.`);
  }
  await finishAttach(page, list);
  await page.keyboard.press("Escape").catch(() => {});
  await dismissOverlays(page);
  await waitNoBackdrop(page);
  await waitAssetPickerClosed(page);
}

/** One line for the composer. @ opens Flow's asset-mention UI — references are already chips on the box. */
function composerPromptLine(prompt: string): string {
  const oneLine = prompt.replace(/\s*\n+\s*/g, " ").trim();
  return oneLine.replace(/@/g, "");
}

async function pasteComposerPrompt(page: Page, editor: Locator, line: string): Promise<void> {
  await waitAssetPickerClosed(page);
  await editor.click({ timeout: 8000 });
  await editor.press("ControlOrMeta+a");
  await editor.press("Backspace");
  await pause(page, 200);
  // Single paste: no per-keystroke triggers (especially @), and no mid-document cursor jumps on overlay dismiss.
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text);
  }, line);
  await editor.press("ControlOrMeta+v");
  await pause(page, 600);
  if (await assetPickerOpen(page)) {
    await page.keyboard.press("Escape").catch(() => {});
    await dismissOverlays(page);
    await waitAssetPickerClosed(page);
  }
}

async function typePrompt(page: Page, prompt: string): Promise<void> {
  const line = composerPromptLine(prompt);
  const editor = composerEditor(page);
  await sealComposerAfterAttach(page);
  if (await assetPickerOpen(page)) {
    throw new Error("Flow's asset picker is still open. Close All media in the Flow window and retry.");
  }
  await editor.waitFor({ state: "visible", timeout: 15_000 });
  await scrollToTop(page).catch(() => {});

  await pasteComposerPrompt(page, editor, line);
  let got = (await editor.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  const head = line.slice(0, Math.min(48, line.length));
  const bad = line.length > 40 && (got.length < line.length * 0.7 || (head.length >= 16 && !got.includes(head.slice(0, 16))));
  if (bad) {
    await dismissOverlays(page);
    await waitAssetPickerClosed(page);
    await pasteComposerPrompt(page, editor, line);
    got = (await editor.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  }
  if (await assetPickerOpen(page)) {
    throw new Error("Flow opened the asset picker while entering the prompt. Generation stopped so the prompt is not scrambled.");
  }
  const head2 = line.slice(0, Math.min(32, line.length));
  if (head2.length >= 12 && !got.includes(head2.slice(0, 12))) {
    throw new Error("The prompt did not land in Flow's composer (picker or focus stole input). Clear the prompt and retry.");
  }
  await pause(page, 300);
}

export type DownloadQuality = "original" | "upscaled";

export async function downloadMedia(page: Page, mediaId: string, targetStem: string, quality: DownloadQuality = "original"): Promise<string[]> {
  // A tile that has just finished rendering is still settling and the grid re-renders around it, so give it a moment.
  await scrollToTop(page);
  await pause(page, 2500);
  const tile = mediaTile(page, mediaId);
  await tile.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
    throw new Error(
      `The finished file is in Flow but could not be found again in the grid${mediaId.startsWith("title:") ? ` (looked for "${mediaId.slice(6)}")` : ""}. ` +
        `Nothing is lost: flow_download fetches it by its title without spending credits again.`,
    );
  });
  // Grab the title NOW, while the id still resolves, so the download can re-find this exact tile later even if the
  // virtualised grid unmounts and remounts it between steps.
  const title = (await tile.getAttribute("aria-label").catch(() => null)) ?? undefined;
  return downloadTile(page, tileByIdOrTitle(page, mediaId, title), targetStem, quality);
}

type TileResolver = () => Promise<Locator>;

// Re-finds the tile on every attempt instead of trusting one handle that may have been unmounted by the virtual grid:
// by id first, then by title. NOT a confirmed root cause for the post-generation download failures - the failure has
// never reproduced on a settled tile - but it removes one whole class of staleness, and the menu dump below is what
// will actually explain the next one. An empty "Untitled Scene" placeholder holds no media and its menu has no
// Download, so :has([src]) makes sure we never grab one by title.
function tileByIdOrTitle(page: Page, id: string, title?: string): TileResolver {
  return async () => {
    const byId = mediaTile(page, id);
    if (await byId.count()) return byId;
    if (title) {
      const byTitle = page.locator(`flow-grid-tile-container[aria-label="${title.replace(/"/g, '\\"')}"]:has([src])`).first();
      if (await byTitle.count()) return byTitle;
    }
    throw new Error(
      `The finished tile is no longer in the grid${title ? ` ("${title}")` : ""}. The media is still in Flow: flow_download fetches it without spending credits again.`,
    );
  };
}

// Flow reveals a tile's controls on a genuine pointer move, so the mouse is driven to the tile itself.
async function hoverTile(page: Page, tile: Locator, settleMs = 900): Promise<void> {
  await tile.scrollIntoViewIfNeeded();
  const box = await tile.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await pause(page, settleMs);
  } else {
    await tile.hover();
    await pause(page, settleMs);
  }
}

function extensionOf(file: string): string {
  return sniffMediaFile(file).ext;
}

// ---- Collections: the whole batch in ONE download (mapped live 2026-11-07, the user's idea) ----------------------
// Left menu "Library" -> `Create collection` adds an entry to list "Collections" with a textbox "Rename item".
// Cmd+click (Ctrl elsewhere - not checked on a PC) selects grid tiles (an inner ".selected"); dragging one of them
// with the key still held drops the whole selection on a collection entry. That MOVES the images out of All media
// into the collection, which also shows in the grid as a <flow-collection-tile>. In the collection's own view
// (/project/<id>/collection/<uuid>) the top bar's `More options` has `Download collection`: one ZIP of the originals,
// each named "<title with _>_<first 8 characters of its media id>.jpg". 1 image came down in 1.2 s.
const SELECT_KEY = process.platform === "darwin" ? "Meta" : "Control";

export class CollectionError extends Error {}

const collectionEntry = (page: Page, name: string) =>
  page.getByRole("list", { name: "Collections" }).getByRole("button", { name, exact: true });

async function ensureCollection(page: Page, name: string): Promise<Locator> {
  const entry = collectionEntry(page, name);
  if (await entry.isVisible().catch(() => false)) return entry;
  if (await entry.count().catch(() => 0)) {
    // It exists but the Library section is folded away.
    await page.getByRole("button", { name: "Toggle library" }).click({ timeout: 4000 }).catch(() => {});
    await leaveSideMenu(page);
    await pause(page, 600);
    if (await entry.isVisible().catch(() => false)) return entry;
  }
  const create = page.getByRole("button", { name: "Create collection" });
  if (!(await create.isVisible().catch(() => false)))
    throw new CollectionError('Flow\'s left-hand menu shows no "Create collection" button, so the images could not be gathered into one download.');
  await create.click({ timeout: 5000 });
  const box = page.getByRole("textbox", { name: "Rename item" }).first();
  await box.waitFor({ state: "visible", timeout: 8000 }).catch(() => {
    throw new CollectionError("Flow made a collection but offered no name box for it.");
  });
  await box.fill(name);
  await box.press("Enter");
  await leaveSideMenu(page);
  await pause(page, 1000);
  if (!(await entry.isVisible().catch(() => false))) throw new CollectionError(`The new collection "${name}" does not show in Flow's left-hand menu.`);
  return entry;
}

const isSelected = (tile: Locator) => tile.locator(".selected").count().then((n) => n > 0, () => false);

async function selectClick(page: Page, tile: Locator): Promise<void> {
  await tile.scrollIntoViewIfNeeded().catch(() => {});
  const box = await tile.boundingBox();
  if (!box) return;
  // Upper middle of the tile: clear of the hover buttons in the corners and the title along the bottom.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.4);
  await pause(page, 120);
  await page.keyboard.down(SELECT_KEY);
  await page.mouse.down();
  await page.mouse.up();
  await page.keyboard.up(SELECT_KEY);
  await pause(page, 220);
}

// Selects exactly these tiles (anything selected before is let go first) and returns the last one selected, which is
// on screen and becomes the drag handle.
async function selectTiles(page: Page, ids: string[]): Promise<string | undefined> {
  for (const tile of await page.locator("flow-grid-tile-container:has(.selected)").all()) {
    const id = await tile.evaluate((t, js) => (eval(js) as (t: Element) => string | undefined)(t), TILE_ID_JS).catch(() => undefined);
    if (!id || !ids.includes(id)) await selectClick(page, tile);
  }
  await scrollToTop(page);
  const left = new Set(ids);
  let last: string | undefined;
  for (let step = 0; step < 200 && left.size; step++) {
    for (const id of [...left]) {
      const tile = mediaTile(page, id);
      if (!(await tile.count())) continue;
      if (!(await isSelected(tile))) await selectClick(page, tile);
      if (await isSelected(tile)) {
        left.delete(id);
        last = id;
      }
    }
    if (!left.size) break;
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".page-container");
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop > before;
    });
    if (!moved) break;
    await pause(page, 700);
  }
  // The handle has to be on screen for the drag.
  if (last) await mediaTile(page, last).scrollIntoViewIfNeeded().catch(() => {});
  return last;
}

async function dragSelectionTo(page: Page, handle: string, entry: Locator): Promise<void> {
  const tile = await mediaTile(page, handle).boundingBox();
  const target = await entry.boundingBox();
  if (!tile || !target) throw new CollectionError("The images or the collection were not on screen for the drag.");
  const x = tile.x + tile.width / 2;
  const y = tile.y + tile.height * 0.4;
  await page.mouse.move(x, y);
  await page.keyboard.down(SELECT_KEY);
  await page.mouse.down();
  await page.mouse.move(x + 8, y + 8, { steps: 4 });
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 20 });
  await pause(page, 500);
  await page.mouse.up();
  await page.keyboard.up(SELECT_KEY);
  await pause(page, 1500);
}

// Media ids inside the open collection view (small, but walked like the grid in case it is long).
async function idsInView(page: Page): Promise<Set<string>> {
  const ids = new Set<string>();
  await scrollToTop(page);
  for (let step = 0; step < 100; step++) {
    for (const id of await mediaIds(page)) ids.add(id);
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".page-container");
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop > before;
    });
    if (!moved) break;
    await pause(page, 600);
  }
  return ids;
}

async function openCollection(page: Page, name: string): Promise<void> {
  await ensureProjectGrid(page);
  const entry = await ensureCollection(page, name);
  await entry.click({ timeout: 5000 });
  await leaveSideMenu(page);
  await page.waitForURL(/\/collection\//, { timeout: 15_000 }).catch(() => {
    throw new CollectionError(`Flow did not open the collection "${name}".`);
  });
  await pause(page, 2500);
}

// In the collection's own view: top bar More options -> Download collection -> one ZIP.
async function downloadOpenCollection(page: Page, dir: string, timeoutMs: number): Promise<string> {
  await page.mouse.move(2, 2); // no tile toolbar may be showing: tiles have their own "More options"
  await scrollToTop(page);
  await pause(page, 600);
  const stem = join(dir, ".collection-dl");
  // The top bar's own button lives in <flow-more-options-menu>; every tile in the collection also carries a hidden
  // "More options", and .first() picked one of those once the collection held 20 (click timed out).
  await page.locator("flow-more-options-menu").getByRole("button", { name: "More options", exact: true }).first().click({ timeout: 8000 });
  const item = page.getByRole("menuitem", { name: "Download collection" });
  if (!(await item.waitFor({ state: "visible", timeout: 6000 }).then(() => true, () => false))) {
    await page.keyboard.press("Escape").catch(() => {});
    throw new CollectionError('The collection\'s menu has no "Download collection".');
  }
  const part = `${stem}.flowpart`;
  const dlPromise = page.waitForEvent("download", { timeout: timeoutMs });
  await item.click();
  const dl = await dlPromise.catch(() => {
    throw new CollectionError("Flow was asked for the collection's ZIP but no download started.");
  });
  const fail = await dl.failure();
  if (fail) throw new CollectionError(`Collection download failed: ${fail}`);
  await dl.saveAs(part);
  const sniff = sniffMediaFile(part);
  if (sniff.kind !== "zip") throw new CollectionError(`Flow's collection download was not a ZIP (${sniff.kind}).`);
  const zip = `${stem}.zip`;
  renameSync(part, zip);
  return zip;
}

// Unpacks a collection ZIP. With `wanted`, each image is saved as its stem (matched by the media id in its name);
// without, every image keeps its own name. Returns the saved files and the ids that were not in the ZIP.
function unpackCollection(zip: string, dir: string, wanted?: { id: string; stem: string }[]): { files: string[]; saved: Map<string, string> } {
  const work = mkdtempSync(join(tmpdir(), "flow-collection-"));
  try {
    const entries = extractZip(zip, work);
    const files: string[] = [];
    const saved = new Map<string, string>();
    if (!wanted) {
      mkdirSync(dir, { recursive: true });
      for (const p of entries) {
        const dest = join(dir, basename(p, extname(p)).replace(/[^\w.-]+/g, "_") + extensionOf(p));
        copyFileSync(p, dest);
        files.push(dest);
      }
      return { files, saved };
    }
    const byId = new Map<string, string>();
    for (const p of entries) {
      const tag = basename(p, extname(p)).match(/_([0-9a-f]{8})$/)?.[1];
      if (tag) byId.set(tag, p);
    }
    for (const w of wanted) {
      const p = byId.get(w.id.slice(0, 8));
      if (!p) continue;
      const dest = `${w.stem}${extensionOf(p)}`;
      copyFileSync(p, dest);
      files.push(dest);
      saved.set(w.id, dest);
    }
    return { files, saved };
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(zip, { force: true });
  }
}

// Moves these grid images into the collection `name` and fetches them all in one ZIP, each saved as its stem.
// Never falls back to another way of downloading (the user's rule: a failed step stops and says so): it throws a
// CollectionError naming where the images are.
export async function collectAndDownload(page: Page, job: Job | undefined, name: string, wanted: { id: string; stem: string }[]): Promise<Map<string, string>> {
  try {
    return await collectAndDownloadOnce(page, job, name, wanted);
  } catch (err) {
    // Any failure in here (a Playwright timeout included) is a download problem, never a reason to generate again.
    if (err instanceof CollectionError) throw err;
    await ensureProjectGrid(page).catch(() => {});
    throw new CollectionError(`Gathering the images into the collection "${name}" stopped: ${(err as Error).message.split("\n")[0]}`);
  }
}

async function collectAndDownloadOnce(page: Page, job: Job | undefined, name: string, wanted: { id: string; stem: string }[]): Promise<Map<string, string>> {
  const ids = wanted.map((w) => w.id);
  let inside = new Set<string>();
  // A collection made earlier in this batch may already hold some of them (they are no longer in All media then).
  await ensureProjectGrid(page);
  if (await collectionEntry(page, name).count().catch(() => 0)) {
    await openCollection(page, name);
    inside = await idsInView(page);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const todo = ids.filter((id) => !inside.has(id));
    if (!todo.length) break;
    await ensureProjectGrid(page);
    const entry = await ensureCollection(page, name);
    if (job) step(job, `selecting ${todo.length} image(s) for the collection`);
    const handle = await selectTiles(page, todo);
    if (!handle) throw new CollectionError(`None of the ${todo.length} image(s) could be selected in Flow's grid.`);
    if (job) step(job, `moving ${todo.length} image(s) into the collection "${name}"`);
    await dragSelectionTo(page, handle, entry);
    await openCollection(page, name);
    // the collection page lists images moved in during this visit only after a fresh load (same cause as the ZIP)
    await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
    await page.locator("flow-grid-tile-container").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    await pause(page, 2000);
    inside = await idsInView(page);
  }
  if (!page.url().includes("/collection/")) {
    await openCollection(page, name);
    inside = await idsInView(page);
  }
  const notMoved = ids.filter((id) => !inside.has(id));
  if (notMoved.length) {
    await ensureProjectGrid(page).catch(() => {});
    throw new CollectionError(
      `${notMoved.length} of ${ids.length} image(s) would not go into the collection "${name}"; they are still in All media. ` +
        `Nothing was downloaded one by one instead.`,
    );
  }
  // Flow builds the ZIP in the page from the images it has loaded, and one that has only just arrived can be left out
  // (2026-11-07: 1 of 2 missing, both there on the next try). So the ZIP is checked against the list and the
  // collection downloaded again for whatever is missing.
  // Which image becomes which file, written down first: if the download stops, downloadCollection can still name
  // every file after its scene instead of Flow's title.
  writeManifest(name, wanted);
  const saved = new Map<string, string>();
  let pending = wanted;
  const here = page.url();
  for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
    // The collection page only lists images moved in during this visit once it is loaded afresh: without a reload
    // its ZIP held 8 of 20 three times running; after one, all 20.
    if (attempt) await pause(page, attempt * 5000);
    await page.goto(inEnglish(here), { waitUntil: "domcontentloaded" });
    await page.locator("flow-grid-tile-container").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    await pause(page, 2500);
    if (job) step(job, `downloading the collection "${name}" as one ZIP${attempt ? ` (again, for ${pending.length} missing)` : ""}`);
    const zipDir = dirname(wanted[0]!.stem);
    const zip = await downloadOpenCollection(page, zipDir, 60_000 + ids.length * 3000);
    for (const [id, file] of unpackCollection(zip, "", pending).saved) saved.set(id, file);
    pending = pending.filter((w) => !saved.has(w.id));
  }
  await ensureProjectGrid(page).catch(() => {});
  if (pending.length)
    throw new CollectionError(`The collection "${name}" downloaded 4 times, but ${pending.length} of ${ids.length} image(s) were never in its ZIP.`);
  return saved;
}

const MANIFESTS = join(HOME_DIR, "collections");
const manifestFile = (name: string) => join(MANIFESTS, `${name.replace(/[^\w.-]+/g, "_")}.json`);

function writeManifest(name: string, wanted: { id: string; stem: string }[]): void {
  mkdirSync(MANIFESTS, { recursive: true });
  const old = existsSync(manifestFile(name)) ? (JSON.parse(readFileSync(manifestFile(name), "utf8")) as { id: string; stem: string }[]) : [];
  const merged = [...old.filter((o) => !wanted.some((w) => w.id === o.id)), ...wanted];
  writeFileSync(manifestFile(name), JSON.stringify(merged, null, 1));
}

// The whole collection in one ZIP. A collection made by an image batch is saved under the batch's scene names (its
// manifest says which image is which scene) in the batch's own folder; any other collection keeps Flow's titles in
// `dir`.
export async function downloadCollection(name: string, dir: string): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await openCollection(page, name);
  await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await pause(page, 3000);
  const zip = await downloadOpenCollection(page, dir, 300_000);
  const manifest = existsSync(manifestFile(name)) ? (JSON.parse(readFileSync(manifestFile(name), "utf8")) as { id: string; stem: string }[]) : undefined;
  const out = unpackCollection(zip, dir, manifest);
  await ensureProjectGrid(page).catch(() => {});
  return out.files;
}

// Flow titles clips itself and happily reuses a title: two takes of the same scene both came back as "Woman climbing
// granite wall", which makes a clip impossible to identify by name and cost real time tonight. Renaming each finished
// tile to our own scene name fixes it at the source - the user's suggestion, and the right one.
function flowTileRenameTitle(s: Job["params"], label: string, variantIndex: number, variantCount: number): string {
  const custom = s.flow_title?.trim();
  if (custom) return variantCount > 1 ? `${custom}-v${variantIndex + 1}` : custom;
  const m = label.match(/^scene-(\d+)$/i);
  if (m && s.skip_download) {
    const base = String(Number(m[1]));
    return variantCount > 1 ? `${base}-v${variantIndex + 1}` : base;
  }
  return `${basename(s.output_dir)}-${label}`;
}

async function renameTile(page: Page, tile: Locator, title: string): Promise<boolean> {
  try {
    await hoverTile(page, tile);
    const more = tile.getByRole("button", { name: "More options" });
    if (!(await more.isVisible({ timeout: 3000 }).catch(() => false))) return false;
    await more.click();
    const rename = page.getByRole("menuitem", { name: "Rename", exact: true });
    if (!(await rename.isVisible({ timeout: 4000 }).catch(() => false))) {
      await page.keyboard.press("Escape");
      return false;
    }
    await rename.click();
    await pause(page, 1200);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.type(title, { delay: 8 });
    await page.keyboard.press("Enter");
    await pause(page, 1500);
    return true;
  } catch {
    await page.keyboard.press("Escape").catch(() => {});
    return false;
  }
}

async function savePlaywrightDownload(
  dl: Download,
  part: string,
  targetStem: string,
  opts: { overwrite?: boolean; zipTakeCount?: number } = {},
): Promise<string[]> {
  const fail = await dl.failure();
  if (fail) throw new Error(`Download failed: ${fail}`);
  await dl.saveAs(part);
  return finalizeFlowDownload(part, targetStem, opts);
}

/** Playwright download event → magic-byte sniff → named, ffprobe-validated file(s) in the project folder. */
async function flowDownloadToStem(
  page: Page,
  startDownload: () => Promise<void>,
  targetStem: string,
  timeoutMs: number,
  opts: { overwrite?: boolean; zipTakeCount?: number } = {},
): Promise<string[]> {
  mkdirSync(dirname(targetStem), { recursive: true });
  const part = `${targetStem}.flowpart`;
  const dlPromise = page.waitForEvent("download", { timeout: timeoutMs });
  await startDownload();
  return savePlaywrightDownload(await dlPromise, part, targetStem, opts);
}

async function downloadTile(
  page: Page,
  target: Locator | TileResolver,
  targetStem: string,
  quality: DownloadQuality,
  opts: { overwrite?: boolean; zipTakeCount?: number } = {},
): Promise<string[]> {
  const resolve: TileResolver = typeof target === "function" ? target : async () => target;
  const timeout = quality === "upscaled" ? 600_000 : 180_000;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const tile = await resolve();
      await hoverTile(page, tile, 250);
      const more = tile.getByRole("button", { name: "More options" });
      if (await more.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) await more.click();
      else await tile.click({ button: "right" });
      const downloadMenu = page.getByRole("menuitem", { name: "Download", exact: true });
      if (!(await downloadMenu.isVisible({ timeout: 8000 }).catch(() => false))) {
        const items = await page.locator('[role="menuitem"]').evaluateAll((ms) => ms.map((m) => (m.textContent ?? "").replace(/\s+/g, " ").trim()));
        throw new Error(items.length ? `Flow's tile menu has no Download item. It offered: ${items.join(" | ")}` : "Flow's tile menu did not open.");
      }
      mkdirSync(dirname(targetStem), { recursive: true });
      const part = `${targetStem}.flowpart`;
      const dlPromise = page.waitForEvent("download", { timeout });
      await downloadMenu.click({ timeout: 10_000 });
      const original = page.getByRole("menuitem", { name: /original/i }).first();
      if (await original.waitFor({ state: "visible", timeout: 3000 }).then(() => true, () => false)) {
        const upscaled = page.locator('[role="menuitem"]:not([aria-disabled="true"]):not([disabled])').filter({ hasText: /upscaled/i }).first();
        const wanted = quality === "upscaled" && (await upscaled.isVisible().catch(() => false)) ? upscaled : original;
        await wanted.click();
      }
      const saved = await savePlaywrightDownload(await dlPromise, part, targetStem, opts);
      await page.keyboard.press("Escape");
      await scrollToTop(page);
      return saved;
    } catch (err) {
      lastError = err;
      await page.keyboard.press("Escape").catch(() => {});
      await pause(page, 2000);
    }
  }
  throw lastError;
}

// The left-hand "Project navigation" (All media, Images, Videos, Characters...). Its Collapse button (a setting Flow
// keeps for every project) turns it into a strip of icons with no labels, and getByText("Characters") then found
// nothing visible. Each item's text holds its icon name and its label whether or not the label shows, so it is found by
// label in both states. (Why the menu used to vanish altogether: see leaveSideMenu.)
async function clickProjectNav(page: Page, item: string): Promise<boolean> {
  const esc = escapeRe(item);
  const word = new RegExp(`\\b${esc}\\b`, "i");
  const nav = page.getByRole("navigation", { name: "Project navigation" });
  const scopes: Locator[] = [nav.locator("button, a").filter({ hasText: word })];
  if (await nav.isVisible().catch(() => false)) {
    scopes.push(nav.getByRole("button", { name: word }), nav.getByRole("link", { name: word }));
  }
  scopes.push(
    page.getByRole("button", { name: word }),
    page.getByRole("link", { name: word }),
    page.locator("mat-sidenav button, mat-sidenav a").filter({ hasText: word }),
  );
  for (const group of scopes) {
    const n = await group.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const button = group.nth(i);
      if (!(await button.isVisible().catch(() => false))) continue;
      await button.click({ timeout: 5000 });
      await leaveSideMenu(page);
      return true;
    }
  }
  return false;
}

// The left-hand menu is a Material drawer, and Escape shuts it whenever the keyboard focus is inside it. Clicking
// "All media" left the focus there, so the very next Escape (dismissOverlays runs before almost every step) shut the
// menu for the rest of the session: the user's menu vanished, "All media" was hidden from then on, and each later click
// on it waited out Playwright's 30 s default (traced with DEBUG=pw:api, 2026-10-13). Take the focus out first.
async function leaveSideMenu(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const focused = document.activeElement as HTMLElement | null;
      if (focused?.closest("mat-sidenav")) focused.blur();
    })
    .catch(() => {});
}
async function openProjectNav(page: Page, item: string): Promise<void> {
  await leaveCharacterEditor(page).catch(() => {});
  const projectRoot = page.url().match(/^https:\/\/[^/]+\/project\/[0-9a-f-]{36}/)?.[0];
  if (projectRoot && !page.url().startsWith(projectRoot + "?")) {
    const onGrid = new URL(page.url()).pathname === new URL(projectRoot).pathname;
    if (!onGrid) {
      await page.goto(inEnglish(projectRoot), { waitUntil: "domcontentloaded" });
      await pause(page, 2000);
    }
  }
  await scrollToTop(page).catch(() => {});
  if (await clickProjectNav(page, item)) return;
  // A page load shows the menu again in whatever state the user keeps it, and changes nothing about that choice.
  if (projectRoot) await page.goto(inEnglish(projectRoot), { waitUntil: "domcontentloaded" });
  else await page.goto(inEnglish(page.url()), { waitUntil: "domcontentloaded" });
  await pause(page, 3000);
  if (!(await clickProjectNav(page, item))) {
    throw new Error(
      `Flow's left-hand menu is not showing, so "${item}" could not be opened. Expand project navigation in the Flow window (or leave the character editor), then try again.`,
    );
  }
}

// All media: through the left-hand menu when it shows. When it does not (collapsed and scrolled away), the top bar's
// Filter menu does the same job: nothing ticked, newest first. `thorough` (the start of a job) checks that menu; a
// plain grid scan does not, so a hidden menu costs nothing.
async function showAllMedia(page: Page, thorough = false): Promise<void> {
  if (await clickProjectNav(page, "All media").catch(() => false)) return;
  const filter = page.getByRole("button", { name: "Filtering and sorting options" });
  if (!thorough || !(await filter.isVisible().catch(() => false))) return;
  await filter.click({ timeout: 5000 }).catch(() => {});
  await pause(page, 600);
  const menu = page.locator(".cdk-overlay-container");
  if (await menu.locator("input[type=checkbox]:checked").count().catch(() => 0)) {
    await page.getByRole("button", { name: "Clear all filters" }).click({ timeout: 4000 }).catch(() => {});
    await pause(page, 600);
  }
  // New tiles must come first: everything that finds a fresh result looks at the top of the grid.
  const newest = menu.locator("label", { hasText: /^\s*Newest\s*$/ }).locator("input[type=radio]");
  if ((await newest.count().catch(() => 0)) && !(await newest.first().isChecked().catch(() => true))) {
    await newest.first().click({ force: true, timeout: 4000 }).catch(() => {});
    await pause(page, 600);
  }
  await page.keyboard.press("Escape");
  await clearBackdrops(page);
}

async function ensureProjectGrid(page: Page): Promise<void> {
  await dismissOverlays(page);
  const root = page.url().match(/^https:\/\/[^/]+\/project\/[0-9a-f-]{36}/)?.[0];
  // Compared by path: an address ending in ?hl=en is already the grid.
  if (root && new URL(page.url()).pathname !== new URL(root).pathname) {
    await page.goto(inEnglish(root), { waitUntil: "domcontentloaded" });
    await pause(page, 2500);
  }
  await showAllMedia(page, true);
  await pause(page, 800);
  await scrollToTop(page);
}

function assetsSummary(s: Job["params"]): string {
  const bits: string[] = [];
  if (s.first_frame) bits.push(`first_frame=${mediaRefLabel(s.first_frame)}`);
  if (s.last_frame) bits.push(`last_frame=${mediaRefLabel(s.last_frame)}`);
  if (s.reference_images?.length) bits.push(`reference_images=[${s.reference_images.map(mediaRefLabel).join(", ")}]`);
  return bits.length ? bits.join(" · ") : "text-only (no frames or references)";
}

const openProjectId = (page: Page) => page.url().match(/\/project\/([0-9a-f-]{36})/i)?.[1];

// Turns a job reference into the picker name to click. Flow ids are checked against the open project's grid
// before anything is attached. A local file is uploaded under a unique fm- name.
type RefPlan = { name: string; exact: boolean; thumb?: string; assetId?: string; character?: boolean };

async function loadCharacterCatalog(cache: { characters?: FlowCharacter[] }): Promise<FlowCharacter[]> {
  if (!cache.characters) cache.characters = await listCharacters();
  return cache.characters;
}

async function materializeRef(
  page: Page,
  job: Job,
  file: string,
  label: string,
  uploadLabel: string,
  cache: { assets?: FlowAsset[]; characters?: FlowCharacter[] },
): Promise<RefPlan> {
  const parsed = parseStoredRef(file);
  if (!parsed) throw new Error(`Empty ${label}. Nothing was generated.`);
  if (parsed.kind === "file") {
    const name = await uploadAsset(page, job, file, uploadLabel);
    return { name, exact: true };
  }
  if (parsed.kind === "flow") {
    const wantedId = parsed.pick.assetId;
    if (parsed.pick.assetType === "character" && isMediaId(wantedId)) {
      const displayName = parsed.pick.assetName.trim();
      if (displayName) {
        console.error(`[flow-mcp ${job.id}] ${label} character id=${wantedId} name="${displayName}" (stored ref)`);
        return { name: displayName, exact: false, assetId: wantedId, character: true };
      }
    }
    const characters = await loadCharacterCatalog(cache);
    const asCharacter = parsed.pick.assetType === "character" || characters.some((c) => c.characterId === wantedId);
    if (asCharacter) {
      const hit = characters.find((c) => c.characterId === wantedId);
      if (!hit) {
        throw new Error(
          `Reference ${parsed.pick.assetName} (${wantedId}) could not be attached. That character id is not in the open Flow project.`,
        );
      }
      console.error(`[flow-mcp ${job.id}] ${label} character id=${hit.characterId} name="${hit.displayName}"`);
      return { name: hit.displayName, exact: false, assetId: hit.characterId, thumb: hit.thumbnail, character: true };
    }
  }
  if (!cache.assets) cache.assets = await scanGrid(page);
  const match = matchProjectAsset(cache.assets, file, openProjectId(page));
  if (match.byId && match.assetId) {
    const renamed = parsed.kind === "flow" && match.name !== parsed.pick.assetName;
    console.error(
      `[flow-mcp ${job.id}] ${label} resolved id=${match.assetId} name="${match.name}" project=${openProjectId(page) ?? "?"}${renamed ? ` (was "${parsed.pick.assetName}")` : ""}`,
    );
    if (renamed) job.note = [job.note, `${label} "${parsed.pick.assetName}" is now called "${match.name}"`].filter(Boolean).join(" · ");
    if (match.ambiguousName && !thumbToken(match.thumbnail)) {
      throw new Error(`Reference ${match.name} (${match.assetId}) could not be attached: duplicate filenames in the project grid.`);
    }
    return { name: match.name, exact: true, thumb: match.ambiguousName ? match.thumbnail : undefined, assetId: match.assetId };
  }
  if (match.onGrid && match.assetId) {
    console.error(`[flow-mcp ${job.id}] ${label} resolved by unique name "${match.name}" id=${match.assetId}`);
    return { name: match.name, exact: true, assetId: match.assetId, thumb: undefined };
  }
  if (parsed.kind === "flow" && isMediaId(parsed.pick.assetId)) {
    throw new Error(
      `Reference ${parsed.pick.assetName} (${parsed.pick.assetId}) could not be attached. That asset id is not in the open Flow project.`,
    );
  }
  if (parsed.kind === "name") {
    throw new Error(
      `Reference ${parsed.name} has no asset id. Pick it again in TedVerse so it is stored by id, not by name alone.`,
    );
  }
  throw new Error(`Reference ${label} could not be resolved in this project.`);
}

// Drives one generation in the Flow tab and returns the downloaded file paths.
export async function runGeneration(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;

  // Never invent media: only first_frame / last_frame / reference_images on this job are attached. Empty = text prompt only.
  const planned = assetsSummary(s);
  step(job, `assets: ${planned}`);
  console.error(`[flow-mcp ${job.id}] runGeneration assets: ${planned}`);

  await ensureProjectGrid(page);
  // Direct generation uses the composer as it stands. The Flow Agent toggle only switches that composer into a
  // conversational mode; it is not part of starting a video. If the toggle is absent, or present and off, leave it.
  await ensureDirectComposer(page);
  // Clear leftover chips from a previous take so a text-only job cannot keep an old ingredient.
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();

  job.credits = await applySettings(page, job);
  if (job.credits > s.max_credits) {
    throw new Error(
      `Flow quotes ${job.credits} credits for this scene, above max_credits=${s.max_credits}. Nothing was generated. Raise max_credits or pick a cheaper model/duration/variants.`,
    );
  }

  const mediaCache: { assets?: FlowAsset[] } = {};
  if (s.first_frame) {
    const planned = await materializeRef(page, job, s.first_frame, "first_frame", "start", mediaCache);
    step(job, `attaching first_frame ${planned.assetId ? `${planned.name} [${planned.assetId}]` : planned.name}`);
    await attachAsset(page, page.getByRole("button", { name: "Start", exact: true }), planned.name, {
      exact: planned.exact,
      thumb: planned.thumb,
      assetId: planned.assetId,
    });
  }
  if (s.last_frame) {
    const planned = await materializeRef(page, job, s.last_frame, "last_frame", "end", mediaCache);
    step(job, `attaching last_frame ${planned.assetId ? `${planned.name} [${planned.assetId}]` : planned.name}`);
    await attachAsset(page, page.getByRole("button", { name: "End", exact: true }), planned.name, {
      exact: planned.exact,
      thumb: planned.thumb,
      assetId: planned.assetId,
    });
  }
  // Flow's composer offers Frames OR Ingredients, never both: a clip with first/last frames cannot also carry
  // reference images. The frames already pin the look, so the references are dropped and the job says so.
  const framesMode = s.type === "video" && Boolean(s.first_frame || s.last_frame);
  if (framesMode && s.reference_images?.length) {
    job.note = [job.note, `first/last frames were set, so ${s.reference_images.length} reference image(s) were skipped — Flow allows one or the other.`]
      .filter(Boolean)
      .join(" · ");
    s.reference_images = [];
  }
  for (const [i, ref] of (s.reference_images ?? []).entries()) {
    const planned = await materializeRef(page, job, ref, `reference_${i + 1}`, `ref${i + 1}`, mediaCache);
    step(job, `attaching reference ${i + 1}/${s.reference_images!.length}: ${planned.assetId ? `${planned.name} [${planned.assetId}]` : planned.name}`);
    await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), planned.name, {
      exact: planned.exact,
      thumb: planned.thumb,
      assetId: planned.assetId,
      character: planned.character,
    });
  }
  const wanted = (s.reference_images ?? []).length;
  if (wanted) {
    const attached = await page.getByRole("button", { name: "Ingredient" }).count();
    if (attached < wanted) {
      throw new Error(
        `Only ${attached} of ${wanted} reference(s) show as ingredient chips in the composer. If Flow already showed the thumbnail, a leftover chip or a stuck overlay from the picker may have caused a false failure — try Clear prompt and run again.`,
      );
    }
  }

  await sealComposerAfterAttach(page);
  await typePrompt(page, s.prompt);
  await dismissOverlays(page);
  await waitNoBackdrop(page).catch(() => {});
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's Start generation button is disabled; the prompt or inputs were not accepted.");
  await scrollToTop(page);
  const before = await mediaIds(page);
  await start.click();

  const variants = s.variants ?? 1;
  const fresh = await waitForNewMedia(
    page,
    before,
    variants,
    s.type === "image" ? IMAGE_TIMEOUT_MS : VIDEO_TIMEOUT_MS,
    job,
    s.type === "image" ? "image" : "video",
  );
  job.progress = undefined;
  return saveGeneratedTiles(page, job, fresh);
}

export interface FlowAsset {
  name: string;
  kind: "image" | "video" | "scene";
  /** data-media-id when the tile has one. Videos at rest often only have "title:<name>". */
  id?: string;
  projectId?: string;
  /** Signed thumbnail URL from the grid. Not an identifier — Flow re-signs it. Used only to tell same-named picker rows apart in the same session. */
  thumbnail?: string;
}

// Walks the virtualised grid from the top and collects every tile it passes. Recycled tiles sometimes have no
// media id yet, so entries are keyed by title and the id is filled in from whichever pass saw it.
async function scanGrid(page: Page, stopAt?: (assets: FlowAsset[]) => boolean): Promise<FlowAsset[]> {
  await dismissOverlays(page);
  await showAllMedia(page);
  await pause(page, 600);
  await scrollToTop(page);
  const projectId = page.url().match(/\/project\/([0-9a-f-]{36})/i)?.[1];
  const seen = new Map<string, FlowAsset>();
  for (let step = 0; step < 200; step++) {
    const batch = await page.evaluate(
      (js) =>
        [...document.querySelectorAll("flow-grid-tile-container")].map((t) => ({
          name: t.getAttribute("aria-label") ?? "",
          // A scene (several clips on one timeline) is its own tile type; lumping it in with images made it look
          // like a still in the Library and download as a ZIP of loose clips.
          kind: t.querySelector("flow-scene-tile")
            ? ("scene" as const)
            : t.querySelector("flow-video-tile") || t.querySelector('img[alt="Generated video thumbnail"]')
              ? ("video" as const)
              : ("image" as const),
          id: (eval(js) as (t: Element) => string | undefined)(t),
          thumbnail: t.querySelector("img")?.getAttribute("src") || undefined,
          // A collection sits in the grid as a tile of its own (2026-11-07). It is not media, and its thumbnail
          // changes whenever something is added, so it would pass for a brand-new image.
          collection: !!t.querySelector("flow-collection-tile"),
        })),
      TILE_ID_JS,
    );
    for (const a of batch) {
      if (!a.name || a.collection) continue;
      // Same filename can be two assets. A real data-media-id keeps them apart; title-only videos still share a name.
      const key = isMediaId(a.id) ? a.id! : `name:${a.name}`;
      const known = seen.get(key);
      if (!known) seen.set(key, { name: a.name, kind: a.kind, id: a.id, projectId, thumbnail: a.thumbnail });
      else {
        if (!known.thumbnail && a.thumbnail) known.thumbnail = a.thumbnail;
        if (!isMediaId(known.id) && isMediaId(a.id)) known.id = a.id;
      }
    }
    if (stopAt?.([...seen.values()])) break;
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".page-container");
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop > before;
    });
    if (!moved) break;
    await pause(page, 700);
  }
  return [...seen.values()];
}

export interface FlowCharacter {
  characterId: string;
  displayName: string;
  projectId?: string;
  thumbnail?: string;
  voice: string | null;
}

async function scrapeCharacterTiles(page: Page): Promise<{ id: string; displayName: string; thumbnail?: string }[]> {
  return page.evaluate(() => {
    const ICON = /\b(favorite|more_vert|accessibility_new|person|movie|image|videocam|mic|star|share|arrow_forward|edit|delete|download)\b/gi;
    return [...document.querySelectorAll("flow-character-tile")]
      .map((tile) => {
        const href =
          tile.querySelector('a[href*="/character/"]')?.getAttribute("href") ||
          (tile instanceof HTMLAnchorElement ? tile.getAttribute("href") : "") ||
          "";
        const id = href.match(/\/character\/([0-9a-f-]{36})/i)?.[1] || tile.getAttribute("data-character-id") || "";
        const clone = tile.cloneNode(true) as HTMLElement;
        clone.querySelectorAll("mat-icon, .mat-icon").forEach((n) => n.remove());
        const displayName = (clone.textContent || "").replace(ICON, "").replace(/\s+/g, " ").trim();
        const thumbnail = tile.querySelector('img[alt="Character thumbnail"]')?.getAttribute("src") || undefined;
        return { id, displayName, thumbnail };
      })
      .filter((t) => t.displayName && !/^new character$/i.test(t.displayName));
  });
}

async function readAssignedVoice(page: Page): Promise<string | null> {
  if (await page.getByRole("button", { name: "Select a voice" }).isVisible().catch(() => false)) return null;
  return page.evaluate(() => {
    const buttons = [...document.querySelectorAll("button")];
    const play = buttons.find((b) => /^play\\b/i.test((b.textContent || "").trim()) || /play/i.test(b.getAttribute("aria-label") || ""));
    const remove = buttons.find((b) => /^remove\\b/i.test((b.textContent || "").trim()) || /remove/i.test(b.getAttribute("aria-label") || ""));
    if (!play || !remove) return null;
    let node: HTMLElement | null = play.parentElement;
    for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
      const text = (node.textContent || "").replace(/\\s+/g, " ").trim();
      const named = text.match(/\\b([A-Za-z][A-Za-z0-9_-]{1,40})\\s+Play\\s+Remove\\b/);
      if (named) return named[1]!;
    }
    const sib = play.previousElementSibling;
    const word = sib?.textContent?.trim().split(/\\s+/)[0];
    return word && /^[A-Za-z]/.test(word) ? word : null;
  });
}

async function openCharacterEditor(page: Page, projectRoot: string, characterId: string): Promise<void> {
  await page.goto(inEnglish(`${projectRoot}/character/${characterId}`), { waitUntil: "domcontentloaded" });
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 20_000 }).catch(() => {});
  await pause(page, 1500);
}

// Characters live in their own left-nav section. With none yet, Flow shows a template chooser instead, so only
// entries that actually carry a character thumbnail count.
export async function listCharacters(): Promise<FlowCharacter[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const projectRoot = page.url().match(/^https:\/\/[^/]+\/project\/[0-9a-f-]{36}/)?.[0];
  const projectId = openProjectId(page);
  await dismissOverlays(page);
  await openProjectNav(page, "Characters");
  await pause(page, 2500);
  let tiles = await scrapeCharacterTiles(page);
  for (const tile of tiles) {
    if (tile.id || !projectRoot) continue;
    const card = page.locator("flow-character-tile").filter({ hasText: tile.displayName }).first();
    if (!(await card.isVisible().catch(() => false))) continue;
    await card.click();
    tile.id = page.url().match(/\/character\/([0-9a-f-]{36})/)?.[1] || "";
    await leaveCharacterEditor(page);
    await openProjectNav(page, "Characters");
    await pause(page, 1200);
  }
  tiles = tiles.filter((t) => t.id && t.displayName);
  const out: FlowCharacter[] = [];
  for (const tile of tiles) {
    let voice: string | null = characterRecord(tile.displayName).voice?.trim() || null;
    if (projectRoot) {
      await openCharacterEditor(page, projectRoot, tile.id);
      voice = (await readAssignedVoice(page)) ?? voice;
      await leaveCharacterEditor(page);
      await openProjectNav(page, "Characters").catch(() => {});
      await pause(page, 400);
    }
    out.push({
      characterId: tile.id,
      displayName: tile.displayName,
      projectId,
      thumbnail: tile.thumbnail,
      voice,
    });
  }
  await ensureProjectGrid(page).catch(() => {});
  return out;
}

// Studio picker: same character list, no per-character editor for voice; retries until tiles show.
export async function listCharactersForPicker(): Promise<FlowCharacter[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const projectRoot = page.url().match(/^https:\/\/[^/]+\/project\/[0-9a-f-]{36}/)?.[0];
  const projectId = openProjectId(page);
  let out: FlowCharacter[] = [];
  for (let round = 0; round < 3; round++) {
    await dismissOverlays(page);
    await openProjectNav(page, "Characters");
    await pause(page, 2000 + round * 900);
    const tileLoc = page.locator("flow-character-tile");
    await tileLoc.first().waitFor({ state: "visible", timeout: 18_000 }).catch(() => {});
    await pause(page, 700);
    let tiles = await scrapeCharacterTiles(page);
    for (const tile of tiles) {
      if (tile.id || !projectRoot) continue;
      const card = page.locator("flow-character-tile").filter({ hasText: tile.displayName }).first();
      if (!(await card.isVisible().catch(() => false))) continue;
      await card.click();
      tile.id = page.url().match(/\/character\/([0-9a-f-]{36})/)?.[1] || "";
      await leaveCharacterEditor(page);
      await openProjectNav(page, "Characters");
      await pause(page, 1200);
    }
    tiles = tiles.filter((t) => t.id && t.displayName);
    out = tiles.map((tile) => ({
      characterId: tile.id,
      displayName: tile.displayName,
      projectId,
      thumbnail: tile.thumbnail,
      voice: characterRecord(tile.displayName).voice?.trim() || null,
    }));
    if (out.length) break;
  }
  await ensureProjectGrid(page).catch(() => {});
  return out;
}

// A run that stopped half-way leaves Flow inside a character's editor, where the project navigation is gone. Done keeps
// whatever is on screen - leaving any other way could drop a finished edit - and then the grid is put back.
async function leaveCharacterEditor(page: Page): Promise<void> {
  if (/\/character(\/|$)/.test(new URL(page.url()).pathname)) {
    await page.getByRole("button", { name: /^Done( editing)?$/ }).first().click({ timeout: 5000 }).catch(() => {});
    await page.waitForURL((u) => !/\/character/.test(u.pathname), { timeout: 10_000 }).catch(() => {});
  }
  await ensureProjectGrid(page).catch(() => {});
}

// The portrait's own toolbar (Download image, Delete image) sits invisible with pointer events off until a real pointer
// moves over the picture - the same rule as grid tiles - so a plain click lands on the image and times out. That, plus
// Playwright's download event, is why an edit that worked never reached disk (2026-10-02). Point at the picture, then
// download through the same watched folders as every other file.
async function savePortrait(page: Page, name: string): Promise<string> {
  const dir = join(process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out"), "_cast");
  mkdirSync(dir, { recursive: true });
  const picture = page.getByRole("img", { name: "Generated character image" }).first();
  const button = page.getByRole("button", { name: "Download image", exact: true });
  const stem = join(dir, name.replace(/[^\w.-]+/g, "_"));
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await hoverTile(page, picture);
      const saved = await flowDownloadToStem(
        page,
        () => button.click({ timeout: 4000 }),
        stem,
        90_000,
        { overwrite: true },
      );
      return saved[0]!;
    } catch (err) {
      last = err;
    }
  }
  throw last instanceof Error ? last : new Error("Flow never showed the portrait's Download image button");
}

// Opens an existing character and restyles its portrait in place (Nano Banana, free) instead of making a new one.
// Without a change it only saves the character's current portrait: for a look changed by hand in Flow, or an edit whose
// portrait never reached disk.
export async function editCharacter(name: string, change?: string, job?: Job): Promise<{ name: string; portrait?: string; note?: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await leaveCharacterEditor(page);
  await dismissOverlays(page);
  await openProjectNav(page, "Characters");
  await pause(page, 2500);

  const card = page.locator("flow-character-tile").filter({ hasText: name }).first();
  if (!(await card.isVisible().catch(() => false))) throw new Error(`No character called "${name}". Use flow_characters to list them.`);
  await card.scrollIntoViewIfNeeded();
  await card.click();
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 20_000 });
  await pause(page, 2000);

  if (change) {
    const portraitImg = page.getByRole("img", { name: "Generated character image" }).first();
    const before = await portraitImg.getAttribute("src").catch(() => null);

    const box = page.locator(".ProseMirror").last();
    await box.click();
    await page.keyboard.press("ControlOrMeta+a");
    // Delete leaves a full selection standing in this editor; Backspace clears it (mapped 2026-10-02).
    await page.keyboard.press("Backspace");
    // The character editor always draws a wide 16:9 picture (1376x768), whatever shape the portrait was. Told only "make
    // his coat red", it filled the frame with three Pips side by side (2026-10-02), so every edit pins a single figure.
    const told = `${change.replace(/\s*\n+\s*/g, " ").trim().replace(/[.\s]*$/, ".")} Exactly one ${name} in the picture: never add copies of ${name} or extra poses side by side.`;
    await page.keyboard.type(told, { delay: 8 });
    await pause(page, 600);
    const start = page.getByRole("button", { name: "Start generation" });
    if (!(await start.isEnabled())) throw new Error("Flow did not accept the change (Start generation stayed disabled).");
    await start.click();

    const deadline = Date.now() + 4 * 60_000;
    for (;;) {
      await pause(page, 3000);
      const now = await portraitImg.getAttribute("src").catch(() => null);
      const pct = (await page.locator("main").first().innerText()).match(/\d+%/)?.[0];
      if (job) job.progress = pct;
      if (now && now !== before && !pct) break;
      if (Date.now() > deadline) throw new Error("Timed out waiting for Flow to redraw the character.");
    }
    if (job) job.progress = undefined;
  }

  // From here on the edit is done in Flow. A failed download must never throw that away, so it becomes a note instead.
  let portrait: string | undefined;
  let note: string | undefined;
  try {
    portrait = await savePortrait(page, name);
  } catch (err) {
    note = `${change ? `${name} was changed in Flow, but the new` : "The"} portrait could not be saved (${err instanceof Error ? err.message : String(err)}). Call flow_character_edit with just the name to save it.`;
  }

  await leaveCharacterEditor(page);
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  return { name, portrait, note };
}

export async function listAssets(): Promise<FlowAsset[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  // From a scene, clip or character view the grid is not on screen, and the scan found nothing at all (2026-10-12:
  // a scene open in Flow listed as "no scenes"). Go back to the project's All media first.
  await ensureProjectGrid(page);
  const assets = await scanGrid(page);
  await scrollToTop(page);
  return assets;
}

// Studio's From Flow picker: after Characters, the virtual grid often needs an extra settle before scanGrid sees tiles.
export async function listAssetsForPicker(): Promise<FlowAsset[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  let assets: FlowAsset[] = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    await ensureProjectGrid(page);
    if (attempt > 0) await pause(page, 1000 + attempt * 600);
    assets = await scanGrid(page);
    await scrollToTop(page);
    if (assets.length) break;
  }
  return assets;
}

// Downloads media that already exists in the project, matched by (the start of) its title.
export async function downloadAsset(
  name: string,
  targetStem: string,
  quality: DownloadQuality,
  opts: { overwrite?: boolean } = {},
): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  const matches = (a: FlowAsset) => a.name.toLowerCase().startsWith(name.toLowerCase());
  const found = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!found) throw new Error(`No asset whose title starts with "${name}". Use flow_assets to list titles.`);
  if (found.kind === "scene") return downloadScene(page, found, targetStem, opts);
  return downloadTile(page, tileOf(page, found), targetStem, quality, opts);
}

// Moves one item in the open project to Flow's Trash. Flow keeps it there with Restore and Delete permanently, so this
// is recoverable - and it never deletes permanently. Flow asks NO confirmation (mapped 2026-10-01: the tile menu's
// "Move to trash" removes the tile at once), so whoever calls this must confirm with the user first. Matching is by
// EXACT title, and an ambiguous title is refused: Flow reuses titles, and trashing the wrong one is the worst outcome.
// How many tiles carry this exact title. scanGrid keeps one entry per title (the virtual grid shows the same tile again
// as it scrolls), so it can never see two items with the same name: trashAsset's "two share it" guard never fired,
// and Flow's agent reuses titles freely (three "Red fox sitting in snow" in one test, 2026-10-18). Images are told apart
// by their media ids; id-less videos only when two of them are on screen together.
async function countTitled(page: Page, name: string): Promise<number> {
  await scrollToTop(page);
  const ids = new Set<string>();
  let together = 0;
  for (let step = 0; step < 200; step++) {
    const found = await page.evaluate(
      ([js, title]) => {
        const idOf = eval(js) as (t: Element) => string | undefined;
        return [...document.querySelectorAll("flow-grid-tile-container")].filter((t) => t.getAttribute("aria-label") === title).map((t) => idOf(t) ?? "");
      },
      [TILE_ID_JS, name] as const,
    );
    together = Math.max(together, found.length);
    for (const id of found) if (id && !id.startsWith("title:")) ids.add(id);
    const moved = await page.evaluate(() => {
      const el = document.querySelector(".page-container");
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollTop = before + el.clientHeight * 0.8;
      return el.scrollTop > before;
    });
    if (!moved) break;
    await pause(page, 500);
  }
  await scrollToTop(page);
  return Math.max(ids.size, together);
}

export async function trashAsset(name: string): Promise<{ trashed: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  const same = (await scanGrid(page)).filter((a) => a.name === name);
  if (!same.length) throw new Error(`Nothing in the open project is called "${name}".`);
  const copies = await countTitled(page, name);
  if (copies > 1) throw new Error(`${copies} items are called "${name}", so it isn't clear which one to trash. Rename one in Flow first.`);
  // Scan again, stopping on the tile so it stays mounted in the virtual grid (no scrollToTop before acting on it).
  await scanGrid(page, (seen) => seen.some((a) => a.name === name));
  const tile = tileOf(page, same[0]);
  await hoverTile(page, tile);
  await tile.getByRole("button", { name: "More options" }).click();
  await page.getByRole("menuitem", { name: "Move to trash", exact: true }).click();
  await pause(page, 2000);
  if (await tile.count()) throw new Error(`"${name}" is still in the project - Flow did not move it to Trash.`);
  await scrollToTop(page);
  return { trashed: name };
}

// A scene's tile menu downloads a ZIP of its loose clips, which is not what anyone wants. The whole scene comes out as
// ONE stitched file from inside the scene view: open the scene, press "Download scene", and Flow shows "Exporting your
// scene..." before the file arrives (a 29 s scene took a few seconds). The user showed this route; verified 2026-10-01.
// Nothing may be pressed while it exports - an Escape here cancelled an earlier attempt.
async function downloadScene(page: Page, scene: FlowAsset, targetStem: string, opts: { overwrite?: boolean } = {}): Promise<string[]> {
  const tile = tileOf(page, scene);
  await hoverTile(page, tile);
  const box = await tile.boundingBox();
  if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  else await tile.click();
  await page.waitForURL(/\/scene\//, { timeout: 30_000 });
  await pause(page, 3000);
  const btn = page.getByRole("button", { name: "Download scene", exact: true });
  const saved = await flowDownloadToStem(page, () => btn.click(), targetStem, 600_000, { overwrite: opts.overwrite });
  await page.getByRole("button", { name: "Back button to go to previous page" }).click().catch(() => {});
  await pause(page, 2000);
  await ensureProjectGrid(page).catch(() => {});
  return saved;
}

export interface CharacterParams {
  name: string;
  image?: string;
  describe?: string;
  aspect_ratio?: string;
  personality?: string;
  voice?: string;
}

// Creates a reusable Flow character from an image (local file, or "asset:<title>" already in the project).
// Afterwards it can be attached to any scene as reference "asset:<character name>".
// What each character looks like, so scenes can hold Flow to the same design instead of letting it redraw.
// Kept on disk so a restarted server still knows the cast.
const LOOKS_FILE = join(HOME_DIR, "characters.json");
type LookValue = string | { look?: string; voice?: string };
const loadLooks = (): Record<string, LookValue> => {
  try {
    return JSON.parse(readFileSync(LOOKS_FILE, "utf8")) as Record<string, LookValue>;
  } catch {
    return {};
  }
};
// Older files stored a look string. A voice is kept beside it only when Cast actually saved one.
export function characterRecord(name: string): { look?: string; voice?: string } {
  return normalizeLookEntry(loadLooks()[name.toLowerCase()]);
}
export const characterLook = (name: string): string | undefined => {
  const look = characterRecord(name).look?.trim();
  return look || undefined;
};
export function forgetCharacter(name: string): void {
  const all = loadLooks();
  if (!(name.toLowerCase() in all)) return;
  delete all[name.toLowerCase()];
  writeFileSync(LOOKS_FILE, JSON.stringify(all, null, 2));
}
export function rememberCharacter(name: string, look: string, voice?: string): void {
  const prev = characterRecord(name);
  const nextLook = look.trim() || prev.look;
  const nextVoice = (voice ?? prev.voice)?.trim() || undefined;
  const all = loadLooks();
  const key = name.toLowerCase();
  if (!nextLook && !nextVoice) delete all[key];
  else if (nextVoice) all[key] = { ...(nextLook ? { look: nextLook } : {}), voice: nextVoice };
  else all[key] = nextLook!;
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(LOOKS_FILE, JSON.stringify(all, null, 2));
}

export async function createCharacter(c: CharacterParams, job?: Job): Promise<{ name: string; url: string; portrait?: string }> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  // A description generates the portrait first (free image), then the character is built from that picture.
  let portrait: string | undefined;
  if (!c.image) {
    if (!c.describe) throw new Error("Pass either an image or a description for the character.");
    if (job) job.progress = "drawing the character";
    const dir = join(process.env.FLOW_MCP_OUTPUT ?? join(homedir(), "flow-mcp-out"), "_cast");
    const made = await runGeneration({
      ...(job ?? ({ id: "char", status: "running", files: [], attempts: 1, createdAt: "" } as unknown as Job)),
      files: [],
      params: {
        prompt: c.describe,
        type: "image",
        max_credits: 0,
        aspect_ratio: (c.aspect_ratio as "3:4") ?? "3:4",
        output_dir: dir,
        file_stem: c.name.replace(/[^\w.-]+/g, "_"),
      },
    } as Job);
    portrait = made[0];
    c = { ...c, image: portrait };
  }
  const image = c.image!;
  const projectUrl = page.url();
  await dismissOverlays(page);
  await scrollToTop(page);

  await openProjectNav(page, "Characters");
  await pause(page, 1500);
  // With no characters yet Flow jumps straight to the creation page.
  const create = page.getByRole("button", { name: "New character" });
  if (await create.isVisible().catch(() => false)) await create.click();
  await page.waitForURL(/\/character$/, { timeout: 15_000 });

  if (image.startsWith(ASSET_PREFIX)) {
    const title = image.slice(ASSET_PREFIX.length).trim();
    await page.getByRole("button", { name: "Add from project", exact: true }).click();
    const list = page.getByRole("listbox", { name: "Asset list" });
    await list.waitFor({ state: "visible", timeout: 10_000 });
    let option = optionByName(list, title);
    if (!(await option.isVisible().catch(() => false))) {
      await page.getByRole("tab", { name: "Uploads" }).click();
      await pause(page, 1000);
      option = optionByName(list, title);
    }
    if (!(await option.isVisible().catch(() => false))) {
      await page.keyboard.press("Escape");
      throw new Error(`No image titled "${title}" in the Flow project. Use flow_assets to list titles.`);
    }
    await option.click();
    await page.getByRole("button", { name: "Add media", exact: true }).click();
  } else {
    if (!existsSync(image)) throw new Error(`File not found: ${image}`);
    const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });
    await page.getByRole("button", { name: "Upload", exact: true }).click();
    await (await chooser).setFiles(image);
  }
  await page.waitForURL(/\/character\/[0-9a-f-]{36}/, { timeout: 90_000 });
  const url = page.url();

  const name = page.getByRole("textbox", { name: "Character name" });
  await name.waitFor({ state: "visible", timeout: 15_000 });
  await name.fill(c.name);
  await name.press("Enter");
  if (c.personality) await page.getByRole("textbox", { name: "Character personality" }).fill(c.personality);

  if (c.voice) {
    await page.getByRole("button", { name: "Select a voice" }).click();
    const voices = page.getByRole("listbox", { name: "Asset list" });
    await voices.waitFor({ state: "visible", timeout: 10_000 });
    const option = optionByName(voices, c.voice);
    if (!(await option.isVisible().catch(() => false))) {
      const available = (await voices.getByRole("option").allInnerTexts()).map((t) => t.split("\n").filter((l) => l && l !== "voice_selection").join(" - "));
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      throw new Error(`Voice "${c.voice}" not found. Character was created without a voice. Available: ${available.join("; ")}`);
    }
    await option.click();
    // "Customize performance" would turn this into generating a new voice (preview + save); stock voices only.
    await page.getByRole("button", { name: "Add to character", exact: true }).click();
    await pause(page, 1000);
  }

  // Flow labels this "Done editing" or just "Done" depending on the panel state.
  await page.getByRole("button", { name: /^Done( editing)?$/ }).first().click();
  await page.waitForURL((u) => !/\/character/.test(u.pathname), { timeout: 15_000 }).catch(() => page.goto(inEnglish(projectUrl)));
  await pause(page, 1000);
  // Flow drops the new character into the composer; leave the composer empty for the next job.
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  await showAllMedia(page);
  if (c.describe) rememberCharacter(c.name, c.describe, c.voice);
  else if (c.voice) rememberCharacter(c.name, characterLook(c.name) ?? "", c.voice);
  return { name: c.name, url, portrait };
}

const EDIT_TIMEOUT_MS = 10 * 60_000;

// Video-to-video edit in Flow's edit view ("make it sunset", "remove the cup"). Flow shows no quote here, so the
// cost is measured from the balance instead (a 4 s Omni clip cost 20 credits). The result is a new tile.
export async function runEdit(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const title = s.edit_asset!;

  await ensureProjectGrid(page);
  const balance = await readCredits(page).catch(() => undefined);
  // New tiles always appear at the top, so the "before" snapshot is taken there, ahead of the search: scrolling
  // back to the top after the scan would unmount the tile we are about to click (the grid is virtualised).
  const before = await mediaIds(page);
  const matches = (a: FlowAsset) => a.kind === "video" && a.name.toLowerCase().startsWith(title.toLowerCase());
  const found = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!found) throw new Error(`No video whose title starts with "${title}". Use flow_assets to list titles.`);

  const tile = tileOf(page, found);
  await tile.scrollIntoViewIfNeeded();
  await tile.click();
  await page.waitForURL(/\/edit\//, { timeout: 20_000 });
  await pause(page, 2500);

  const box = page.locator(".ProseMirror").last();
  await box.click();
  await page.keyboard.press("ControlOrMeta+a");
  await page.keyboard.press("Delete");
  const prompt = s.prompt.replace(/\s*\n+\s*/g, " ").trim();
  await page.keyboard.type(prompt, { delay: 8 });
  await pause(page, 600);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow did not accept the edit prompt (Start generation stayed disabled).");
  await start.click();

  // Progress shows as "NN% <prompt>" inside the edit view and disappears when the edit is ready.
  const deadline = Date.now() + EDIT_TIMEOUT_MS;
  let seenProgress = false;
  for (;;) {
    await pause(page, 3000);
    const text = await page.locator("main").first().innerText();
    const pct = text.match(/(\d+)%/)?.[0];
    job.progress = pct;
    if (pct) seenProgress = true;
    else if (seenProgress) break;
    const failure = text.split("\n").find((l) => FAILURE_TEXT.test(l) && !l.includes(prompt));
    if (!pct && failure && Date.now() > deadline - EDIT_TIMEOUT_MS + 15_000) throw new Error(`Flow reported a failed edit: ${failure.slice(0, 300)}`);
    if (Date.now() > deadline) throw new Error("Timed out waiting for Flow to finish the edit.");
  }
  job.progress = undefined;

  await page.getByRole("button", { name: "Back button to go to previous page" }).click();
  await pause(page, 2500);
  await ensureProjectGrid(page);
  const fresh = await waitForNewMedia(page, before, 1, 90_000, undefined, "video");
  mkdirSync(s.output_dir, { recursive: true });
  const saved = await downloadMedia(page, fresh[0], join(s.output_dir, s.file_stem), s.download_quality);
  const after = await readCredits(page).catch(() => undefined);
  if (balance !== undefined && after !== undefined) job.credits = balance - after;
  return saved;
}

// The composer toggle's accessible name is "Flow Agent" (spark icon). Older pages called the same control "Agent".
// It is optional for ordinary image and video jobs: those use Settings trigger, the radios, and Start generation.
function agentToggle(page: Page, name: "Flow Agent" | "Agent"): Locator {
  return page.locator("flow-base-prompt-box").getByRole("button", { name, exact: true });
}

async function visibleAgentToggle(page: Page): Promise<Locator | undefined> {
  for (const name of ["Flow Agent", "Agent"] as const) {
    const button = agentToggle(page, name);
    if (await button.isVisible().catch(() => false)) return button;
  }
  return undefined;
}

// Wait until aria-pressed matches. The attribute change is the signal; the timeout only bounds a toggle that never moves.
async function waitForPressed(button: Locator, on: boolean): Promise<boolean> {
  const want = on ? "true" : "false";
  return button
    .evaluate(
      (el, expected) =>
        new Promise<boolean>((resolve) => {
          if (el.getAttribute("aria-pressed") === expected) return resolve(true);
          const obs = new MutationObserver(() => {
            if (el.getAttribute("aria-pressed") === expected) {
              obs.disconnect();
              resolve(true);
            }
          });
          obs.observe(el, { attributes: true, attributeFilter: ["aria-pressed"] });
          setTimeout(() => {
            obs.disconnect();
            resolve(el.getAttribute("aria-pressed") === expected);
          }, 2000);
        }),
      want,
    )
    .catch(() => false);
}

// Ordinary jobs must use the plain composer. A missing toggle means the page already is that composer.
async function ensureDirectComposer(page: Page): Promise<void> {
  const agent = await visibleAgentToggle(page);
  if (!agent || (await agent.getAttribute("aria-pressed")) !== "true") return;
  await agent.click();
  if (!(await waitForPressed(agent, false))) {
    throw new Error('The composer is in Flow Agent mode and did not turn off. Switch "Flow Agent" off, then roll again.');
  }
}

// The agent session panel hides the composer, so a toggle attempted underneath it does nothing at all. Leaving agent
// mode on then breaks the NEXT job, which expects the plain composer - a free character build failed that way. So this
// confirms the toggle actually landed rather than assuming the click worked. Only agent batches and continuations call it.
async function setAgentMode(page: Page, on: boolean): Promise<void> {
  // Playwright says why a click did not land ("<div ...> intercepts pointer events", "element is not visible"); keep
  // that, so a failure names what was in the way instead of guessing.
  let why = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    await clearBackdrops(page);
    await closeAgentSettings(page);
    const agent = await visibleAgentToggle(page);
    if (!agent) {
      throw new Error(
        'This Flow page has no "Flow Agent" or "Agent" toggle. Video and image jobs generate from the composer directly. Agent batches and continuations need that toggle.',
      );
    }
    if (((await agent.getAttribute("aria-pressed")) === "true") === on) return;
    await agent.click({ timeout: 8000 }).catch((err: Error) => {
      const lines = err.message.split("\n").map((l) => l.trim());
      why = (lines.find((l) => /intercepts pointer events|not visible|not enabled|detached|not stable/.test(l)) ?? lines[0]).slice(0, 200);
    });
    if (await waitForPressed(agent, on)) return;
  }
  const agent = await visibleAgentToggle(page);
  if (!agent || ((await agent.getAttribute("aria-pressed")) === "true") !== on) {
    throw new Error(`Could not switch Flow Agent ${on ? "on" : "off"}${why ? ` (${why})` : "; the click landed but the toggle did not change"}.`);
  }
}

// "Never" lets the agent generate without asking; it is switched back to "Always" as soon as the batch ends.
async function setAgentSettings(page: Page, confirm: "Always" | "Never", imageAspect?: string): Promise<void> {
  // Scoped to the prompt box: Flow added a second "Settings" button to the top bar ("View settings", seen 2026-10-13),
  // and an unscoped lookup matched both and failed every agent batch.
  await clearBackdrops(page);
  await page.locator("flow-base-prompt-box").getByRole("button", { name: "Settings", exact: true }).click();
  try {
    await page.getByRole("heading", { name: "Agent settings" }).waitFor({ state: "visible", timeout: 8000 });
    await page.getByRole("radio", { name: new RegExp(`^${confirm}`) }).click();
    if (imageAspect) {
      await page.getByRole("radio", { name: imageAspect, exact: true }).first().click();
      await page.getByRole("radio", { name: "x1", exact: true }).first().click();
      await pickAgentImageModel(page);
    }
    await pause(page, 300);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await pause(page, 1200);
  } finally {
    // Saved or not, never leave the panel covering the composer: the next step needs the Agent button.
    await closeAgentSettings(page);
  }
}

// "Reuse prompt" on an agent-made tile opens the agent's session panel, which hides the normal composer.
async function closeAgentSession(page: Page): Promise<void> {
  const panel = page.getByRole("button", { name: "Start new session" });
  if (await panel.isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await pause(page, 1000);
  }
  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  else {
    await page.locator(".ProseMirror").first().click();
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
  }
  await pause(page, 400);
}

const STOP_WORDS = new Set("the and with from into over under that this then than are was for her his its their onto next near across wide shot close scene image".split(" "));
const words = (text: string) => new Set(text.toLowerCase().match(/[a-z0-9']{3,}/g)?.filter((w) => !STOP_WORDS.has(w)) ?? []);

// Returns, per scene, the indexes of the tiles that belong to it (best match first). A tile counts when at least
// half of the scene's meaningful words appear in the prompt Flow stored for that tile.
export function matchScenes(scenes: string[], prompts: string[]): number[][] {
  // Words that most scenes share (a long common style paragraph) say nothing about WHICH scene a picture is, and they
  // drowned the distinctive ones: 8 scenes sharing one style text matched 1 of 7 pictures (2026-11-07). Match on what
  // is particular to each scene.
  const all = scenes.map(words);
  const count = new Map<string, number>();
  for (const ws of all) for (const w of ws) count.set(w, (count.get(w) ?? 0) + 1);
  const common = (w: string) => scenes.length > 2 && (count.get(w) ?? 0) >= Math.max(2, Math.ceil(scenes.length * 0.6));
  const sceneWords = all.map((ws) => {
    const own = new Set([...ws].filter((w) => !common(w)));
    return own.size >= 3 ? own : ws;
  });
  const pairs: { scene: number; tile: number; score: number }[] = [];
  prompts.forEach((prompt, tile) => {
    const have = words(prompt);
    sceneWords.forEach((want, scene) => {
      const hit = [...want].filter((w) => have.has(w)).length;
      pairs.push({ scene, tile, score: want.size ? hit / want.size : 0 });
    });
  });
  pairs.sort((x, y) => y.score - x.score);
  const out: number[][] = scenes.map(() => []);
  const usedTiles = new Set<number>();
  // First give every scene its single best tile, then hand leftover tiles to their best scene as extra takes.
  for (const firstPass of [true, false]) {
    for (const { scene, tile, score } of pairs) {
      // a third of a scene's own words is plenty once the shared boilerplate is gone (the agent paraphrases)
      if (score < 0.3 || usedTiles.has(tile) || (firstPass && out[scene].length)) continue;
      out[scene].push(tile);
      usedTiles.add(tile);
    }
  }
  return out;
}

interface RoundOutcome {
  produced: number;
  timedOut: boolean;
  failedTiles: number;
  // What the agent wrote back, when it drew nothing (it answers in text instead of generating).
  reply?: string;
}

// Scenes per request to Flow's agent. 17 and 20 worked; 30 and 39 came back with nothing drawn (2026-11-07).
const AGENT_CHUNK = 20;

// One pass through Flow's agent for the given scene numbers: ask, wait, match the new tiles back to those scenes
// and download them. Returns how many scenes it actually delivered.
// Bulk downloads go at an even, human pace: as quick as the steps allow (about 2.5 s), then held to a random 4-4.4 s each
// (the user's call, 2026-10-19), in the spirit of the random pauses between generations. Before, each took ~5.6 s.
const downloadPace = () => 4000 + Math.random() * 400;

// Progress the panel and flow_wait show; with FLOW_MCP_DEBUG set, also a timed line on stderr to find slow steps.
const t0s = new WeakMap<Job, number>();
function step(job: Job, text: string | undefined): void {
  job.progress = text;
  if (!process.env.FLOW_MCP_DEBUG || !text) return;
  if (!t0s.has(job)) t0s.set(job, Date.now());
  console.error(`[flow-mcp ${job.id}] ${((Date.now() - t0s.get(job)!) / 1000).toFixed(1)}s ${text}`);
}

// One collection per batch, named after its folder and job, so a rerun never mixes with an older set.
const collectionFor = (job: Job) => `${basename(job.params.output_dir)}-${job.id}`;

async function agentRound(
  page: Page,
  job: Job,
  scenes: string[],
  indexes: number[],
  retry: boolean,
  files: string[],
  done: Set<number>,
): Promise<RoundOutcome> {
  const s = job.params;
  const aspect = s.aspect_ratio ?? "16:9";
  const base = Number(s.file_stem.match(/\d+/)?.[0] ?? 1);
  const numberOf = (i: number) => s.agent_numbers?.[i] ?? base + i;
  await ensureProjectGrid(page);
  const seenBefore = await scanGrid(page);
  // Ids are unique per generation; titles are not (the agent reuses wording), so only id-less tiles fall back to a name.
  const before = new Set<string>(seenBefore.map((a) => a.id).filter((v): v is string => Boolean(v)));
  const beforeNames = new Set<string>(seenBefore.filter((a) => !a.id).map((a) => a.name));
  await scrollToTop(page);

  const clear = page.getByRole("button", { name: "Clear prompt" });
  if (await clear.isVisible().catch(() => false)) await clear.click();
  // Reference images ride along as ingredient chips, attached the way the + button does, once per round (the composer
  // is cleared between rounds). The script then names them, and each scene says which ones it uses.
  const refs = s.agent_refs ?? [];
  const assets = s.agent_ref_assets ?? [];
  if (refs.length) {
    for (const [k, name] of assets.entries()) {
      step(job, `attaching reference ${k + 1} of ${assets.length}`);
      await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), name);
      await pause(page, 700);
    }
    const attached = await page.getByRole("button", { name: "Ingredient" }).count();
    if (attached < assets.length) throw new Error(`Only ${attached} of ${assets.length} reference image(s) attached in the agent composer.`);
  }
  const usesOf = (i: number) => s.agent_scene_refs?.[i];
  const script = indexes
    .map((i) => {
      const uses = usesOf(i);
      const tag = !refs.length || !uses ? "" : uses.length ? ` (use references: ${uses.join(", ")})` : " (no reference)";
      return `Scene ${numberOf(i)}${tag}: ${scenes[i].replace(/\s*\n+\s*/g, " ").trim()}`;
    })
    .join(" ");
  const legend = refs.length
    ? ` The ${refs.length} attached image(s) are references: ${refs.map((r, k) => `${assets[k] ?? `image ${k + 1}`} is ${r.name}`).join("; ")}. ` +
      `Whenever a scene shows one of them, keep it exactly as it looks in its reference (face, hair, clothing, shape, colours), ` +
      `but stage each scene as its own description says; the references are for likeness only, never copy their pose or background.`
    : "";
  const lead = retry
    ? `${indexes.length} image(s) from the last batch failed to generate. Generate them again now, one image per scene`
    : `Generate exactly ${indexes.length} separate images, one image per scene, in scene order`;
  const ask = `${lead}. Images only, never video. ${aspect} aspect ratio. Do not ask questions, generate them now.${legend} ${script}`;
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.insertText(ask);
  await pause(page, 800);
  const start = page.getByRole("button", { name: "Start generation" });
  if (!(await start.isEnabled())) throw new Error("Flow's agent did not accept the script (Start generation stayed disabled).");
  const textBefore = new Set((await page.locator("body").innerText().catch(() => "")).split("\n").map((l) => l.trim()));
  await start.click();

  // The agent shows a Stop button while it works and "NN%" on every tile it is rendering.
  const deadline = Date.now() + (3 * 60_000 + indexes.length * 30_000);
  const stop = page.getByRole("button", { name: "Stop", exact: true });
  let idleSince = 0;
  let timedOut = false;
  for (;;) {
    await pause(page, 3000);
    const main = await page.locator("main").first().innerText();
    const pending = main.match(/\d+%/g) ?? [];
    const working = pending.length > 0 || (await stop.isVisible().catch(() => false));
    step(job, working ? (pending.length ? `${pending.length} rendering` : "the agent is working") : "the agent has finished");
    if (working) idleSince = 0;
    else if (!idleSince) idleSince = Date.now();
    else if (Date.now() - idleSince > 8000) break;
    if (Date.now() > deadline) {
      // A tile that hangs must not sink the batch: stop the agent and keep whatever finished.
      timedOut = true;
      if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => {});
      await pause(page, 2000);
      break;
    }
  }

  step(job, "checking for failed tiles");
  const failedTiles = await retryNewErrorTiles(page, before, true)
    .then((r) => r.errors)
    .catch(() => 0);
  const fresh = (await scanGrid(page)).filter((t) => t.id && !before.has(t.id) && !beforeNames.has(t.name) && t.kind === "image");
  if (!fresh.length) {
    // Nothing drawn: keep what the agent wrote instead, so the reason reaches the user rather than a silent retry.
    const reply = (await page.locator("body").innerText().catch(() => ""))
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 25 && !textBefore.has(l) && !/^\d+%/.test(l) && !l.startsWith("Generate exactly") && !l.includes("Scene 1"))
      .join(" ")
      .slice(0, 600);
    await closeAgentSession(page);
    return { produced: 0, timedOut, failedTiles, reply: reply || undefined };
  }

  // Tiles finish in any order and the agent rewords prompts, so each image is matched back to its scene by the
  // prompt Flow stored for it ("Reuse prompt" puts that text in the composer).
  const prompts: string[] = [];
  for (const [k, tile] of fresh.entries()) {
    step(job, `matching image ${k + 1} of ${fresh.length} to its scene`);
    await scanGrid(page, (seen) => seen.some((x) => x.id === tile.id));
    const el = mediaTile(page, tile.id!);
    await el.scrollIntoViewIfNeeded();
    await el.hover();
    await el.getByRole("button", { name: "Reuse prompt" }).click();
    await pause(page, 900);
    prompts.push(await page.locator(".ProseMirror").first().innerText());
  }
  await closeAgentSession(page);

  const assigned = matchScenes(
    indexes.map((i) => scenes[i]),
    prompts,
  );
  const drop = Number(process.env.FLOW_MCP_SIMULATE_MISSING ?? 0); // test hook: pretend this scene number failed
  mkdirSync(s.output_dir, { recursive: true });
  const wanted: { scene: number; id: string; stem: string }[] = [];
  for (const [n, tileIndexes] of assigned.entries()) {
    const sceneIndex = indexes[n];
    if (!tileIndexes.length || (numberOf(sceneIndex) === drop && !s.agent_numbers)) continue;
    for (const [v, tileIndex] of tileIndexes.entries())
      wanted.push({ scene: sceneIndex, id: fresh[tileIndex].id!, stem: join(s.output_dir, `scene-${String(numberOf(sceneIndex)).padStart(2, "0")}${v ? `-v${v + 1}` : ""}`) });
  }
  let produced = 0;
  if ((s.download_quality ?? "original") === "original" && wanted.length) {
    // The user's way (2026-11-07): gather the whole batch into one collection and fetch it as ONE ZIP, instead of a
    // tile menu per image (4.2 s each). Originals only; an upscaled batch still goes tile by tile.
    const saved = await collectAndDownload(page, job, collectionFor(job), wanted);
    files.push(...saved.values());
  } else {
    for (const w of wanted) {
      const started = Date.now();
      // New tiles sit at the top of the grid, so a scan is only needed when this one has scrolled out of the page.
      if (!(await mediaTile(page, w.id).count())) await scanGrid(page, (seen) => seen.some((x) => x.id === w.id));
      step(job, `downloading scene ${numberOf(w.scene)}`);
      files.push(...(await downloadTile(page, mediaTile(page, w.id), w.stem, s.download_quality ?? "original")));
      await pause(page, Math.max(0, downloadPace() - (Date.now() - started)));
    }
  }
  for (const scene of new Set(wanted.map((w) => w.scene))) {
    done.add(scene);
    produced++;
  }
  return { produced, timedOut, failedTiles };
}

// Hands a whole multi-scene script to Flow's own agent, which generates every image in parallel (seconds instead
// of one paced job per scene). Scenes the agent drops are asked for again, then re-run one by one as a last resort.
// Continues a clip from its own last frame WITH characters still attached - the combination the composer refuses.
// Flow's composer offers Frames OR Ingredients, never both, but agent mode does both, and this is the route the user
// demonstrated: save the clip's last frame, Animate that image (which switches Flow into agent mode by itself), then
// add the avatar or character as a second chip. Verified step by step against the live UI on 2026-09-20.
export async function runContinue(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const balance = await readCredits(page).catch(() => undefined);

  await ensureProjectGrid(page);
  const wanted = s.continue_from!.toLowerCase();
  const matches = (a: FlowAsset) => a.kind === "video" && a.name.toLowerCase().startsWith(wanted);
  const source = (await scanGrid(page, (assets) => assets.some(matches))).find(matches);
  if (!source) throw new Error(`No video whose title starts with "${s.continue_from}". Use flow_assets to list titles.`);

  try {
    // 1. Open the clip and park the playhead on its final frame, then let Flow save that frame as an image.
    job.progress = "saving the last frame";
    const tile = tileOf(page, source);
    await hoverTile(page, tile);
    await tile.click();
    await page.waitForURL(/\/edit\//, { timeout: 30_000 });
    await pause(page, 4000);
    await page.getByRole("button", { name: "Skip to next clip" }).click();
    await pause(page, 2500);
    await page.getByRole("button", { name: "Save frame" }).click();
    await pause(page, 4500);
    await page.getByRole("button", { name: "Back button to go to previous page" }).click();
    await pause(page, 3500);
    await ensureProjectGrid(page);
    await scrollToTop(page);

    // 2. Animate the frame we just saved. Flow names it after the source and puts the newest copy at the top, and
    //    the click also flips Agent on, which is what lets a character ride along.
    job.progress = "loading the frame into the composer";
    const frame = page.locator(`flow-grid-tile-container[aria-label="${`Saved frame from ${source.name}`.replace(/"/g, '\\"')}"]`).first();
    await frame.waitFor({ state: "visible", timeout: 30_000 });
    await hoverTile(page, frame);
    await frame.getByRole("button", { name: "More options" }).click();
    await pause(page, 1500);
    await page.getByRole("menuitem", { name: "Animate", exact: true }).click();
    await pause(page, 3500);
    await setAgentMode(page, true);

    // 3. The second chip: an avatar ("Me") or any character. Only useful in likeness mode - Flow's first-frame tool
    //    (I2V) ignores extra references, and attaching one just makes the agent stop and ask which we meant.
    for (const name of s.continue_mode === "likeness" ? (s.attach ?? []) : []) {
      await attachAsset(page, page.getByRole("button", { name: "Add ingredients to the prompt box" }), name);
      await pause(page, 1200);
    }

    // 4. Agent mode asks for confirmation unless told not to, which would stall an unattended run.
    await setAgentSettings(page, "Never", s.aspect_ratio ?? "16:9");
    // Agent mode treats both chips as ingredients and decides what to do with them. Attaching the saved frame is not
    // enough - without being told, the agent reads it as a style reference and stages a fresh shot. It has to be told
    // in words that the frame IS the opening frame. (Cost 15 credits to learn on 2026-09-20.)
    const cast = (s.attach ?? []).join(" and ");
    const exact = s.continue_mode !== "likeness";
    // Naming the tool settles it in one go. Flow offers first-frame animation (I2V), which continues an image exactly
    // but ignores other references, or reference-to-video (R2V), which honours a character but only approximates the
    // frame. Left unsaid, the agent stops mid-run and asks - which stalls an unattended job.
    await typePrompt(
      page,
      (exact
        ? `Use I2V, Flow's first frame animation tool. The attached frame is the FIRST FRAME of this clip: begin exactly ` +
          `on it, with the same framing, lighting, colours, wardrobe and set, and continue from there with no cut, as an ` +
          `unbroken continuation of the shot it came from. Do not use any other reference.`
        : `Use R2V, reference-to-video, with the attached frame and ${cast || "the attached reference"} both as references, ` +
          `so the look and the person stay consistent through the clip. Open as close to the attached frame as you can.`) +
        ` ${s.prompt}`,
    );
    const before = await mediaIds(page);
    job.progress = "generating";
    await page.getByRole("button", { name: "Start generation" }).click();

    // The agent sometimes still stops to ask which tool to use. Nobody is watching an unattended run, so answer it.
    for (let i = 0; i < 12; i++) {
      await pause(page, 5000);
      const asking = await page.evaluate(() => /Would you like to|which you prefer|I2V|R2V/i.test(document.body.innerText));
      const working = await page.evaluate(() => /\d{1,3}%/.test(document.body.innerText));
      if (working) break;
      if (!asking) continue;
      job.progress = "answering the agent's question";
      await typePrompt(
        page,
        exact
          ? "Use I2V, first frame animation. Start exactly on that frame and continue from it with no cut. Do not use the other reference."
          : "Use R2V, reference-to-video, using both attached references so the person stays consistent.",
      );
      await page.keyboard.press("Enter");
      await pause(page, 6000);
      break;
    }

    const fresh = await waitForNewMedia(page, before, 1, VIDEO_TIMEOUT_MS, job, "video");
    job.progress = undefined;
    mkdirSync(s.output_dir, { recursive: true });
    const saved = await downloadMedia(page, fresh[0], join(s.output_dir, s.file_stem), s.download_quality);
    const after = await readCredits(page).catch(() => undefined);
    if (balance !== undefined && after !== undefined) job.credits = balance - after;
    return saved;
  } finally {
    // Leave the composer the way the rest of the driver expects to find it. Order matters: the session panel has to go
    // first and the grid has to be back, otherwise the toggles below are clicking at something that is not there.
    await closeAgentSession(page).catch(() => {});
    await pause(page, 1500);
    await ensureProjectGrid(page).catch(() => {});
    await setAgentSettings(page, "Always").catch(() => {});
    await setAgentMode(page, false).catch(() => {});
    const clear = page.getByRole("button", { name: "Clear prompt" });
    if (await clear.isVisible().catch(() => false)) await clear.click().catch(() => {});
  }
}

export async function runAgentBatch(job: Job): Promise<string[]> {
  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint);
  const page = await getFlowPage();
  const s = job.params;
  const scenes = s.agent_scenes!;

  await ensureProjectGrid(page);
  const balance = await readCredits(page).catch(() => undefined);

  const files: string[] = [];
  const done = new Set<number>();
  const firstNumber = Number(s.file_stem.match(/\d+/)?.[0] ?? 1);
  const numberOf = (i: number) => s.agent_numbers?.[i] ?? firstNumber + i;
  let agentTimedOut = false;
  let failedTiles = 0;
  let agentRetries = 0;
  let agentProblem = "";
  let collectionProblem = "";
  try {
    // References are uploaded once with readable names (the agent sees them), before Agent mode hides the upload menu.
    if (s.agent_refs?.length && !s.agent_ref_assets?.length) {
      await setAgentMode(page, false);
      const assets: string[] = [];
      for (const [k, r] of s.agent_refs.entries()) {
        step(job, `uploading reference ${k + 1} of ${s.agent_refs.length} (${r.name})`);
        const label = r.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || `ref${k + 1}`;
        assets.push(await uploadAsset(page, job, r.image, label));
      }
      s.agent_ref_assets = assets;
    }
    step(job, "switching Agent mode on");
    await setAgentMode(page, true);
    step(job, "setting the agent to generate without asking");
    await setAgentSettings(page, "Never", s.aspect_ratio ?? "16:9");
    rounds: for (let round = 0; round < 3; round++) {
      const todo = scenes.map((_, i) => i).filter((i) => !done.has(i));
      if (!todo.length) break;
      if (round) {
        agentRetries += todo.length;
        job.progress = `asking the agent again for ${todo.length} scene(s)`;
      }
      for (let c = 0; c < todo.length; c += AGENT_CHUNK) {
        const chunk = todo.slice(c, c + AGENT_CHUNK);
        if (todo.length > AGENT_CHUNK) step(job, `asking the agent for scenes ${numberOf(chunk[0])}-${numberOf(chunk[chunk.length - 1])}`);
        const out = await agentRound(page, job, scenes, chunk, round > 0, files, done);
        agentTimedOut ||= out.timedOut;
        failedTiles = out.failedTiles;
        if (!out.produced) {
          // The agent drew nothing for a whole request: stop asking it, and never quietly switch to one by one.
          if (!done.size) agentProblem = `it drew nothing${out.reply ? `; it said: "${out.reply}"` : ""}.`;
          break rounds;
        }
      }
    }
  } catch (err) {
    // A download that stopped is NOT a reason to make the images again or to fetch them another way: they exist in
    // Flow. Stop, and say where they are.
    if (err instanceof CollectionError) collectionProblem = err.message;
    // Agent mode could not be used (2026-10-13: "Could not switch Agent mode on" failed a whole 11-image batch with
    // nothing made). Whatever the agent did not deliver is made one by one below instead: slower, but the batch still
    // ends with every image.
    else agentProblem = (err as Error).message;
  } finally {
    step(job, "putting the agent settings back");
    await ensureProjectGrid(page).catch(() => {});
    await closeAgentSession(page).catch(() => {});
    await setAgentMode(page, true).catch(() => {});
    await setAgentSettings(page, "Always").catch(() => {});
    await setAgentMode(page, false).catch(() => {});
  }

  // Agent mode failing outright is NOT a reason to make the whole batch one image at a time (the user, 2026-11-07:
  // "I always see you creating one by one"). Stop and say why; the one-by-one route is only for the few scenes a
  // working agent dropped.
  if (agentProblem && !done.size) {
    throw new Error(`Flow's agent could not run this batch: ${agentProblem} Nothing was made one by one instead.`);
  }
  if (collectionProblem) {
    throw new Error(
      `${collectionProblem} The images are in Flow (collection "${collectionFor(job)}" if they were moved there): ` +
        `flow_download with collection "${collectionFor(job)}" fetches them as one ZIP without generating anything. ` +
        (files.length ? `Saved before it stopped: ${files.length} file(s) in ${s.output_dir}.` : "Nothing was saved yet."),
    );
  }

  // Anything the agent still has not delivered is generated one by one, which is slower but exact.
  const missing = scenes.map((_, i) => i).filter((i) => !done.has(i));
  const failed: number[] = [];
  const stillFails = Number(process.env.FLOW_MCP_SIMULATE_FAILED ?? 0); // test hook: pretend this scene failed for good
  // A scene made one by one keeps its references: the uploaded copies when there are some, else the original files.
  const refsFor = (i: number): string[] | undefined => {
    const refs = s.agent_refs ?? [];
    if (!refs.length) return undefined;
    const uses = s.agent_scene_refs?.[i];
    const picked = refs
      .map((r, k) => ({ r, k }))
      .filter(({ r }) => !uses || uses.some((u) => u.toLowerCase() === r.name.toLowerCase()))
      .slice(0, 3);
    return picked.length ? picked.map(({ r, k }) => (s.agent_ref_assets?.[k] ? `${ASSET_PREFIX}${s.agent_ref_assets[k]}` : r.image)) : undefined;
  };
  // One by one is only for the odd scene a working agent dropped. More than a few go back as "still failed", and
  // Retry asks the agent again for just those, in bulk.
  const MAX_ONE_BY_ONE = 3;
  if (missing.length > MAX_ONE_BY_ONE) {
    failed.push(...missing.map(numberOf));
    missing.length = 0;
  }
  for (const [n, i] of missing.entries()) {
    job.progress = `re-running scene ${numberOf(i)} one by one (${n + 1}/${missing.length})`;
    if (numberOf(i) === stillFails && !job.params.agent_numbers) {
      failed.push(numberOf(i));
      continue;
    }
    const single: Job = {
      ...job,
      files: [],
      params: {
        prompt: scenes[i],
        type: "image",
        max_credits: 0,
        reference_images: refsFor(i),
        aspect_ratio: s.aspect_ratio,
        download_quality: s.download_quality,
        output_dir: s.output_dir,
        file_stem: `scene-${String(numberOf(i)).padStart(2, "0")}`,
      },
    };
    let ok = false;
    for (let attempt = 0; attempt < 2 && !ok; attempt++) {
      if (attempt || n) await pause(page, 8000);
      try {
        files.push(...(await runGeneration(single)));
        ok = true;
      } catch {
        /* one more attempt, then give up on this scene */
      }
    }
    if (!ok) failed.push(numberOf(i));
  }
  job.failed_scenes = failed.length ? failed : undefined;
  const left = await readCredits(page).catch(() => undefined);
  files.sort();
  job.note = [
    // What still needs doing first: the panel shows only the start of a long note.
    failed.length ? `still failed: scene ${failed.join(", ")} (use Retry)` : "",
    agentProblem ? `agent mode failed (${agentProblem}), so the images were made one by one` : "",
    agentTimedOut ? "the agent stalled and was stopped" : "",
    `${done.size} of ${scenes.length} scenes came from the agent`,
    s.agent_refs?.length ? `${s.agent_refs.length} reference image(s) attached` : "",
    agentRetries ? `${agentRetries} asked again` : "",
    failedTiles ? `${failedTiles} tile(s) failed in Flow` : "",
    missing.length > failed.length ? `${missing.length - failed.length} re-run one by one` : "",
  ]
    .filter(Boolean)
    .join(" · ");
  if (!files.length) throw new Error("No image could be generated for any scene. Open the Flow tab to see what Flow reported.");

  if (balance !== undefined && left !== undefined) job.credits = balance - left;
  return files;
}

export interface FlowProjectEntry {
  id: string;
  title: string;
  url: string;
}

const FLOW_HOME_URLS = ["https://flow.google.com/", "https://labs.google/fx/tools/flow"];

/** Flow home grid with project cards and "New project". Publish uses this; no clip project needs to be open. */
export async function ensureFlowProjectHome(page: Page): Promise<void> {
  const state = await getFlowState(false);
  if (!state.signedIn) throw new Error(state.hint ?? "Not signed in. Run `npm run login` and sign in to Google in the Flow Chrome window.");
  for (const home of FLOW_HOME_URLS) {
    await page.goto(inEnglish(home), { waitUntil: "domcontentloaded" });
    await dismissOverlays(page);
    await pause(page, 2000);
    if (/\/about|accounts\.google\.com/.test(page.url())) continue;
    const ok = await page
      .getByRole("button", { name: /new project/i })
      .first()
      .waitFor({ state: "visible", timeout: 18_000 })
      .then(() => true, () => false);
    if (ok) return;
  }
  throw new Error(
    'Could not open Flow\'s project list. In the Flow Chrome window go to flow.google.com until you see "New project" and your project cards, then try again.',
  );
}

const FLOW_PROJECT_TITLES = join(HOME_DIR, "flow-project-titles.json");

function loadFlowProjectTitleCache(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(FLOW_PROJECT_TITLES, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function rememberFlowProjectTitle(id: string, title: string) {
  const t = normalizeFlowProjectTitle(title);
  if (!isGoodFlowProjectTitle(t)) return;
  const cache = loadFlowProjectTitleCache();
  if (cache[id] === t) return;
  cache[id] = t;
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(FLOW_PROJECT_TITLES, JSON.stringify(cache, null, 2), "utf8");
}

/** Projects listed on Flow's home grid. Does not spend credits. */
export async function listFlowProjects(): Promise<FlowProjectEntry[]> {
  const page = await getFlowPage();
  const returnTo = page.url();
  await ensureFlowProjectHome(page);
  let ids: string[] = [];
  let titlesFromHome = new Map<string, string>();

  for (let scroll = 0; scroll < 12; scroll++) {
    await page.mouse.wheel(0, 480);
    await pause(page, 220);
  }
  const scraped = await scrapeFlowProjectTiles(page);
  ids = scraped.ids;
  titlesFromHome = scraped.titles;

  if (!ids.length) {
    throw new Error(
      'No Flow projects found. In the Flow Chrome window open the project grid (flow.google.com — you should see "New project" and your cards), then press Refresh list in Publish.',
    );
  }

  const titleCache = loadFlowProjectTitleCache();
  const out: FlowProjectEntry[] = [];
  for (const id of ids.slice(0, 60)) {
    let title = normalizeFlowProjectTitle(titlesFromHome.get(id) || titleCache[id] || "");
    if (!isGoodFlowProjectTitle(title)) {
      title = normalizeFlowProjectTitle((await readFlowProjectTitle(page, id)) || title);
      if (isGoodFlowProjectTitle(title)) rememberFlowProjectTitle(id, title);
    } else {
      rememberFlowProjectTitle(id, title);
    }
    out.push({
      id,
      title: isGoodFlowProjectTitle(title) ? title : `Project ${id.slice(0, 8)}`,
      url: `https://flow.google.com/project/${id}`,
    });
  }

  const host = returnTo.includes("flow.google.com") || returnTo.includes("labs.google");
  if (host && !returnTo.includes("/about")) {
    await page.goto(inEnglish(returnTo), { waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
  out.sort((a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: "base" }));
  return out;
}

/** Strip Flow home-grid chrome (Open/Edit buttons, icon ligatures) from a project name. */
export function normalizeFlowProjectTitle(title: string): string {
  return title
    .replace(/\b(delete project|edit project|open project|view project|new project)\b/gi, " ")
    .replace(/\b(accessibility_new|more_vert|edit|delete|open)\b/gi, " ")
    .replace(/,\s*edit\s*$/i, "")
    .replace(/\s+edit\s*$/i, "")
    .replace(/\s+open\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isGoodFlowProjectTitle(title: string): boolean {
  const t = normalizeFlowProjectTitle(title);
  if (t.length < 2 || t.length > 120) return false;
  return !/^(new project|open project|view project|delete project|edit project|edit|untitled|open|more)$/i.test(t);
}

async function scrapeFlowProjectTiles(page: Page): Promise<{ ids: string[]; titles: Map<string, string> }> {
  const raw = await page.evaluate(() => {
    const titles = new Map<string, string>();
    const ids = new Set<string>();
    const uuidRe = /\/project\/([0-9a-f-]{36})/i;

    const clean = (t: string) => {
      let s = t
        .replace(/\b(delete project|edit project|open project|view project|new project)\b/gi, " ")
        .replace(/\b(accessibility_new|more_vert)\b/gi, " ")
        .replace(/,\s*edit\s*$/i, "")
        .replace(/\s+edit\s*$/i, "")
        .replace(/\s+open\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
      return s;
    };

    const isBad = (t: string) => {
      const u = clean(t).toLowerCase();
      if (u.length < 2 || u.length > 120) return true;
      return /^(new project|open project|view project|delete project|edit project|edit|untitled|open|more|project)$/.test(u);
    };

    const scoreTitle = (t: string) => {
      if (isBad(t)) return -1;
      let s = Math.min(t.length, 80);
      if (/^\d{1,2}\s*[-–]/.test(t) || /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\b/i.test(t)) s += 8;
      if (/\s/.test(t)) s += 4;
      return s;
    };

    const noteTitle = (id: string, title: string) => {
      const t = clean(title);
      if (isBad(t)) return;
      const prev = titles.get(id) || "";
      if (scoreTitle(t) > scoreTitle(prev)) titles.set(id, t);
    };

    const splitAria = (aria: string, id: string) => {
      const a = clean(aria);
      if (!a) return;
      a.split(/,\s*/).forEach((part) => noteTitle(id, part));
      const noOpen = a.replace(/,?\s*open project.*$/i, "").trim();
      if (noOpen) noteTitle(id, noOpen);
    };

    const titleFromCard = (anchor: Element, id: string) => {
      const card =
        anchor.closest(
          "flow-project-card, [class*='project-card'], [class*='project-tile'], mat-card, [class*='card'], [class*='tile']",
        ) || anchor.parentElement?.parentElement;
      if (!card) return;
      const prefer = card.querySelector(
        "h1,h2,h3,h4,[class*='title']:not(button):not(a),[class*='name']:not(button):not(a),[class*='heading']",
      );
      if (prefer) {
        const t = clean(prefer.textContent || "");
        if (t) noteTitle(id, t);
      }
      card.querySelectorAll("span, p, h1, h2, h3, h4").forEach((node) => {
        if (node.closest("button, a[href*='project/'], [role='button']")) return;
        const t = clean(node.textContent || "");
        if (t.length >= 2 && t.length < 100 && !/^edit$/i.test(t)) noteTitle(id, t);
      });
    };

    document.querySelectorAll("a[href*='/project/']").forEach((a) => {
      const href = a.getAttribute("href") || "";
      const m = href.match(uuidRe);
      if (!m) return;
      const id = m[1];
      ids.add(id);
      const aria = a.getAttribute("aria-label") || "";
      splitAria(aria, id);
      const linkText = clean(a.textContent || "");
      if (linkText && !isBad(linkText)) noteTitle(id, linkText);
      titleFromCard(a, id);
    });

    const body = document.body?.innerHTML || "";
    const globalRe = /\/project\/([0-9a-f-]{36})/gi;
    let match: RegExpExecArray | null;
    while ((match = globalRe.exec(body)) !== null) ids.add(match[1]);

    return { ids: [...ids], titles: [...titles.entries()] };
  });

  const titles = new Map<string, string>();
  for (const [id, rawTitle] of raw.titles as [string, string][]) {
    const t = normalizeFlowProjectTitle(rawTitle);
    if (isGoodFlowProjectTitle(t)) titles.set(id, t);
  }
  return { ids: raw.ids, titles };
}

async function readFlowProjectTitle(page: Page, id: string): Promise<string> {
  const cached = normalizeFlowProjectTitle(loadFlowProjectTitleCache()[id] || "");
  if (cached && isGoodFlowProjectTitle(cached)) {
    rememberFlowProjectTitle(id, cached);
    return cached;
  }
  await page.goto(inEnglish(`https://flow.google.com/project/${id}`), { waitUntil: "domcontentloaded" });
  await dismissOverlays(page).catch(() => undefined);
  const title =
    (await page
      .getByRole("textbox", { name: "Editable text" })
      .first()
      .inputValue()
      .catch(() => "")) || "";
  const t = normalizeFlowProjectTitle(title);
  if (isGoodFlowProjectTitle(t)) rememberFlowProjectTitle(id, t);
  return t;
}

/** Stable publish handle: media uuid when known, else title:<exact grid name>. */
export function assetPublishHandle(a: Pick<FlowAsset, "id" | "name">): string {
  return a.id && isMediaId(a.id) ? a.id : `title:${a.name}`;
}

/** Videos and scenes in one Flow project grid (no images). */
export async function listFlowProjectVideos(flowProjectId: string): Promise<FlowAsset[]> {
  if (!/^[0-9a-f-]{36}$/i.test(flowProjectId)) throw new Error("Invalid Flow project id.");
  const state = await getFlowState(false);
  if (!state.signedIn) throw new Error(state.hint ?? "Not signed in to Flow.");
  const opened = await openFlowProject(flowProjectId);
  const page = await getFlowPage({ preferProjectId: flowProjectId });
  const openId = page.url().match(/\/project\/([0-9a-f-]{36})/i)?.[1]?.toLowerCase();
  if (openId !== flowProjectId.toLowerCase()) {
    throw new Error(
      `Chrome opened the wrong Flow project (wanted ${flowProjectId.slice(0, 8)}…, saw ${openId?.slice(0, 8) ?? "none"}). Close extra Flow tabs and try again.`,
    );
  }
  await ensureProjectGrid(page);
  await page
    .locator("flow-grid-tile-container")
    .first()
    .waitFor({ state: "visible", timeout: 45_000 })
    .catch(() => undefined);
  const assets = await scanGrid(page);
  const videos = assets
    .filter((a) => a.kind === "video" || a.kind === "scene")
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  if (!videos.length && assets.length) {
    throw new Error(
      `Opened "${opened.title}" (${flowProjectId.slice(0, 8)}…) but found ${assets.length} tile(s) and none were videos or scenes. In Flow, open All media for that project and retry.`,
    );
  }
  return videos;
}

/** Download one grid item into outputDir; returns the saved video path. */
export async function downloadFlowAssetForPublish(
  flowProjectId: string,
  handle: string,
  outputDir: string,
): Promise<string> {
  await openFlowProject(flowProjectId);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  const assets = await scanGrid(page);
  const wantedTitle = handle.startsWith("title:") ? handle.slice("title:".length) : undefined;
  const hit = assets.find(
    (a) =>
      assetPublishHandle(a) === handle ||
      a.id === handle ||
      (wantedTitle && a.name === wantedTitle) ||
      a.name === handle,
  );
  if (!hit) throw new Error(`That video is not in this Flow project anymore (${handle}). Refresh the list.`);
  mkdirSync(outputDir, { recursive: true });
  const stem = join(outputDir, hit.name.replace(/[^\w.-]+/g, "_").slice(0, 96) || "clip");
  const saved =
    hit.kind === "scene"
      ? await downloadScene(page, hit, stem, { overwrite: true })
      : await downloadAsset(hit.name, stem, "original", { overwrite: true });
  if (!saved.length) throw new Error(`Download failed for "${hit.name}".`);
  return saved[0]!;
}

/** Opens a Flow project in the user's Flow Chrome window. */
export async function openFlowProject(id: string): Promise<FlowProjectEntry> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("Invalid Flow project id.");
  const page = await getFlowPage({ preferProjectId: id });
  const low = id.toLowerCase();
  if (!page.url().toLowerCase().includes(`/project/${low}`)) {
    await page.goto(inEnglish(`https://flow.google.com/project/${id}`), { waitUntil: "domcontentloaded" });
  }
  await page
    .waitForURL((url) => url.pathname.toLowerCase().includes(`/project/${low}`), { timeout: 45_000 })
    .catch(() => {
      throw new Error(`Flow did not open project ${id.slice(0, 8)}… (Chrome is at ${page.url()}).`);
    });
  await dismissOverlays(page).catch(() => undefined);
  await scrollToTop(page).catch(() => undefined);
  const title =
    (await page
      .getByRole("textbox", { name: "Editable text" })
      .first()
      .inputValue()
      .catch(() => "")) || "Untitled";
  return { id, title: title.trim() || "Untitled", url: page.url().split("?")[0] };
}

// A fresh Flow project, so a film can start from scratch without anyone clicking. Mapped live (2026-10-30): Flow's home
// page has one button "New project", which opens /project/<uuid>; on the project page the name is a text box whose
// accessible name is "Editable text" (it holds Flow's default name, e.g. "Oct 29 - 22:17").
export async function createProject(title?: string): Promise<{ id: string; url: string; title: string }> {
  const page = await getFlowPage();
  await page.goto(inEnglish("https://flow.google.com/"), { waitUntil: "domcontentloaded" });
  const button = page.getByRole("button", { name: /new project/i }).first();
  await button.waitFor({ state: "visible", timeout: 30_000 }).catch(() => {
    throw new Error("Flow's home page shows no \"New project\" button. Check the Flow window is signed in.");
  });
  await button.click();
  await page.waitForURL(/\/project\/[0-9a-f-]{36}/, { timeout: 30_000 }).catch(() => {
    throw new Error("Pressed \"New project\" but Flow did not open a project within 30 s.");
  });
  const id = page.url().match(/\/project\/([0-9a-f-]{36})/)![1];
  const name = page.getByRole("textbox", { name: "Editable text" }).first();
  await name.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  if (title?.trim()) {
    await name.fill(title.trim()).catch(() => undefined);
    await name.press("Enter").catch(() => undefined);
    await page.waitForTimeout(1200);
  }
  const shown = (await name.inputValue().catch(() => "")) || title || "";
  return { id, url: `https://flow.google.com/project/${id}`, title: shown };
}

const MERGE_MOCK = () => process.env.FLOW_MCP_MERGE_MOCK === "1";

export interface FlowMergeInput {
  tedverseProject: string;
  clips: { stem: string; flow_title?: string }[];
  aspect_ratio?: "9:16";
}

async function openNewSceneBuilder(page: Page): Promise<void> {
  await dismissOverlays(page);
  await scrollToTop(page);
  await showAllMedia(page);
  const menu = page.getByRole("button", { name: "Add media menu" });
  await menu.click({ timeout: 10_000 });
  const newScene = page.getByRole("menuitem", { name: /New scene/i });
  if (!(await newScene.isVisible({ timeout: 8000 }).catch(() => false))) {
    await page.keyboard.press("Escape");
    throw new Error('Flow did not offer "New scene" under Add media menu.');
  }
  await newScene.click();
  await page.waitForURL(/\/project\/[0-9a-f-]{36}\//, { timeout: 60_000 });
  await pause(page, mergePaceMs(2800));
  await mergeSettle(page, "new scene editor mounted");
}

function pickResumableSceneAsset(
  assets: FlowAsset[],
  compositionName: string,
  prior?: FlowCompositionRecord,
): FlowAsset | undefined {
  if (prior?.composition_id && /^[0-9a-f-]{36}$/i.test(prior.composition_id)) {
    const byId = assets.find((a) => a.kind === "scene" && a.id === prior.composition_id);
    if (byId) return byId;
  }
  const final = assets.find((a) => a.kind === "scene" && a.name === compositionName);
  if (final) return final;
  const untitled = assets.filter((a) => a.kind === "scene" && /untitled/i.test(a.name));
  if (!untitled.length) return undefined;
  untitled.sort((a, b) => b.name.localeCompare(a.name, undefined, { sensitivity: "base" }));
  return untitled[0];
}

async function ensureFlowProjectPage(page: Page, flowProjectId: string): Promise<void> {
  if (/\/project\/[0-9a-f-]{36}/i.test(page.url())) return;
  await page.goto(inEnglish(`https://flow.google.com/project/${flowProjectId}`), { waitUntil: "domcontentloaded" });
  await pause(page, mergePaceMs(1500));
  await dismissOverlays(page).catch(() => {});
  await showAllMedia(page).catch(() => {});
}

async function openSceneBuilderForMerge(
  page: Page,
  flowProjectId: string,
  resume?: { sceneId?: string; asset?: FlowAsset },
): Promise<void> {
  const sceneId = resume?.sceneId?.match(/^[0-9a-f-]{36}$/i)?.[0];
  if (sceneId) {
    if (process.env.FLOW_MCP_DEBUG) console.error(`[flow-mcp merge] resume scene ${sceneId}`);
    await page.goto(inEnglish(`https://flow.google.com/project/${flowProjectId}/scene/${sceneId}`), {
      waitUntil: "domcontentloaded",
    });
    await pause(page, mergePaceMs(1400));
    await mergeSettle(page, "resumed scene editor");
    await dismissOverlays(page).catch(() => {});
    await waitForSceneEditorReady(page).catch(() => undefined);
    return;
  }
  const asset = resume?.asset;
  if (asset?.kind === "scene") {
    const idFromAsset = asset.id && /^[0-9a-f-]{36}$/i.test(asset.id) ? asset.id : undefined;
    if (idFromAsset) {
      await page.goto(inEnglish(`https://flow.google.com/project/${flowProjectId}/scene/${idFromAsset}`), {
        waitUntil: "domcontentloaded",
      });
      await pause(page, mergePaceMs(1400));
      await mergeSettle(page, "resumed scene editor");
      await dismissOverlays(page).catch(() => {});
      await waitForSceneEditorReady(page).catch(() => undefined);
      return;
    }
    if (process.env.FLOW_MCP_DEBUG) console.error(`[flow-mcp merge] open scene tile "${asset.name}"`);
    await dismissOverlays(page);
    await scrollToTop(page);
    await showAllMedia(page);
    const tile = page.locator(`flow-grid-tile-container[aria-label="${asset.name.replace(/"/g, '\\"')}"]`).first();
    await tile.waitFor({ state: "visible", timeout: 20_000 });
    await tile.click({ timeout: 15_000 });
    await page.waitForURL(/\/project\/[0-9a-f-]{36}\/scene\/[0-9a-f-]{36}/i, { timeout: 90_000 });
    await pause(page, mergePaceMs(1800));
    await mergeSettle(page, "scene tile opened");
    await dismissOverlays(page).catch(() => {});
    await waitForSceneEditorReady(page).catch(() => undefined);
    return;
  }
  await openNewSceneBuilder(page);
  await waitForSceneEditorReady(page).catch(() => undefined);
}

async function ensureMergeSceneEditor(page: Page, flowProjectId: string, sceneId?: string): Promise<void> {
  if (/\/scene\/[0-9a-f-]{36}/i.test(page.url())) return;
  if (sceneId && /^[0-9a-f-]{36}$/i.test(sceneId)) {
    await page.goto(inEnglish(`https://flow.google.com/project/${flowProjectId}/scene/${sceneId}`), {
      waitUntil: "domcontentloaded",
    });
    await pause(page, mergePaceMs(1400));
    await mergeSettle(page, "back on scene editor");
    await dismissOverlays(page).catch(() => {});
  }
}

function projectIdFromUrl(url: string): string | undefined {
  return url.match(/\/project\/([0-9a-f-]{36})/)?.[1];
}

function sceneIdFromUrl(url: string): string | undefined {
  return url.match(/\/scene\/([0-9a-f-]{36})/)?.[1];
}

/** Build a merged scene in Flow (e.g. 0001-Final) — saves on Flow only; does not download. */
export async function mergeClipsIntoFlowScene(input: FlowMergeInput): Promise<FlowCompositionRecord> {
  const compositionName = filmFinalSceneName(input.tedverseProject);
  const titles = input.clips.map((c, i) => ({
    order: i + 1,
    stem: c.stem,
    flow_title: (c.flow_title || `${input.tedverseProject}-${c.stem}`).trim(),
  }));
  const hash = contentHashFromTitles(titles.map((t) => t.flow_title));
  const now = new Date().toISOString();

  if (MERGE_MOCK()) {
    const rec: FlowCompositionRecord = {
      tedverse_project: input.tedverseProject,
      flow_project_id: "00000000-0000-0000-0000-000000000001",
      composition_id: "00000000-0000-0000-0000-000000000002",
      composition_name: compositionName,
      scene_assets: titles,
      scene_count: titles.length,
      merge_status: "completed",
      publish_status: "ready_to_publish",
      aspect_ratio: input.aspect_ratio ?? "9:16",
      content_hash: hash,
      updated_at: now,
    };
    saveComposition(rec);
    return rec;
  }

  const state = await getFlowState();
  if (!state.signedIn || !state.inProject) throw new Error(state.hint ?? "Flow is not ready.");
    const page = await getFlowPage();
    await ensureProjectGrid(page);
    let flowProjectId = projectIdFromUrl(page.url());
    if (!flowProjectId) throw new Error("Could not read the open Flow project id. Open your Teddy Ngo project in Flow, then retry merge.");

    const assets = await scanGrid(page);
  const missing = titles.filter((t) => !assets.some((a) => a.kind === "video" && optionIsExactMedia(a.name, t.flow_title)));
  if (missing.length) {
    throw new Error(
      `Missing ${missing.length} clip(s) in Flow: ${missing.map((m) => m.flow_title).join(", ")}. Download scenes before merging.`,
    );
  }

  let rec: FlowCompositionRecord = {
    tedverse_project: input.tedverseProject,
    flow_project_id: flowProjectId,
    composition_id: "",
    composition_name: compositionName,
    scene_assets: titles,
    scene_count: titles.length,
    merge_status: "in_progress",
    publish_status: "not_ready",
    aspect_ratio: input.aspect_ratio ?? "9:16",
    content_hash: hash,
    updated_at: now,
  };
  saveComposition(rec);

  const prior = getComposition(input.tedverseProject);
  const resumeSceneId =
    prior?.flow_project_id === flowProjectId && prior.composition_id && /^[0-9a-f-]{36}$/i.test(prior.composition_id)
      ? prior.composition_id
      : undefined;
  const resumeAsset =
    prior?.flow_project_id === flowProjectId && prior.merge_status !== "completed"
      ? pickResumableSceneAsset(assets, compositionName, prior)
      : undefined;

    try {
    await ensureFlowProjectPage(page, flowProjectId);
    await openSceneBuilderForMerge(page, flowProjectId, {
      sceneId: resumeSceneId,
      asset: resumeSceneId ? undefined : resumeAsset,
    });
    let sceneId = sceneIdFromUrl(page.url());
    if (sceneId) {
      rec.composition_id = sceneId;
      saveComposition(rec);
    }
    await waitForSceneEditorReady(page).catch((err) => {
      if (process.env.FLOW_MCP_DEBUG) console.error(`[flow-mcp merge] scene editor wait: ${err}`);
    });
    const aspectNote = await setSceneBuilderAspectRatio(page, rec.aspect_ratio);
    if (aspectNote && process.env.FLOW_MCP_DEBUG) console.error(`[flow-mcp merge] ${aspectNote}`);
    const wantCount = titles.length;
    let timeline = await sceneTimelineTitles(page);
    for (const clip of titles) {
      if (timelineHasClip(timeline, clip.flow_title)) {
        if (process.env.FLOW_MCP_DEBUG) console.error(`[flow-mcp merge] already on timeline: ${clip.flow_title}`);
        continue;
      }
      const count = await sceneTimelineClipCount(page);
      await insertSceneBuilderClip(page, clip.flow_title, { isFirst: count === 0 });
      timeline = await sceneTimelineTitles(page);
    }
    const finalTitles = await sceneTimelineTitles(page);
    const missingOnTimeline = titles.filter((t) => !timelineHasClip(finalTitles, t.flow_title));
    if (missingOnTimeline.length) {
      throw new Error(
        `Still missing ${missingOnTimeline.length} clip(s) on the timeline: ${missingOnTimeline.map((m) => m.flow_title).join(", ")}. Open the scene in Flow, add manually, then Retry merge.`,
      );
    }
    sceneId = sceneIdFromUrl(page.url()) ?? sceneId;
    await ensureMergeSceneEditor(page, flowProjectId, sceneId);
    await renameSceneBuilderTitle(page, rec.composition_name).catch(async () => {
      const name = page.getByRole("textbox", { name: /Editable text/i }).first();
      if (await name.isVisible({ timeout: 3000 }).catch(() => false)) {
        await name.fill(rec.composition_name);
        await name.press("Enter").catch(() => undefined);
        await pause(page, mergePaceMs(900));
      }
    });
    await mergeSettle(page, "after rename");
    const done = page
      .getByRole("button", { name: /Done editing scene|Done editing|^Done$/i })
      .first();
    if (await done.isVisible({ timeout: 8000 }).catch(() => false)) {
      await done.click({ timeout: 10_000 }).catch(() => {});
      await pause(page, mergePaceMs(2000));
      await mergeSettle(page, "after Done");
    }
    if (!sceneId) sceneId = sceneIdFromUrl(page.url());
    const back = page.getByRole("button", { name: "Back button to go to previous page" });
    if (await back.isVisible({ timeout: 5000 }).catch(() => false)) {
      await back.click({ timeout: 10_000 }).catch(() => {});
      await pause(page, 2000);
    }
    await ensureProjectGrid(page).catch(() => {});
    if (!sceneId) {
      const finalScene = (await scanGrid(page)).find((a) => a.kind === "scene" && a.name === rec.composition_name);
      sceneId = finalScene?.id?.replace(/^title:/, "");
    }
    if (!sceneId || !/^[0-9a-f-]{36}$/i.test(sceneId)) {
      throw new Error(
        `Saved the scene but could not read its composition id. Open the "${rec.composition_name}" scene in Flow and retry.`,
      );
    }
    rec.composition_id = sceneId;
    rec.merge_status = "completed";
    rec.publish_status = "ready_to_publish";
    rec.cached_video_path = undefined;
    rec.cached_video_hash = undefined;
    rec.updated_at = new Date().toISOString();
    saveComposition(rec);
    return rec;
  } catch (err) {
    rec.merge_status = "failed";
    rec.publish_status = "not_ready";
    rec.error = err instanceof Error ? err.message : String(err);
    rec.updated_at = new Date().toISOString();
    saveComposition(rec);
    throw err;
  }
}

/** Download the saved Final composition once (for manual Publish). */
export async function downloadFlowComposition(record: FlowCompositionRecord, targetStem: string): Promise<string> {
  if (MERGE_MOCK()) {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    mkdirSync(dirname(targetStem), { recursive: true });
    const path = `${targetStem}.mp4`;
    writeFileSync(path, Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70]));
    return path;
  }

  const state = await getFlowState(false);
  if (!state.signedIn) throw new Error(state.hint ?? "Not signed in to Flow.");
  const page = await getFlowPage();
  const url = inEnglish(`https://flow.google.com/project/${record.flow_project_id}/scene/${record.composition_id}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await pause(page, 3500);

  const buttons = [
    page.getByRole("button", { name: "Download media", exact: true }),
    page.getByRole("button", { name: "Download", exact: true }),
    page.getByRole("button", { name: "Download scene", exact: true }),
  ];
  let saved: string[] | undefined;
  for (const btn of buttons) {
    if (!(await btn.isVisible({ timeout: 4000 }).catch(() => false))) continue;
    try {
      saved = await flowDownloadToStem(page, () => btn.click(), targetStem, 600_000, { overwrite: true });
      if (saved.length) break;
    } catch {
      /* try next label */
    }
  }
  if (!saved?.length) throw new Error("Could not download the Final composition — no Download control worked in Scene Builder.");
  await page.getByRole("button", { name: "Back button to go to previous page" }).click().catch(() => {});
  await ensureProjectGrid(page).catch(() => {});
  return saved[0]!;
}

/** Resolve final.mp4 for Publish: local file, saved composition, or a Flow scene (e.g. 0001-Final). */
export async function preparePublishFinal(
  flowProjectId: string,
  outputDir: string,
  tedverseProject?: string,
): Promise<{ path: string; ready: boolean; note: string }> {
  const state = await getFlowState(false);
  if (!state.signedIn) throw new Error(state.hint ?? "Not signed in to Flow.");
  mkdirSync(outputDir, { recursive: true });
  const finalPath = join(outputDir, "final.mp4");
  if (existsSync(finalPath) && statSync(finalPath).size > 4096) {
    return { path: finalPath, ready: true, note: "Using final.mp4 on this PC." };
  }

  const comp =
    (tedverseProject ? getComposition(tedverseProject) : undefined) ?? getCompositionByFlowId(flowProjectId);
  const sceneName = comp?.composition_name ?? (tedverseProject ? filmFinalSceneName(tedverseProject) : "Final");
  if (comp?.composition_id && comp.merge_status === "completed") {
    const stem = join(outputDir, "final");
    const path = await downloadFlowComposition(comp, stem);
    return { path, ready: true, note: `Downloaded "${sceneName}" from Flow.` };
  }

  await openFlowProject(flowProjectId);
  const page = await getFlowPage();
  await ensureProjectGrid(page);
  const assets = await scanGrid(page);
  const finalScene = assets.find(
    (a) =>
      a.kind === "scene" &&
      (a.name === sceneName || (!tedverseProject && /^final$/i.test(a.name.trim()))),
  );
  if (!finalScene) {
    return {
      path: "",
      ready: false,
      note: `No scene named "${sceneName}" in this Flow project. Finish merge in Auto Film first.`,
    };
  }
  const stem = join(outputDir, "final");
  const saved = await downloadScene(page, finalScene, stem, { overwrite: true });
  if (!saved.length) {
    return { path: "", ready: false, note: "Could not download the Final scene from Flow." };
  }
  return { path: saved[0]!, ready: true, note: "Downloaded Final scene from Flow as final.mp4." };
}
