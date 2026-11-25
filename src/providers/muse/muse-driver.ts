import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { museProfileDir } from "../platform-config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const KIT = join(ROOT, "third-party", "ai-media-batch-kit");
const kitRequire = createRequire(import.meta.url);

type MuseFacade = {
  status(): Promise<{ connected: boolean; connecting?: boolean; email: string | null }>;
  generateImage(b: {
    prompt: string;
    aspect?: string;
    refs?: { path: string }[];
    carryCharacter?: boolean;
    previousFrame?: boolean;
    newChat?: boolean;
  }): Promise<{ buffer: Buffer; contentType: string; width: number; height: number }>;
  generateVideo(b: {
    prompt: string;
    refs?: { path: string }[];
    carryCharacter?: boolean;
    newChat?: boolean;
    durationSec?: number;
  }): Promise<{ buffer: Buffer; contentType: string; width: number; height: number }>;
  close(): void;
};

type CreateMuse = (o: { profileDir: string; show?: boolean; lang?: "vi" | "en"; log?: (s: string) => void }) => MuseFacade;

let facade: MuseFacade | null = null;

function loadCreateMuse(): CreateMuse {
  const mod = kitRequire(join(KIT, "muse.cjs")) as { createMuse: CreateMuse };
  return mod.createMuse;
}

export function getMuse(show = false, lang: "vi" | "en" = "en"): MuseFacade {
  if (!facade || show) {
    const createMuse = loadCreateMuse();
    facade = createMuse({
      profileDir: museProfileDir(),
      show,
      lang,
      log: process.env.FLOW_MCP_DEBUG === "1" ? (s) => console.error("[muse]", s) : undefined,
    });
  }
  return facade;
}

async function presentMuseChromeWindow(port: number) {
  const { connectBrowser } = kitRequire(join(KIT, "cdp.cjs")) as {
    connectBrowser: (p: number) => Promise<{ close: () => void }>;
  };
  const { showWindow } = kitRequire(join(KIT, "window.cjs")) as { showWindow: (c: { close: () => void }) => Promise<void> };
  const client = await connectBrowser(port);
  try {
    await showWindow(client);
  } finally {
    client.close();
  }
}

/** Opens the Muse Chrome profile on muse.ai (visible window) without waiting on Muse chat status. */
export async function openMuseBrowser() {
  const { ensureProfileChrome } = kitRequire(join(KIT, "chrome.cjs")) as {
    ensureProfileChrome: (o: { profileDir: string; url?: string; offscreen?: boolean }) => Promise<number>;
  };
  const profileDir = museProfileDir();
  mkdirSync(profileDir, { recursive: true });
  const port = await ensureProfileChrome({ profileDir, url: "https://muse.ai/", offscreen: false });
  await presentMuseChromeWindow(port);
}

export async function presentMuseLoginWindow(port: number) {
  await presentMuseChromeWindow(port);
}

export async function museStatus() {
  const m = getMuse(false);
  return m.status();
}

export function closeMuse() {
  facade?.close();
  facade = null;
}