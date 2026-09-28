import "server-only";

import { isChatTranscriptionEnabled } from "@/env";
import { PILOT_DAILY_ATTEMPTS } from "@/lib/voice/audio";

export { PILOT_DAILY_ATTEMPTS };

/**
 * Temporary staging pilot for chat voice input. Not a plan allowance, price
 * or production billing rule: it only gates who may trigger paid
 * transcription while the feature is evaluated.
 *
 * - Allowlist: AI_TRANSCRIPTION_PILOT_ALLOWLIST, comma-separated
 *   "<organizationId>:<userId>" UUID pairs, matched against the session's
 *   server-verified IDs. Missing or malformed configuration allows no one.
 * - Daily cap: PILOT_DAILY_ATTEMPTS provider attempts per user and
 *   organization per Europe/Helsinki calendar day, reserved atomically in
 *   Redis before the provider call and never refunded.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Parses the allowlist; any malformed entry disables the whole list (fail closed). */
export function parsePilotAllowlist(raw: string | undefined): ReadonlySet<string> {
  if (!raw || !raw.trim()) return new Set();
  const pairs = new Set<string>();
  for (const entry of raw.split(",")) {
    const [org, user, ...rest] = entry.trim().split(":");
    if (rest.length > 0 || !org || !user || !UUID.test(org) || !UUID.test(user)) {
      console.error(JSON.stringify({ event: "transcription_pilot_allowlist_invalid" }));
      return new Set();
    }
    pairs.add(`${org.toLowerCase()}:${user.toLowerCase()}`);
  }
  return pairs;
}

/** Voice input is offered only to allowlisted (organization, user) pairs. */
export function isTranscriptionPilotMember(ctx: { orgId: string; userId: string }): boolean {
  if (!isChatTranscriptionEnabled()) return false;
  const allowlist = parsePilotAllowlist(process.env.AI_TRANSCRIPTION_PILOT_ALLOWLIST);
  return allowlist.has(`${ctx.orgId.toLowerCase()}:${ctx.userId.toLowerCase()}`);
}

/** Calendar day (YYYY-MM-DD) in Europe/Helsinki; DST is handled by the zone rules. */
export function helsinkiDay(at: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Helsinki",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Atomic check-and-increment: returns the new count, or -1 when the limit is
 * already reached (the counter is then left unchanged). Concurrent calls are
 * serialised by Redis, so no more than `limit` reservations can succeed.
 */
const RESERVE_SCRIPT = `
local current = tonumber(redis.call("GET", KEYS[1]) or "0")
if current >= tonumber(ARGV[1]) then return -1 end
local count = redis.call("INCR", KEYS[1])
if count == 1 then redis.call("EXPIRE", KEYS[1], tonumber(ARGV[2])) end
return count
`;

export type Reservation = { ok: true; used: number } | { ok: false; used: number };

type EvalClient = {
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
};

/**
 * Reserves one transcription attempt for today. Throws if the store is
 * unreachable or answers unexpectedly — callers must fail closed.
 */
export async function reserveDailyTranscriptionAttempt(
  redis: EvalClient,
  ctx: { orgId: string; userId: string },
  now: Date = new Date(),
): Promise<Reservation> {
  const key = `pilot:transcribe:${helsinkiDay(now)}:${ctx.orgId}:${ctx.userId}`;
  // 48 h keeps the key past the day's end in any DST transition.
  const result = await redis.eval(RESERVE_SCRIPT, [key], [String(PILOT_DAILY_ATTEMPTS), "172800"]);
  const count = Number(result);
  if (!Number.isInteger(count)) throw new Error("Unexpected limit store response");
  return count === -1 ? { ok: false, used: PILOT_DAILY_ATTEMPTS } : { ok: true, used: count };
}
