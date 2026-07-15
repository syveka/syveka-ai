export type RetryOptions = {
  maxAttempts?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  random?: () => number;
};

type ProviderError = Error & { status?: number; code?: string; headers?: Headers };

const TRANSIENT_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENETUNREACH",
  "rate_limit_exceeded",
  "server_error",
]);

export function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === "AbortError" || error.message === "Request aborted")
  );
}

export function isTransientAiError(error: unknown): boolean {
  if (!(error instanceof Error) || isAbortError(error)) return false;
  const providerError = error as ProviderError;
  return (
    providerError.status === 408 ||
    providerError.status === 409 ||
    providerError.status === 429 ||
    (providerError.status !== undefined && providerError.status >= 500) ||
    (providerError.code !== undefined && TRANSIENT_CODES.has(providerError.code))
  );
}

export function retryDelayMs(attempt: number, baseDelayMs: number, random = Math.random): number {
  const exponential = baseDelayMs * 2 ** Math.max(0, attempt - 1);
  return Math.round(exponential * (0.75 + random() * 0.5));
}

export async function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const complete = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(complete, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Request aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function withAiRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 250;
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (options.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxAttempts || !isTransientAiError(error)) throw error;
      await abortableDelay(retryDelayMs(attempt, baseDelayMs, options.random), options.signal);
    }
  }
  throw lastError;
}
