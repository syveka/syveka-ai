import "server-only";

import { Client } from "@upstash/qstash";
import { getQstashEnv } from "@/env";

let qstash: Client | null = null;

function getQstash(): Client {
  if (!qstash) {
    const { QSTASH_TOKEN } = getQstashEnv();
    qstash = new Client({ token: QSTASH_TOKEN });
  }
  return qstash;
}

export type JobName =
  | "embed-document"
  | "run-workflow"
  | "post-call"
  | "usage-rollup"
  | "send-reminder"
  | "calendar-sync";

/** Enqueue an async job (§2.2). Delivered to /api/v1/jobs/{name} with QStash signature. */
export async function enqueue(
  job: JobName,
  payload: Record<string, unknown>,
  opts?: { delaySeconds?: number; deduplicationId?: string },
): Promise<void> {
  const { NEXT_PUBLIC_APP_URL } = getQstashEnv();
  await getQstash().publishJSON({
    url: `${NEXT_PUBLIC_APP_URL}/api/v1/jobs/${job}`,
    body: payload,
    retries: 3,
    ...(opts?.delaySeconds ? { delay: opts.delaySeconds } : {}),
    ...(opts?.deduplicationId ? { deduplicationId: opts.deduplicationId } : {}),
  });
}
