import "server-only";

import { redis } from "@/server/integrations/redis";

/**
 * In-flight reservations against the organization's monthly AI message quota.
 *
 * The quota counts recorded AI_MESSAGES usage, but a chat turn records its
 * message only after the model has finished, so concurrent turns that each
 * read "49 of 50" would all start a paid generation. Each turn therefore
 * reserves a slot here before reading the recorded count, and is allowed only
 * if `recorded + reservations already in flight` is still under the limit
 * (see the chat route). The database stays the source of truth for completed
 * usage, including AI messages recorded by other features; Redis only holds
 * the turns that haven't recorded theirs yet.
 *
 * Ordering is what makes this exact: a turn records its usage BEFORE it
 * releases its reservation, and a new turn reserves BEFORE it reads the
 * recorded count. So every other turn is seen either as a reservation or as
 * recorded usage (briefly as both, which only over-counts).
 *
 * A reservation that is never released (a crashed instance) expires after
 * RESERVATION_TTL_MS, longer than any chat turn can run (route maxDuration).
 */
export const RESERVATION_TTL_MS = 5 * 60 * 1000;

/**
 * KEYS[1]: the organization's sorted set (member: reservation id, score:
 * expiry ms). ARGV: nowMs, expiresAtMs, reservationId, ttlMs. Atomically drops
 * expired reservations, adds this one and returns how many are in flight
 * including it, so concurrent callers always get distinct counts.
 */
export const RESERVE_AI_MESSAGE_SCRIPT = `
redis.call("ZREMRANGEBYSCORE", KEYS[1], "-inf", ARGV[1])
redis.call("ZADD", KEYS[1], ARGV[2], ARGV[3])
redis.call("PEXPIRE", KEYS[1], ARGV[4])
return redis.call("ZCARD", KEYS[1])
`;

/** KEYS[1]: the organization's sorted set. ARGV: reservationId. */
export const RELEASE_AI_MESSAGE_SCRIPT = `
return redis.call("ZREM", KEYS[1], ARGV[1])
`;

export type ReservationClient = {
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
};

export type AiMessageReservation = {
  key: string;
  id: string;
  /** Other turns of the organization in flight when this one reserved. */
  inFlightAhead: number;
};

/** The reservation couldn't be taken (Redis errored or isn't configured): refuse, fail closed. */
export class AiMessageReservationUnavailableError extends Error {
  constructor() {
    super("The AI message quota could not be verified.");
    this.name = "AiMessageReservationUnavailableError";
  }
}

/** UTC month, matching getMonthUsage(). */
function monthKey(orgId: string, now: Date): string {
  const month = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return `aiq:inflight:${orgId}:${month}`;
}

export async function reserveAiMessage(
  orgId: string,
  client: ReservationClient = redis,
  now: Date = new Date(),
): Promise<AiMessageReservation> {
  const key = monthKey(orgId, now);
  const id = crypto.randomUUID();
  let inFlight: number;
  try {
    inFlight = Number(
      await client.eval(
        RESERVE_AI_MESSAGE_SCRIPT,
        [key],
        [
          String(now.getTime()),
          String(now.getTime() + RESERVATION_TTL_MS),
          id,
          String(RESERVATION_TTL_MS),
        ],
      ),
    );
  } catch {
    inFlight = Number.NaN;
  }
  if (!Number.isInteger(inFlight) || inFlight < 1) {
    // The key is never logged: it contains the organization id.
    console.error(JSON.stringify({ event: "ai_message_reservation_unavailable" }));
    throw new AiMessageReservationUnavailableError();
  }
  return { key, id, inFlightAhead: inFlight - 1 };
}

/**
 * Gives the slot back. Call only after the turn's usage (if any) is recorded.
 * Never throws: an unreleased reservation over-counts until it expires.
 */
export async function releaseAiMessage(
  reservation: AiMessageReservation,
  client: ReservationClient = redis,
): Promise<void> {
  try {
    await client.eval(RELEASE_AI_MESSAGE_SCRIPT, [reservation.key], [reservation.id]);
  } catch {
    console.error(JSON.stringify({ event: "ai_message_release_failed" }));
  }
}
