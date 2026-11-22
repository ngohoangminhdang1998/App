import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { HOME_DIR } from "../chrome.js";
import type { ProviderId } from "./types.js";

const FILE = join(HOME_DIR, "provider.json");

export type ProviderConfig = {
  provider: ProviderId;
  updatedAt: string;
};

export function museProfileDir(): string {
  return join(HOME_DIR, "muse-chrome-profile");
}

export function readProviderConfig(): ProviderConfig {
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf8")) as ProviderConfig;
    if (raw.provider === "muse" || raw.provider === "google-flow") return raw;
  } catch {
    /* first run */
  }
  return { provider: "google-flow", updatedAt: new Date(0).toISOString() };
}

export function getActiveProviderId(): ProviderId {
  return readProviderConfig().provider;
}

export function writeProviderConfig(provider: ProviderId): ProviderConfig {
  mkdirSync(HOME_DIR, { recursive: true });
  const next: ProviderConfig = { provider, updatedAt: new Date().toISOString() };
  writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export function providerConfigExists(): boolean {
  return existsSync(FILE);
}