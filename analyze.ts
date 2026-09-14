/**
 * CLI entry — for the web UI use: npm run dev
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getModelLabel, runAnalysis, type BrandResearchResult } from "./pipeline.js";

const ROOT = dirname(fileURLToPath(import.meta.url));

function printCard(r: BrandResearchResult, meta?: { placementSentiment: string; placementRationale: string }): void {
  const c = r.flashcard;
  console.log(`\n## ${c.brand}`);
  if (meta) {
    console.log(`**Placement:** ${meta.placementSentiment} — ${meta.placementRationale}`);
  }
  console.log(`**Industry:** ${c.industry}`);
  if (c.founded) console.log(`**Founded:** ${c.founded}`);
  if (c.headquarters) console.log(`**Headquarters:** ${c.headquarters}`);
  console.log(`**Grounded in search:** ${c.groundedInSearch ? "yes" : "no"}`);
  console.log(`**Agent attempts:** ${r.attempts}\n${c.summary}\n`);
  console.log("**Key facts:**");
  c.keyFacts.forEach((f) => console.log(`- ${f}`));
  if (c.sources.length) {
    console.log("\n**Sources:**");
    c.sources.forEach((u) => console.log(`- ${u}`));
  }
}

async function main(): Promise<void> {
  const videoArg = process.argv[2];
  if (!videoArg) {
    console.error("Usage: npm run analyze -- <path-to-video>  (or npm run dev for the UI)");
    process.exit(1);
  }
  const videoPath = resolve(videoArg);
  console.log(`Brand Placement Analysis (${getModelLabel()})`);
  console.log(`Video: ${videoPath}`);

  const result = await runAnalysis(videoPath, (event) => {
    if (event.phase === "extracting") console.log("\n[1/4] Extracting frames...");
    if (event.phase === "extracted") console.log(`  ${event.frameCount} frame(s).`);
    if (event.phase === "detecting") console.log("\n[2/4] Detecting brands...");
    if (event.phase === "detected") {
      console.log(`  ${event.brands.length} unique brand(s).`);
      event.brands.forEach((b) => console.log(`  - ${b.name} (${b.confidence})`));
    }
    if (event.phase === "placement") console.log("\n[2b] Rating placement sentiment (visual)…");
    if (event.phase === "placement-done") {
      event.brands.forEach((b) =>
        console.log(`  - ${b.name}: placement ${b.placementSentiment} (${b.placementConfidence})`),
      );
    }
    if (event.phase === "info") console.log(`  ${event.message}`);
    if (event.phase === "rate-limit") console.log(`  [wait] ${event.message}`);
    if (event.phase === "researching") {
      console.log(`\n[3/4] Agent: (${event.index}/${event.total}) ${event.brand}`);
    }
    if (event.phase === "agent-step") {
      const s = event.step;
      if (s.type === "decide") {
        console.log(`  decide: ${s.needsSearch ? "search" : "skip"} — ${s.reason}`);
      } else if (s.type === "draft") {
        console.log(`  draft: groundedInSearch=${s.groundedInSearch}`);
      } else if (s.type === "verdict") {
        const miss = s.missingInfo.length ? `, missing: ${s.missingInfo.join("; ")}` : "";
        console.log(`  verdict: ${s.confidence}${miss}`);
      } else if (s.type === "retry") {
        console.log(`  retry: ${s.hints.join("; ")}`);
      } else if (s.type === "accept") {
        console.log(`  accept: ${s.reason}`);
      }
    }
  });

  if (!result.brandsDetected.length) {
    console.log("\nNo brands detected. Use a clip with visible logos or packaging.");
    return;
  }

  const outputPath = join(ROOT, "output.json");
  await writeFile(outputPath, JSON.stringify(result, null, 2), "utf8");

  console.log("\n[4/4] Results");
  const metaByName = new Map(
    result.brandsDetected.map((b) => [b.name.toLowerCase(), b]),
  );
  result.flashcards.forEach((r) => {
    const meta = metaByName.get(r.flashcard.brand.toLowerCase());
    printCard(
      r,
      meta
        ? {
            placementSentiment: meta.placementSentiment,
            placementRationale: meta.placementRationale,
          }
        : undefined,
    );
  });
  console.log(`\nWrote ${outputPath}`);
}

const entry = process.argv[1] ? resolve(process.argv[1]) : "";
const selfPath = fileURLToPath(import.meta.url);
if (entry === selfPath) {
  main().catch((e: unknown) => {
    console.error(`\nError: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
