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
 * A retry for a call already holding a slot is admitted at once: it was admitted before, and
 * what started after it must not end it. Calls that have rows but no slot, such as one that
 * ended with its report still on the way, count too, so sequential calls can't slip past.
 *
 * Fails closed: if the limits can't be checked, the call is refused. A call admitted below the
 * cap can still run past it, up to its 15-minute limit.
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
    // First, and asking for nothing new: a retry for a call already admitted stays admitted,
    // even if entitlements or usage can't be read right now.
    const existing = await acquireCallSlot(client, orgId, vapiCallId, 0, now);
    if (existing?.alreadyHeld) return { admitted: true };

    const ent = await getEntitlements(orgId);
    if (ent.readOnly) return { admitted: false, reason: "read_only" };
    const limit = callSlotLimit(ent);
    if (limit === 0) return { admitted: false, reason: "no_minutes" };

    const slot = await acquireCallSlot(client, orgId, vapiCallId, limit, now);
    if (slot === null) return { admitted: false, reason: "concurrency_limit" };
    if (slot.alreadyHeld) return { admitted: true };
    holdsSlot = true;

    const usage = await getVoiceUsageState(orgId, { now, excludeVapiCallId: vapiCallId });
    const otherLiveCalls = Math.max(slot.held - 1, usage.inFlightCalls);
    const counted =
      usage.billableMinutes + usage.uncertainMinutes + otherLiveCalls * MAX_CALL_MINUTES;
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

/**
 * "ended" means Syveka ended the call, or is about to, so it isn't the customer's usage.
 * "running" means the hang-up failed: it gets no tools, and it's billed only if its notice is
 * confirmed, because it really ran. "notice" means its configuration or its own record showed
 * the notice missing: nothing is kept, however the hang-up went, and fixing the configuration
 * later doesn't change that.
 */
export type CallRefusal = "ended" | "running" | "notice";

/** Remembers a refusal, and says whether that worked. */

export async function markCallRefused(
  orgId: string,
  vapiCallId: string,
  refusal: CallRefusal,
): Promise<boolean> {
  return redis.set(refusedKey(orgId, vapiCallId), refusal, { ex: REFUSED_TTL_SECONDS }).then(
    () => true,
    () => false,
  );
}

/** Whether this call was refused, or "unknown" when that can't be read. */
export async function callRefusal(
  orgId: string,
  vapiCallId: string,
): Promise<CallRefusal | "unknown" | null> {
  try {
    const value = await redis.get<string>(refusedKey(orgId, vapiCallId));
    return value === "ended" || value === "running" || value === "notice" ? value : null;
  } catch {
    return "unknown";
  }
}
