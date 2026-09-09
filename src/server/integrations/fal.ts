import "server-only";

/**
 * fal.ai queue API client (https://fal.ai — hosts Kling for video and
 * FLUX-class models for image at low per-generation cost). Generic HTTP
 * client only — no Creator Studio-specific logic; see
 * src/server/ai/creator/fal-provider.ts for the CreatorMediaProvider that
 * uses this.
 *
 * Auth: `FAL_API_KEY` (optional — every caller here throws a clear
 * configuration error if it's unset, rather than silently no-op-ing; §4 of
 * the charter). Never logged, never sent to the browser.
 *
 * Queue flow (fal.ai's documented async pattern for anything that can take
 * more than a few seconds, which both image and especially video
 * generation can):
 *   1. POST https://queue.fal.run/{model} with the model's input JSON ->
 *      { request_id, status_url, response_url }
 *   2. GET status_url until status is "COMPLETED" (or "ERROR")
 *   3. GET response_url for the final output JSON
 */

export class FalNotConfiguredError extends Error {
  constructor() {
    super("FAL_API_KEY is not set (required for real Creator Studio media generation)");
  }
}

export class FalRequestError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function getApiKey(): string {
  const key = process.env.FAL_API_KEY;
  if (!key) throw new FalNotConfiguredError();
  return key;
}

export function isFalConfigured(): boolean {
  return Boolean(process.env.FAL_API_KEY);
}

type FalQueueSubmitResponse = {
  request_id: string;
  status_url: string;
  response_url: string;
};

type FalQueueStatusResponse = {
  status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED" | "ERROR";
  logs?: Array<{ message: string }>;
  error?: string;
};

async function falFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Key ${getApiKey()}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new FalRequestError(
      res.status,
      `fal.ai request failed (${res.status}): ${body.slice(0, 500)}`,
    );
  }
  return res.json() as Promise<T>;
}

const POLL_INTERVAL_MS = 2000;
const MAX_POLL_ATTEMPTS = 150; // 5 minutes at 2s intervals — generous for video jobs

/**
 * Submits a job to a fal.ai model's queue endpoint, polls until completion,
 * and returns the final output JSON. `model` is a fal.ai model id, e.g.
 * "fal-ai/flux/schnell" or "fal-ai/kling-video/v1.5/standard/image-to-video".
 */
export async function runFalModel<TOutput>(
  model: string,
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<TOutput> {
  const submitted = await falFetch<FalQueueSubmitResponse>(`https://queue.fal.run/${model}`, {
    method: "POST",
    body: JSON.stringify(input),
    signal,
  });

  for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
    const status = await falFetch<FalQueueStatusResponse>(submitted.status_url, { signal });
    if (status.status === "COMPLETED") {
      return falFetch<TOutput>(submitted.response_url, { signal });
    }
    if (status.status === "ERROR") {
      throw new FalRequestError(502, `fal.ai job failed: ${status.error ?? "unknown error"}`);
    }
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, POLL_INTERVAL_MS);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  }
  throw new FalRequestError(504, `fal.ai job ${submitted.request_id} did not complete in time`);
}
