export class AnalysisAbortedError extends Error {
  constructor(message = "Analysis stopped.") {
    super(message);
    this.name = "AnalysisAbortedError";
  }
}

export function isAnalysisAborted(error: unknown): boolean {
  if (error instanceof AnalysisAbortedError) return true;
  if (
    typeof DOMException !== "undefined" &&
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new AnalysisAbortedError();
  }
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AnalysisAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
