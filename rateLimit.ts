/**
 * Gemini free tier: ~15 generateContent requests per rolling minute (model-dependent).
 * Uses a sliding 60s window + minimum spacing + cooldown after quota errors.
 */

import { isAnalysisAborted, sleepAbortable, throwIfAborted } from "./abort.js";

const WINDOW_MS = 60_000;
const DEFAULT_MIN_INTERVAL_MS = 5000;
/** Stay under Google’s 15 RPM (dashboard shows hard cap at 15 for 3.5 Flash Lite). */
const DEFAULT_MAX_REQUESTS_PER_MINUTE = 10;
/** Retries after Google 429 per API call (each retry burns quota and RPM). */
const DEFAULT_MAX_QUOTA_RETRIES = 1;
const MIN_COOLDOWN_AFTER_QUOTA_MS = 55_000;

/** Timestamps (ms) when we started a Gemini request in the last minute. */
const requestStartedAt: number[] = [];

let lastSlotAt = 0;
let cooldownUntil = 0;
let geminiCallCount = 0;

/** Reset at the start of each video analysis run. */
export function resetGeminiCallBudget(): void {
  geminiCallCount = 0;
  requestStartedAt.length = 0;
  lastSlotAt = 0;
  cooldownUntil = 0;
}

export function getGeminiCallCount(): number {
  return geminiCallCount;
}

function minIntervalMs(): number {
  const raw = process.env.GEMINI_MIN_INTERVAL_MS;
  if (!raw) return DEFAULT_MIN_INTERVAL_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_MIN_INTERVAL_MS;
}

function maxRequestsPerMinute(): number {
  const raw = process.env.GEMINI_MAX_REQUESTS_PER_MINUTE;
  if (!raw) return DEFAULT_MAX_REQUESTS_PER_MINUTE;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_REQUESTS_PER_MINUTE;
  return Math.min(Math.floor(parsed), 14);
}

function pruneWindow(now: number): void {
  while (requestStartedAt.length > 0 && requestStartedAt[0] <= now - WINDOW_MS) {
    requestStartedAt.shift();
  }
}

export function isGeminiQuotaError(error: unknown): boolean {
  if (isAnalysisAborted(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  return (
    lower.includes("quota") ||
    lower.includes("rate limit") ||
    lower.includes("rate-limit") ||
    lower.includes("429") ||
    lower.includes("resource_exhausted")
  );
}

function parseRetryAfterMs(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  const match = /retry in ([\d.]+)s/i.exec(message);
  if (match) {
    return Math.ceil(Number.parseFloat(match[1]) * 1000) + 1500;
  }
  return 30_000;
}

async function acquireSlot(
  onWait?: (message: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const maxRpm = maxRequestsPerMinute();
  const minGap = minIntervalMs();

  while (true) {
    throwIfAborted(signal);
    const now = Date.now();

    if (cooldownUntil > now) {
      const wait = cooldownUntil - now;
      onWait?.(`API cooldown ${Math.ceil(wait / 1000)}s after rate limit…`);
      await sleepAbortable(wait, signal);
      continue;
    }

    pruneWindow(now);

    if (requestStartedAt.length >= maxRpm) {
      const oldest = requestStartedAt[0];
      const wait = oldest + WINDOW_MS - now + 500;
      onWait?.(
        `RPM budget (${maxRpm}/min) — waiting ${Math.ceil(wait / 1000)}s for rolling window…`,
      );
      await sleepAbortable(wait, signal);
      continue;
    }

    if (lastSlotAt > 0) {
      const sinceLast = now - lastSlotAt;
      if (sinceLast < minGap) {
        const wait = minGap - sinceLast;
        onWait?.(`Spacing API calls — waiting ${Math.ceil(wait / 1000)}s…`);
        await sleepAbortable(wait, signal);
        continue;
      }
    }

    const slotAt = Date.now();
    lastSlotAt = slotAt;
    requestStartedAt.push(slotAt);
    return;
  }
}

export type GeminiCallOptions = {
  onWait?: (message: string) => void;
  label?: string;
  onCall?: (callNumber: number, label?: string) => void;
  signal?: AbortSignal;
  /** Attempts including the first try. Default 1 = no retry on 429. */
  maxQuotaRetries?: number;
};

function resolveMaxQuotaRetries(options?: GeminiCallOptions): number {
  if (options?.maxQuotaRetries !== undefined) {
    return Math.max(1, Math.min(5, Math.floor(options.maxQuotaRetries)));
  }
  const raw = process.env.GEMINI_MAX_QUOTA_RETRIES;
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 1) {
      return Math.min(5, Math.floor(parsed));
    }
  }
  return DEFAULT_MAX_QUOTA_RETRIES;
}

/**
 * Wrap every Gemini generateObject / generateText call.
 * Inner SDK calls must use maxRetries: 0 so the SDK does not spam retries on 429.
 */
export async function geminiCall<T>(
  fn: () => Promise<T>,
  options?: GeminiCallOptions,
): Promise<T> {
  const onWait = options?.onWait;
  const { label, onCall, signal } = options ?? {};
  const maxQuotaRetries = resolveMaxQuotaRetries(options);

  for (let attempt = 0; attempt < maxQuotaRetries; attempt += 1) {
    throwIfAborted(signal);
    await acquireSlot(onWait, signal);
    geminiCallCount += 1;
    onCall?.(geminiCallCount, label);
    try {
      return await fn();
    } catch (error) {
      throwIfAborted(signal);
      if (!isGeminiQuotaError(error) || attempt === maxQuotaRetries - 1) {
        throw error;
      }

      const retryAfter = parseRetryAfterMs(error);
      const cooldown = Math.max(retryAfter, MIN_COOLDOWN_AFTER_QUOTA_MS);
      cooldownUntil = Date.now() + cooldown;

      onWait?.(
        `Google rate limit (429) — RPM/quota (dashboard may show 17/15 while RPD is still low). Pausing ${Math.ceil(cooldown / 1000)}s before retry (${attempt + 1}/${maxQuotaRetries}). Use Stop to cancel.`,
      );
      await sleepAbortable(cooldown, signal);
    }
  }

  throw new Error("Gemini call failed after quota retries");
}
