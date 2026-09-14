/**
 * Verdict / retry helpers — flashcard facts only, not video provenance.
 */

const VIDEO_SCOPE_GAP =
  /\b(video|movie|film|tv|television|show|scene|truck|destruction|footage|clip|source|context of|verify the exact|manufacturing details|box variant|packaging shown)\b/i;

export function actionableFlashcardGaps(missingInfo: string[]): string[] {
  return missingInfo.filter((item) => {
    const trimmed = item.trim();
    if (!trimmed) return false;
    return !VIDEO_SCOPE_GAP.test(trimmed);
  });
}

export function shouldRetryForVerdict(
  confidence: "low" | "medium" | "high",
  missingInfo: string[],
  attempt: number,
  maxAttempts: number,
): { retry: boolean; hints: string[] } {
  if (confidence !== "low" || attempt >= maxAttempts) {
    return { retry: false, hints: [] };
  }
  const hints = actionableFlashcardGaps(missingInfo);
  if (hints.length === 0) {
    return { retry: false, hints: [] };
  }
  return { retry: true, hints };
}

export const VERDICT_SYSTEM_PROMPT =
  "You review a BRAND FLASHCARD only (company summary, industry, HQ, founded, key business facts). " +
  "Do NOT require identifying the video, movie, TV show, scene, truck, or packaging variant. " +
  "confidence=low ONLY if core brand facts on the card are wrong, missing, or clearly invented. " +
  "If the card is a reasonable overview of the brand, use confidence=medium or high. " +
  "missingInfo must list only brand/company facts that web search could improve — never video provenance.";
