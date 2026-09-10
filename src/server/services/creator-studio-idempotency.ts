import "server-only";

import { createHash } from "node:crypto";

/**
 * P1 request-level idempotency (Creator Studio generation endpoints).
 *
 * A client MAY send an `Idempotency-Key` header on a generation POST.
 * Uniqueness is scoped to (organizationId, generationType, idempotencyKey)
 * via a DB unique constraint on CreatorGeneration — see
 * requestCharacterImageGeneration/etc. in creator-generations.ts for how
 * the constraint is used as the actual concurrency authority (the insert
 * itself is the race-decider, never a separate check-then-create).
 *
 * Same key + same request → the same logical generation is reused
 * (never re-reserved, never re-submitted to the provider), regardless of
 * whether it's still GENERATING, already COMPLETED, or already FAILED —
 * "same key = same logical request forever" is the safer semantic. A
 * fresh paid attempt after a FAILED idempotent request requires a new key.
 *
 * Same key + a materially different request body is a conflict (409),
 * detected via requestFingerprint below — never silently reused.
 */

/** Same order of magnitude as Stripe's own Idempotency-Key length limit — long enough for any reasonable client-generated value, short enough to reject abuse. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

export class IdempotencyKeyTooLongError extends Error {
  readonly code = "idempotency_key_too_long";
  constructor() {
    super(`Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`);
  }
}

/** Validates a raw Idempotency-Key header value. Returns undefined for "no key sent" (backward-compatible — current behavior). Throws for a present-but-invalid key rather than silently ignoring it. */
export function parseIdempotencyKeyHeader(raw: string | null): string | undefined {
  if (raw === null) return undefined;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) throw new IdempotencyKeyTooLongError();
  return trimmed;
}

export class IdempotencyConflictError extends Error {
  readonly code = "idempotency_key_conflict";
  constructor() {
    super(
      "This Idempotency-Key was already used for a request with different parameters. Use a new key for a different request.",
    );
  }
}

/**
 * Deterministic canonical serialization — same shape always produces the
 * same string regardless of key insertion order, so the resulting hash is
 * stable for semantically identical normalized input.
 */
function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

/**
 * Hashes the provider-impacting request fields — never stores or logs the
 * raw prompt/fields themselves, only this opaque digest, so a later
 * conflict check never has to re-expose the original request content.
 */
export function computeRequestFingerprint(fields: Record<string, unknown>): string {
  return createHash("sha256").update(canonicalize(fields)).digest("hex");
}
