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

export async function museStatus() {
  const m = getMuse(false);
  return m.status();
}

export function closeMuse() {
  facade?.close();
  facade = null;
}