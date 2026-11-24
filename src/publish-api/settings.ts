import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "../chrome.js";
import type { PublishPlatform } from "../publish.js";

export type PublishEngine = "browser" | "api";

export type PlatformApiFields = {
  clientId?: string;
  clientSecret?: string;
  /** Meta uses appId naming in their console */
  appId?: string;
  appSecret?: string;
  /** TikTok console labels this Client key */
  clientKey?: string;
  pageId?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: string;
  openId?: string;
  channelId?: string;
  channelTitle?: string;
  pageName?: string;
};

export type PublishApiStore = {
  engine: PublishEngine;
  youtube: PlatformApiFields;
  facebook: PlatformApiFields;
  tiktok: PlatformApiFields;
};

const FILE = join(HOME_DIR, "publish-api.json");

const emptyPlatform = (): PlatformApiFields => ({});

const defaultStore = (): PublishApiStore => ({
  engine: "api",
  youtube: emptyPlatform(),
  facebook: emptyPlatform(),
  tiktok: emptyPlatform(),
});

function loadRaw(): PublishApiStore {
  try {
    if (!existsSync(FILE)) return defaultStore();
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as Partial<PublishApiStore>;
    const base = defaultStore();
    return {
      engine: raw.engine === "api" ? "api" : "browser",
      youtube: { ...base.youtube, ...(raw.youtube || {}) },
      facebook: { ...base.facebook, ...(raw.facebook || {}) },
      tiktok: { ...base.tiktok, ...(raw.tiktok || {}) },
    };
  } catch {
    return defaultStore();
  }
}

export function loadPublishApiSettings(): PublishApiStore {
  return loadRaw();
}

export function savePublishApiSettings(patch: Partial<PublishApiStore> & { platform?: PublishPlatform; fields?: PlatformApiFields }) {
  const cur = loadRaw();
  if (patch.engine) cur.engine = patch.engine === "api" ? "api" : "browser";
  if (patch.youtube) cur.youtube = { ...cur.youtube, ...patch.youtube };
  if (patch.facebook) cur.facebook = { ...cur.facebook, ...patch.facebook };
  if (patch.tiktok) cur.tiktok = { ...cur.tiktok, ...patch.tiktok };
  if (patch.platform && patch.fields) {
    cur[patch.platform] = { ...cur[patch.platform], ...patch.fields };
  }
  mkdirSync(HOME_DIR, { recursive: true });
  const tmp = `${FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(cur, null, 2), { mode: 0o600 });
  renameSync(tmp, FILE);
  return cur;
}

export function platformFields(store: PublishApiStore, platform: PublishPlatform): PlatformApiFields {
  return store[platform];
}

function maskSecret(v?: string) {
  if (!v) return "";
  if (v.length <= 8) return "••••";
  return `${"•".repeat(Math.min(12, v.length - 4))}${v.slice(-4)}`;
}

export function publicPublishApiSettings() {
  const s = loadRaw();
  const map = (p: PlatformApiFields, useAppId = false) => ({
    clientId: p.clientId || (useAppId ? p.appId : "") || (p.clientKey ?? ""),
    clientSecret: maskSecret(p.clientSecret || p.appSecret),
    pageId: p.pageId ?? "",
    channelId: p.channelId ?? "",
    channelTitle: p.channelTitle ?? "",
    pageName: p.pageName ?? "",
    connected: Boolean(p.refreshToken || p.accessToken),
    openId: p.openId ? `${p.openId.slice(0, 4)}…` : "",
  });
  return {
    engine: s.engine,
    youtube: map(s.youtube),
    facebook: map(s.facebook, true),
    tiktok: { ...map(s.tiktok), clientId: s.tiktok.clientKey ?? s.tiktok.clientId ?? "" },
  };
}

export function clearPlatformTokens(platform: PublishPlatform) {
  const cur = loadRaw();
  const keep: PlatformApiFields = {
    clientId: cur[platform].clientId,
    clientSecret: cur[platform].clientSecret,
    appId: cur[platform].appId,
    appSecret: cur[platform].appSecret,
    clientKey: cur[platform].clientKey,
    pageId: cur[platform].pageId,
  };
  cur[platform] = keep;
  savePublishApiSettings(cur);
}