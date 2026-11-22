// Copy built film-script.js into studio/ for static hosts (Vercel).
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "dist/film-script.js");
const dest = join(root, "studio/film-script.js");
if (!existsSync(src)) {
  console.error("Missing dist/film-script.js — run npm run build first.");
  process.exit(1);
}
copyFileSync(src, dest);
console.log("Copied film-script.js → studio/ for static deploy.");