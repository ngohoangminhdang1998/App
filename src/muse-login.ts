#!/usr/bin/env node
// Opens the Muse Chrome profile on https://muse.ai/ — sign in by hand (same model as npm run login for Flow).
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { museProfileDir } from "./providers/platform-config.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KIT = join(ROOT, "third-party", "ai-media-batch-kit");
const kitRequire = createRequire(join(KIT, "package.json"));
const { ensureProfileChrome } = kitRequire("./src/core/chrome.js");

const profileDir = museProfileDir();
mkdirSync(profileDir, { recursive: true });
const port = await ensureProfileChrome({ profileDir, url: "https://muse.ai/", offscreen: false });
console.log(`Chrome is open on https://muse.ai/ (CDP port ${port})`);
console.log(`Muse profile: ${profileDir}`);
console.log("Sign in to Muse in that window. One account should use only this profile.");
process.exit(0);