import { createGoogleGenerativeAI, google } from "@ai-sdk/google";
import { generateObject, generateText, Output, type LanguageModel } from "ai";
import { config } from "dotenv";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import { isAnalysisAborted, throwIfAborted } from "./abort.js";
import { shouldRetryForVerdict, VERDICT_SYSTEM_PROMPT } from "./agentVerdict.js";
import { ratePlacementInClip } from "./placement.js";
import {
  geminiCall,
  getGeminiCallCount,
  isGeminiQuotaError,
  resetGeminiCallBudget,
  type GeminiCallOptions,
} from "./rateLimit.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
config({ path: join(ROOT, ".env") });

const execFileAsync = promisify(execFile);
const DEFAULT_MODEL = "gemini-3.1-flash-lite";
const MAX_RESEARCH_ATTEMPTS = 2;
const MAX_FRAMES_PER_CALL = 12;

const confidenceLevel = z.enum(["low", "medium", "high"]);

const BrandDetectionSchema = z.object({
  brands: z.array(
    z.object({ name: z.string(), confidence: confidenceLevel, context: z.string() }),
  ),
});
const SearchDecisionSchema = z.object({ needsSearch: z.boolean(), reason: z.string() });
const FlashcardContentSchema = z.object({
  brand: z.string(),
  summary: z.string(),
  industry: z.string(),
  founded: z.string().optional(),
  headquarters: z.string().optional(),
  keyFacts: z.array(z.string()).min(1).max(8),
});
const VerdictSchema = z.object({
  confidence: confidenceLevel,
  missingInfo: z.array(z.string()),
});

type DetectedBrand = z.infer<typeof BrandDetectionSchema>["brands"][number];

export type AggregatedBrand = {
  name: string;
  confidence: z.infer<typeof confidenceLevel>;
  context: string;
  frameCount: number;
  placementSentiment: "positive" | "neutral" | "negative";
  placementConfidence: z.infer<typeof confidenceLevel>;
  placementRationale: string;
};

type FlashcardContent = z.infer<typeof FlashcardContentSchema>;

export type Flashcard = FlashcardContent & { groundedInSearch: boolean; sources: string[] };

export type AgentStepLog =
  | { type: "decide"; needsSearch: boolean; reason: string }
  | { type: "draft"; groundedInSearch: boolean }
  | { type: "verdict"; confidence: z.infer<typeof confidenceLevel>; missingInfo: string[] }
  | { type: "retry"; hints: string[] }
  | { type: "accept"; reason: string };

export type BrandResearchResult = {
  flashcard: Flashcard;
  attempts: number;
  steps: AgentStepLog[];
};

export type AnalysisResult = {
  videoPath: string;
  frameCount: number;
  brandsDetected: AggregatedBrand[];
  flashcards: BrandResearchResult[];
  generatedAt: string;
  /** True when the user stopped early; flashcards may be incomplete. */
  stoppedEarly?: boolean;
};

export type ProgressEvent =
  | { phase: "extracting" }
  | { phase: "extracted"; frameCount: number }
  | { phase: "detecting" }
  | { phase: "detected"; brands: AggregatedBrand[] }
  | { phase: "placement" }
  | { phase: "placement-done"; brands: AggregatedBrand[] }
  | { phase: "rate-limit"; message: string }
  | { phase: "info"; message: string }
  | { phase: "researching"; brand: string; index: number; total: number }
  | { phase: "agent-step"; brand: string; step: AgentStepLog }
  | { phase: "complete" }
  | { phase: "stopped" };

export type ProgressHandler = (event: ProgressEvent) => void;

export type RunAnalysisOptions = {
  signal?: AbortSignal;
  /** Extra vision call for placement sentiment. Default false (saves quota). */
  includePlacementSentiment?: boolean;
  /** Google Search grounding (heavy; often hits RPM on free tier). Default false. */
  allowGoogleSearch?: boolean;
};

function placementEnabled(options?: RunAnalysisOptions): boolean {
  if (options?.includePlacementSentiment === true) return true;
  if (options?.includePlacementSentiment === false) return false;
  return process.env.RUN_PLACEMENT_SENTIMENT === "true";
}

function googleSearchEnabled(options?: RunAnalysisOptions): boolean {
  if (options?.allowGoogleSearch === true) return true;
  if (options?.allowGoogleSearch === false) return false;
  return process.env.ENABLE_GOOGLE_SEARCH === "true";
}

const SEARCH_DECISION_PROMPT =
  "Decide if Google Search is needed before writing a brand flashcard.\n" +
  "needsSearch=false for well-known consumer brands you can summarize from training data: global icons (Coca-Cola, Nike) AND major national/regional giants (e.g. Parle-G, Amul, Tata, Unilever brands, Bud Light, General Mills, Goodyear).\n" +
  "needsSearch=true only for obscure, local, or uncertain names where you would likely invent facts without lookup.\n" +
  "Prefer needsSearch=false when the brand is clearly recognizable.\n\n";

function getApiKey(): string {
  const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not set. Copy .env.example to .env in this folder and add your key.",
    );
  }
  return apiKey;
}

function getModel(): LanguageModel {
  return createGoogleGenerativeAI({ apiKey: getApiKey() })(
    process.env.GEMINI_MODEL ?? DEFAULT_MODEL,
  );
}

export function getModelLabel(): string {
  return process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function normalizeBrandKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

const CONF_RANK: Record<AggregatedBrand["confidence"], number> = {
  low: 0,
  medium: 1,
  high: 2,
};

function defaultPlacement(): Pick<
  AggregatedBrand,
  "placementSentiment" | "placementConfidence" | "placementRationale"
> {
  return {
    placementSentiment: "neutral",
    placementConfidence: "low",
    placementRationale: "Placement analysis disabled.",
  };
}

function aggregateBrands(detections: DetectedBrand[]): AggregatedBrand[] {
  const byKey = new Map<string, AggregatedBrand>();
  for (const d of detections) {
    const name = d.name.trim();
    if (!name) continue;
    const key = normalizeBrandKey(name);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, {
        name,
        confidence: d.confidence,
        context: d.context,
        frameCount: 1,
        ...defaultPlacement(),
      });
      continue;
    }
    byKey.set(key, {
      name: prev.name,
      confidence: CONF_RANK[d.confidence] > CONF_RANK[prev.confidence] ? d.confidence : prev.confidence,
      context: CONF_RANK[d.confidence] >= CONF_RANK[prev.confidence] ? d.context : prev.context,
      frameCount: prev.frameCount + 1,
      placementSentiment: prev.placementSentiment,
      placementConfidence: prev.placementConfidence,
      placementRationale: prev.placementRationale,
    });
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function rateOpts(onProgress?: ProgressHandler, signal?: AbortSignal): GeminiCallOptions {
  return {
    signal,
    onWait: (message) => onProgress?.({ phase: "rate-limit", message }),
    onCall: (n, label) => {
      const detail = label ? `API #${n}: ${label}` : `API #${n}`;
      onProgress?.({ phase: "info", message: detail });
    },
  };
}

async function extractFrames(videoPath: string): Promise<{ directory: string; paths: string[] }> {
  try {
    await execFileAsync("ffmpeg", ["-version"]);
  } catch {
    throw new Error("ffmpeg not found. Install: brew install ffmpeg");
  }
  const directory = await mkdtemp(join(tmpdir(), "brand-placement-frames-"));
  const pattern = join(directory, "frame_%03d.jpg");
  await execFileAsync("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-vf",
    "fps=1",
    pattern,
  ]);
  const paths = (await readdir(directory))
    .filter((n) => n.endsWith(".jpg"))
    .sort()
    .map((n) => join(directory, n));
  if (!paths.length) {
    await rm(directory, { recursive: true, force: true });
    throw new Error("No frames extracted. Check video format and duration.");
  }
  return { directory, paths };
}

async function detectBrandsFromFrames(
  framePaths: string[],
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<DetectedBrand[]> {
  const model = getModel();
  const all: DetectedBrand[] = [];
  for (const batch of chunk(framePaths, MAX_FRAMES_PER_CALL)) {
    throwIfAborted(signal);
    const frameList = batch.map((p) => basename(p)).join(", ");
    const { object } = await geminiCall(
      () =>
        generateObject({
          model,
          maxRetries: 0,
          schema: BrandDetectionSchema,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Find visible brands (logos, packaging, signage, on-screen text) in these video frames. " +
                    `Frames: ${frameList}. Return each brand with confidence and visual context. ` +
                    "No guesses; empty array if none.",
                },
                ...batch.map((p) => ({
                  type: "file" as const,
                  data: readFileSync(p),
                  mediaType: "image/jpeg" as const,
                })),
              ],
            },
          ],
        }),
      { ...rateOpts(onProgress, signal), label: "Detect brands in frame batch" },
    );
    all.push(...object.brands);
  }
  return all;
}

function brandContext(brand: AggregatedBrand): string {
  return (
    `Brand: ${brand.name}. Video context: ${brand.context}. Detection confidence: ${brand.confidence}. ` +
    `Placement: ${brand.placementSentiment} (${brand.placementConfidence}) — ${brand.placementRationale}. ` +
    `Frames: ${brand.frameCount}.`
  );
}

function sourceUrls(sources: Awaited<ReturnType<typeof generateText>>["sources"]): string[] {
  const urls: string[] = [];
  for (const s of sources) {
    if (s.sourceType === "url" && s.url) urls.push(s.url);
  }
  return [...new Set(urls)];
}

async function draftFlashcardNoSearch(
  brand: AggregatedBrand,
  refinement: string,
  opts: GeminiCallOptions,
): Promise<FlashcardContent> {
  const { object } = await geminiCall(
    () =>
      generateObject({
        model: getModel(),
        maxRetries: 0,
        schema: FlashcardContentSchema,
        prompt:
          "Write a concise educational flashcard from training knowledge only; omit uncertain fields." +
          refinement +
          "\n\n" +
          brandContext(brand),
      }),
    { ...opts, label: `${brand.name}: draft flashcard (no search)` },
  );
  return { ...object, brand: object.brand.trim() || brand.name };
}

async function researchBrand(
  brand: AggregatedBrand,
  allowSearch: boolean,
  onStep?: (step: AgentStepLog) => void,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<BrandResearchResult> {
  const steps: AgentStepLog[] = [];
  let refineHints: string[] = [];
  let draft: FlashcardContent | null = null;
  let groundedInSearch = false;
  let sources: string[] = [];
  let attempt = 0;
  let searchChosenOnFirstPass = false;
  const opts = rateOpts(onProgress, signal);

  const emit = (step: AgentStepLog) => {
    steps.push(step);
    onStep?.(step);
  };

  try {
  while (attempt < MAX_RESEARCH_ATTEMPTS) {
    throwIfAborted(signal);
    attempt += 1;
    let useSearch = false;
    if (attempt === 1) {
      if (!allowSearch) {
        emit({
          type: "decide",
          needsSearch: false,
          reason: "Google Search is off for this run (recommended on free tier).",
        });
        searchChosenOnFirstPass = false;
        useSearch = false;
      } else {
        const { object: decision } = await geminiCall(
          () =>
            generateObject({
              model: getModel(),
              maxRetries: 0,
              schema: SearchDecisionSchema,
              prompt: SEARCH_DECISION_PROMPT + brandContext(brand),
            }),
          { ...opts, label: `${brand.name}: decide if web search is needed` },
        );
        emit({ type: "decide", needsSearch: decision.needsSearch, reason: decision.reason });
        searchChosenOnFirstPass = decision.needsSearch;
        useSearch = decision.needsSearch;
      }
    } else {
      emit({ type: "retry", hints: refineHints });
      // Verdict retry refines the draft; do not force Google Search if pass 1 skipped it.
      useSearch = searchChosenOnFirstPass;
    }

    const refinement =
      refineHints.length > 0 ? ` Address gaps: ${refineHints.join("; ")}.` : "";

    if (useSearch) {
      const modelName = process.env.GEMINI_MODEL ?? DEFAULT_MODEL;
      try {
        const result = await geminiCall(
          () =>
            generateText({
              model: createGoogleGenerativeAI({ apiKey: getApiKey() })(modelName),
              maxRetries: 0,
              tools: { google_search: google.tools.googleSearch({}) },
              output: Output.object({ schema: FlashcardContentSchema }),
              prompt:
                "Use Google Search, then write a concise educational flashcard (summary, industry, 3-6 key facts)." +
                refinement +
                "\n\n" +
                brandContext(brand),
            }),
          {
            ...opts,
            maxQuotaRetries: 1,
            label: `${brand.name}: draft flashcard + Google Search (heavy quota)`,
          },
        );
        draft = { ...result.output, brand: result.output.brand.trim() || brand.name };
        sources = sourceUrls(result.sources);
        groundedInSearch = true;
      } catch (error) {
        if (!isGeminiQuotaError(error)) throw error;
        onProgress?.({
          phase: "info",
          message:
            "Google blocked search (429/quota) — not retrying. Writing flashcard from model knowledge instead.",
        });
        draft = await draftFlashcardNoSearch(brand, refinement, opts);
        sources = [];
        groundedInSearch = false;
      }
    } else {
      draft = await draftFlashcardNoSearch(brand, refinement, opts);
      sources = [];
      groundedInSearch = false;
    }
    emit({ type: "draft", groundedInSearch });

    const { object: verdict } = await geminiCall(
      () =>
        generateObject({
          model: getModel(),
          maxRetries: 0,
          schema: VerdictSchema,
          prompt:
            `${VERDICT_SYSTEM_PROMPT}\n\n` +
            brandContext(brand) +
            `\nSearch used: ${groundedInSearch}\nDraft:\n${JSON.stringify(draft)}`,
        }),
      { ...opts, label: `${brand.name}: self-check flashcard quality` },
    );
    emit({
      type: "verdict",
      confidence: verdict.confidence,
      missingInfo: verdict.missingInfo,
    });

    const retryPlan = shouldRetryForVerdict(
      verdict.confidence,
      verdict.missingInfo,
      attempt,
      MAX_RESEARCH_ATTEMPTS,
    );

    if (!retryPlan.retry) {
      if (verdict.confidence === "low" && verdict.missingInfo.length > 0) {
        emit({
          type: "accept",
          reason:
            "Skipped retry — gaps were about the video/scene, not brand facts on the flashcard.",
        });
      }
      break;
    }

    refineHints = retryPlan.hints;
  }
  } catch (error) {
    if (isAnalysisAborted(error) && draft) {
      emit({
        type: "accept",
        reason: "Stopped — using latest draft for this brand.",
      });
      return {
        attempts: attempt,
        steps,
        flashcard: { ...draft, groundedInSearch, sources },
      };
    }
    throw error;
  }

  if (!draft) throw new Error(`Failed flashcard for ${brand.name}`);
  return {
    attempts: attempt,
    steps,
    flashcard: { ...draft, groundedInSearch, sources },
  };
}

async function researchAllBrands(
  brands: AggregatedBrand[],
  allowSearch: boolean,
  onProgress?: ProgressHandler,
  signal?: AbortSignal,
): Promise<BrandResearchResult[]> {
  const results: BrandResearchResult[] = [];
  for (let i = 0; i < brands.length; i += 1) {
    try {
      throwIfAborted(signal);
      const brand = brands[i];
      onProgress?.({
        phase: "researching",
        brand: brand.name,
        index: i + 1,
        total: brands.length,
      });
      const r = await researchBrand(
        brand,
        allowSearch,
        (step) => {
          onProgress?.({ phase: "agent-step", brand: brand.name, step });
        },
        onProgress,
        signal,
      );
      results.push(r);
    } catch (error) {
      if (isAnalysisAborted(error)) return results;
      throw error;
    }
  }
  return results;
}

export async function runAnalysis(
  videoPath: string,
  onProgress?: ProgressHandler,
  options?: RunAnalysisOptions,
): Promise<AnalysisResult> {
  const signal = options?.signal;
  const includePlacement = placementEnabled(options);
  const allowSearch = googleSearchEnabled(options);
  resetGeminiCallBudget();
  throwIfAborted(signal);

  let brands: AggregatedBrand[] = [];
  let flashcards: BrandResearchResult[] = [];
  let frameCount = 0;
  let stoppedEarly = false;

  onProgress?.({ phase: "extracting" });
  const frames = await extractFrames(videoPath);
  frameCount = frames.paths.length;
  onProgress?.({ phase: "extracted", frameCount });

  try {
    try {
      onProgress?.({ phase: "detecting" });
      brands = aggregateBrands(
        await detectBrandsFromFrames(frames.paths, onProgress, signal),
      );
      onProgress?.({ phase: "detected", brands });

      const detectBatches = Math.ceil(frames.paths.length / MAX_FRAMES_PER_CALL);
      const placementCalls = includePlacement && brands.length > 0 ? 1 : 0;
      const decideCalls = allowSearch && brands.length > 0 ? brands.length : 0;
      const estMinCalls =
        detectBatches + placementCalls + decideCalls + brands.length * 2;
      const placementNote = includePlacement ? "placement 1" : "placement off";
      const searchNote = allowSearch ? "search optional" : "search off";
      onProgress?.({
        phase: "info",
        message:
          `Plan: ~${estMinCalls}+ Gemini calls (detect ${detectBatches}, ${placementNote}, ${searchNote}, draft+verdict per brand). ` +
          `No automatic 429 retries on search. Calls so far: ${getGeminiCallCount()}.`,
      });

      if (brands.length > 0 && includePlacement) {
        onProgress?.({ phase: "placement" });
        brands = await ratePlacementInClip(
          brands,
          frames.paths,
          getModel(),
          rateOpts(onProgress, signal),
        );
        onProgress?.({ phase: "placement-done", brands });
      }

      flashcards =
        brands.length > 0
          ? await researchAllBrands(brands, allowSearch, onProgress, signal)
          : [];

      stoppedEarly =
        signal?.aborted === true ||
        (brands.length > 0 && flashcards.length < brands.length);

      const result: AnalysisResult = {
        videoPath,
        frameCount,
        brandsDetected: brands,
        flashcards,
        generatedAt: new Date().toISOString(),
        stoppedEarly,
      };
      onProgress?.({ phase: stoppedEarly ? "stopped" : "complete" });
      return result;
    } catch (error) {
      if (!isAnalysisAborted(error)) throw error;
      stoppedEarly = true;
      onProgress?.({ phase: "stopped" });
      if (flashcards.length === 0 && brands.length === 0) {
        throw error;
      }
      return {
        videoPath,
        frameCount,
        brandsDetected: brands,
        flashcards,
        generatedAt: new Date().toISOString(),
        stoppedEarly: true,
      };
    }
  } finally {
    await rm(frames.directory, { recursive: true, force: true });
  }
}
