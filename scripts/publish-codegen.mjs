#!/usr/bin/env node
/**
 * Open Playwright Codegen against the Flow Chrome profile for selector discovery.
 * Does not auto-publish — record by hand, then port stable locators into src/publish/platforms/*.
 *
 * Usage:
 *   node scripts/publish-codegen.mjs tiktok|youtube|facebook
 *
 * Requires Chrome with CDP on 9333 (npm run login / normal Flow Chrome).
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const start = {
  tiktok: "https://www.tiktok.com/tiktokstudio",
  youtube: "https://studio.youtube.com",
  facebook: "https://business.facebook.com",
};

const platform = process.argv[2] ?? "youtube";
const url = start[platform];
if (!url) {
  console.error("Usage: node scripts/publish-codegen.mjs tiktok|youtube|facebook");
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const chrome = process.env.FLOW_MCP_CHROME_EXE;
const userData =
  process.env.FLOW_MCP_CHROME_USER_DATA ??
  join(process.env.USERPROFILE || process.env.HOME || "", ".flow-mcp", "chrome-profile");

console.error(`Codegen → ${url}`);
console.error("Sign in manually. Do not submit real posts unless you intend to.");
console.error(`Profile: ${userData}`);

const args = [
  "playwright",
  "codegen",
  url,
  "--browser=chromium",
  ...(chrome ? [`--channel=chrome`] : []),
];
const env = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH };

const child = spawn("npx", args, { cwd: root, stdio: "inherit", env, shell: true });
child.on("exit", (code) => process.exit(code ?? 0));