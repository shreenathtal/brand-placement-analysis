import { generateObject, type LanguageModel } from "ai";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { geminiCall, type GeminiCallOptions } from "./rateLimit.js";

const PLACEMENT_SAMPLE_FRAMES = 10;

const confidenceLevel = z.enum(["low", "medium", "high"]);
const placementSentiment = z.enum(["positive", "neutral", "negative"]);

const PlacementBatchSchema = z.object({
  ratings: z.array(
    z.object({
      brand: z.string(),
      placementSentiment: placementSentiment,
      placementConfidence: confidenceLevel,
      placementRationale: z.string(),
    }),
  ),
});

export type BrandWithPlacement = {
  name: string;
  confidence: z.infer<typeof confidenceLevel>;
  context: string;
  frameCount: number;
  placementSentiment: z.infer<typeof placementSentiment>;
  placementConfidence: z.infer<typeof confidenceLevel>;
  placementRationale: string;
};

function normalizeBrandKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

function sampleFrames(framePaths: string[], max: number): string[] {
  if (framePaths.length <= max) return framePaths;
  const picked: string[] = [];
  for (let i = 0; i < max; i += 1) {
    const index = Math.floor((i * framePaths.length) / max);
    picked.push(framePaths[index]);
  }
  return picked;
}

export async function ratePlacementInClip<T extends BrandWithPlacement>(
  brands: T[],
  framePaths: string[],
  model: LanguageModel,
  geminiOpts: GeminiCallOptions,
): Promise<T[]> {
  if (!brands.length) return brands;

  const sample = sampleFrames(framePaths, PLACEMENT_SAMPLE_FRAMES);
  const brandList = brands
    .map((b) => `- ${b.name}: ${b.context} (seen in ~${b.frameCount} frame(s))`)
    .join("\n");

  const { object } = await geminiCall(
    () =>
      generateObject({
        model,
        maxRetries: 0,
        schema: PlacementBatchSchema,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Rate how each brand is portrayed in this video clip (placement sentiment), using only visual/on-screen cues. " +
                  "positive = favorable endorsement, celebration, hero placement; " +
                  "negative = criticism, mockery, disaster, villain context; " +
                  "neutral = plain product shot, background, or unclear. " +
                  "If you cannot tell, use neutral with low placementConfidence. " +
                  "One rating per brand below:\n" +
                  brandList,
              },
              ...sample.map((p) => ({
                type: "file" as const,
                data: readFileSync(p),
                mediaType: "image/jpeg" as const,
              })),
            ],
          },
        ],
      }),
    { ...geminiOpts, label: "Rate placement sentiment (all brands)" },
  );

  const byKey = new Map(object.ratings.map((r) => [normalizeBrandKey(r.brand), r]));

  return brands.map((brand) => {
    const rating = byKey.get(normalizeBrandKey(brand.name));
    if (!rating) return brand;
    return {
      ...brand,
      placementSentiment: rating.placementSentiment,
      placementConfidence: rating.placementConfidence,
      placementRationale: rating.placementRationale,
    };
  });
}
