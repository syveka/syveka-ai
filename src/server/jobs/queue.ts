import "server-only";

import { Client } from "@upstash/qstash";
import { env } from "@/env";

let qstash: Client | null = null;

function getQstash(): Client {
  qstash ??= new Client({ token: env.QSTASH_TOKEN });
  return qstash;
}

export type JobName = "embed-document" | "run-workflow" | "post-call" | "usage-rollup";

/** Enqueue an async job (§2.2). Delivered to /api/v1/jobs/{name} with QStash signature. */
export async function enqueue(
  job: JobName,
  payload: Record<string, unknown>,
  opts?: { delaySeconds?: number },
): Promise<void> {
  await getQstash().publishJSON({
    url: `${env.NEXT_PUBLIC_APP_URL}/api/v1/jobs/${job}`,
    body: payload,
    retries: 3,
    ...(opts?.delaySeconds ? { delay: opts.delaySeconds } : {}),
  });
}
