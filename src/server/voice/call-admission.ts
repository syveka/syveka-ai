import "server-only";

import { redis } from "@/server/integrations/redis";
import { getEntitlements } from "@/server/services/billing/entitlements";
import { getVoiceUsageState, MAX_CALL_MINUTES } from "@/server/services/billing/voice-usage";
import { acquireCallSlot, releaseCallSlot, type SlotClient } from "./call-slots";

export type RefusalReason =
  "read_only" | "no_minutes" | "concurrency_limit" | "minutes_exhausted" | "limits_unavailable";

export type Admission = { admitted: true } | { admitted: false; reason: RefusalReason };

const REFUSED_TTL_SECONDS = 48 * 60 * 60;

const refusedKey = (orgId: string, vapiCallId: string) => `voice:refused:${orgId}:${vapiCallId}`;

/**
 * Concurrent calls an organization may hold. Any organization with minutes gets at least
 * one, which also covers a pilot or contract grant on a plan with no slots of its own.
 */
export function callSlotLimit(ent: { voiceMinutesMonth: number; voiceConcurrentCalls?: number }) {
  if (ent.voiceMinutesMonth <= 0) return 0;
  return Math.max(1, ent.voiceConcurrentCalls ?? 0);
}

/**
 * Whether a call that has just connected may continue. The order matters: taking the slot
 * first means each parallel call sees those before it, so they can't all pass a read-only
 * check together. Other live calls count as their longest possible length, because that is
 * what they might still use.
 *
 * Fails closed: if the limits can't be checked, the call is refused. The most an organization
 * can pass its cap by is the rest of the one call that started below it.
 */
export async function admitCall(
  orgId: string,
  vapiCallId: string,
  options: { now?: Date } = {},
): Promise<Admission> {
  const now = options.now ?? new Date();
  const client = redis as unknown as SlotClient;
  let holdsSlot = false;
  try {
    const ent = await getEntitlements(orgId);
    if (ent.readOnly) return { admitted: false, reason: "read_only" };
    const limit = callSlotLimit(ent);
    if (limit === 0) return { admitted: false, reason: "no_minutes" };

    const held = await acquireCallSlot(client, orgId, vapiCallId, limit, now);
    if (held === null) return { admitted: false, reason: "concurrency_limit" };
    holdsSlot = true;

    const usage = await getVoiceUsageState(orgId, { now, excludeVapiCallId: vapiCallId });
    const counted = usage.billableMinutes + usage.uncertainMinutes + (held - 1) * MAX_CALL_MINUTES;
    if (counted >= ent.voiceMinutesMonth) {
      await releaseCallSlot(client, orgId, vapiCallId);
      return { admitted: false, reason: "minutes_exhausted" };
    }
    return { admitted: true };
  } catch {
    if (holdsSlot) await releaseCallSlot(client, orgId, vapiCallId).catch(() => undefined);
    return { admitted: false, reason: "limits_unavailable" };
  }
}

/** Best effort: a slot that isn't released expires by itself. */
export async function endCallSlot(orgId: string, vapiCallId: string): Promise<void> {
  await releaseCallSlot(redis as unknown as SlotClient, orgId, vapiCallId).catch(() => undefined);
}

/** So reconciliation doesn't bill a call Syveka itself refused. Best effort. */
export async function markCallRefused(orgId: string, vapiCallId: string): Promise<void> {
  await redis
    .set(refusedKey(orgId, vapiCallId), "1", { ex: REFUSED_TTL_SECONDS })
    .catch(() => undefined);
}

export async function wasCallRefused(orgId: string, vapiCallId: string): Promise<boolean> {
  return Boolean(await redis.get(refusedKey(orgId, vapiCallId)).catch(() => null));
}
