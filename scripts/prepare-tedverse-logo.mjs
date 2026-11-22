/**
 * Rebuilds studio/assets/* from a source PNG (trim + mascot crop + favicons).
 * Usage: node scripts/prepare-tedverse-logo.mjs path/to/logo.png
 */
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "studio", "assets");
const src = process.argv[2];
if (!src || !existsSync(src)) {
  console.error("Usage: node scripts/prepare-tedverse-logo.mjs <source.png>");
  process.exit(1);
}
mkdirSync(out, { recursive: true });
const trimmed = await sharp(src).trim({ threshold: 12 }).toBuffer();
const { width, height } = await sharp(trimmed).metadata();
const mascotH = Math.min(Math.round(height * 0.58), height);
await sharp(trimmed).png({ compressionLevel: 9, adaptiveFiltering: true }).toFile(join(out, "tedverse-logo.png"));
const mascot = await sharp(trimmed)
  .extract({ left: 0, top: 0, width, height: mascotH })
  .resize(512, 512, { fit: "contain", background: { r: 5, g: 5, b: 8, alpha: 0 } })
  .png({ compressionLevel: 9 })
  .toBuffer();
await sharp(mascot).toFile(join(out, "tedverse-mascot.png"));
for (const [name, size] of [
  ["favicon-32.png", 32],
  ["favicon-192.png", 192],
  ["apple-touch-icon.png", 180],
]) {
  await sharp(mascot).resize(size, size, { fit: "contain", background: { r: 5, g: 5, b: 8, alpha: 0 } }).toFile(join(out, name));
}
console.log(`Wrote TedVerse assets to ${out} (${width}x${height} lockup)`);