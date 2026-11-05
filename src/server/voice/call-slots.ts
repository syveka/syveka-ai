/**
 * Per-organization call slots: one sorted set per organization, one member per live call,
 * scored by when it expires. Vapi's concurrency limit covers the whole account, so without
 * this one organization could take every line and block all the others.
 *
 * Atomic in Redis, so parallel calls can't all pass. Slots expire on their own, so a crash
 * or a lost report can't hold one for ever.
 */
export type SlotClient = {
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
  keyPrefix?: string;
};

/** Past the longest possible call (15 minutes) plus a margin. */
export const CALL_SLOT_TTL_MS = 20 * 60 * 1000;

const DEFAULT_PREFIX = "voice:slots";

/**
 * KEYS: the organization's slots. ARGV: nowMs, callId, limit, expiresAtMs, ttlMs. Returns how
 * many slots are held, including this one, or -1 at the limit. Asking again for a call that
 * already holds a slot succeeds and changes nothing, so a webhook retry can't take a second.
 */
export const ACQUIRE_CALL_SLOT_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
if redis.call("ZSCORE", KEYS[1], ARGV[2]) then return redis.call("ZCARD", KEYS[1]) end
if redis.call("ZCARD", KEYS[1]) >= tonumber(ARGV[3]) then return -1 end
redis.call("ZADD", KEYS[1], ARGV[4], ARGV[2])
redis.call("PEXPIRE", KEYS[1], ARGV[5])
return redis.call("ZCARD", KEYS[1])
`;

/** KEYS: the organization's slots. ARGV: callId. Releasing twice is harmless. */
export const RELEASE_CALL_SLOT_SCRIPT = `return redis.call("ZREM", KEYS[1], ARGV[1])`;

function slotKey(client: SlotClient, orgId: string): string {
  return `${client.keyPrefix ?? DEFAULT_PREFIX}:${orgId}`;
}

/** Slots now held, including this call's, or null when the organization is at its limit. */
export async function acquireCallSlot(
  client: SlotClient,
  orgId: string,
  callId: string,
  limit: number,
  now: Date = new Date(),
): Promise<number | null> {
  const held = Number(
    await client.eval(
      ACQUIRE_CALL_SLOT_SCRIPT,
      [slotKey(client, orgId)],
      [
        String(now.getTime()),
        callId,
        String(limit),
        String(now.getTime() + CALL_SLOT_TTL_MS),
        String(CALL_SLOT_TTL_MS),
      ],
    ),
  );
  if (!Number.isInteger(held)) throw new Error("Unexpected call slot reply");
  return held < 0 ? null : held;
}

export async function releaseCallSlot(
  client: SlotClient,
  orgId: string,
  callId: string,
): Promise<void> {
  await client.eval(RELEASE_CALL_SLOT_SCRIPT, [slotKey(client, orgId)], [callId]);
}
