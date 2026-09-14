import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ASSETS = join(ROOT, "samples/clips/assets");
const SEGMENTS = join(ROOT, "samples/clips/segments");
const OUT = join(ROOT, "samples/clips/obscure-brands-test.mp4");

const BRANDS = ["Cheerwine", "Moxie", "Vernors", "Faygo", "Sun Drop"];

function svgForBrand(brand) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
  <rect width="100%" height="100%" fill="#1a2332"/>
  <text x="640" y="320" text-anchor="middle" fill="#e8eef7" font-size="72" font-family="Arial, Helvetica, sans-serif">${brand}</text>
  <text x="640" y="400" text-anchor="middle" fill="#9aa8bc" font-size="28" font-family="Arial, Helvetica, sans-serif">Regional beverage brand</text>
</svg>`;
}

function safeName(brand) {
  return brand.toLowerCase().replace(/\s+/g, "_");
}

async function main() {
  await rm(ASSETS, { recursive: true, force: true });
  await rm(SEGMENTS, { recursive: true, force: true });
  await mkdir(ASSETS, { recursive: true });
  await mkdir(SEGMENTS, { recursive: true });

  const concatLines = [];

  for (const brand of BRANDS) {
    const key = safeName(brand);
    const png = join(ASSETS, `${key}.png`);
    await sharp(Buffer.from(svgForBrand(brand))).png().toFile(png);

    const seg = join(SEGMENTS, `${key}.mp4`);
    await execFileAsync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-loop",
      "1",
      "-t",
      "3.5",
      "-i",
      png,
      "-vf",
      "format=yuv420p",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      seg,
    ]);
    concatLines.push(`file '${seg}'`);
  }

  const listPath = join(SEGMENTS, "concat.txt");
  await writeFile(listPath, concatLines.join("\n"), "utf8");

  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listPath,
    "-c",
    "copy",
    OUT,
  ]);

  console.log(`\nWrote ${OUT}`);
  console.log(`Run: npm run analyze -- ${OUT}`);
  console.log("Or upload in UI: npm run dev");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
