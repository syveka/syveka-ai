import "server-only";

import { Receiver } from "@upstash/qstash";
import { env } from "@/env";

let receiver: Receiver | null = null;

function getReceiver(): Receiver {
  receiver ??= new Receiver({
    currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
    nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
  });
  return receiver;
}

/** Verifies the QStash signature on a job request (§13.2 webhook controls). */
export async function verifyJobRequest(request: Request): Promise<string | null> {
  const signature = request.headers.get("upstash-signature");
  if (!signature) return null;
  const body = await request.text();
  const valid = await getReceiver()
    .verify({ signature, body, url: request.url })
    .catch(() => false);
  return valid ? body : null;
}
