import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { unscopedPrisma } from "@/server/db/tenant";
import type { BookingTokenPurpose } from "@prisma/client";

/**
 * Secure expiring booking tokens (§public cancel/reschedule links).
 * Raw tokens are 256-bit URL-safe strings returned exactly once; only the
 * SHA-256 hash is persisted. Lookups compare hashes (constant-time on the
 * digest), so a database leak never exposes usable links.
 */

export const TOKEN_TTL_DAYS = 30;

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

export function generateRawToken(): string {
  return randomBytes(32).toString("base64url");
}

export class BookingTokenError extends Error {
  constructor(
    message: string,
    public readonly code: "invalid" | "expired" | "used",
  ) {
    super(message);
    this.name = "BookingTokenError";
  }
}

export async function issueToken(
  bookingId: string,
  purpose: BookingTokenPurpose,
  ttlDays = TOKEN_TTL_DAYS,
): Promise<string> {
  const raw = generateRawToken();
  await unscopedPrisma.bookingToken.create({
    data: {
      bookingId,
      tokenHash: hashToken(raw),
      purpose,
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000),
    },
  });
  return raw;
}

/**
 * Resolve a raw token → booking. MANAGE tokens satisfy CANCEL and RESCHEDULE.
 * Throws typed errors; never reveals whether the token ever existed.
 */
export async function resolveToken(raw: string, purpose: BookingTokenPurpose) {
  if (!raw || raw.length < 20 || raw.length > 128) {
    throw new BookingTokenError("Invalid token", "invalid");
  }
  const digest = hashToken(raw);
  const record = await unscopedPrisma.bookingToken.findUnique({
    where: { tokenHash: digest },
    include: {
      booking: {
        include: {
          bookingType: true,
          event: { select: { id: true, startsAt: true, endsAt: true, status: true } },
        },
      },
    },
  });
  if (!record) throw new BookingTokenError("Invalid token", "invalid");
  // Defense in depth: constant-time re-compare of the stored digest.
  const a = Buffer.from(record.tokenHash, "utf8");
  const b = Buffer.from(digest, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new BookingTokenError("Invalid token", "invalid");
  }
  if (record.purpose !== purpose && record.purpose !== "MANAGE") {
    throw new BookingTokenError("Invalid token", "invalid");
  }
  if (record.usedAt) throw new BookingTokenError("Token already used", "used");
  if (record.expiresAt < new Date()) throw new BookingTokenError("Token expired", "expired");
  return record;
}

/** Mark single-use tokens consumed (MANAGE tokens stay live until expiry). */
export async function consumeToken(tokenId: string, purpose: BookingTokenPurpose): Promise<void> {
  if (purpose === "MANAGE") return;
  await unscopedPrisma.bookingToken.update({
    where: { id: tokenId },
    data: { usedAt: new Date() },
  });
}

/** Invalidate all outstanding tokens for a booking (cancel/reschedule flows). */
export async function invalidateBookingTokens(bookingId: string): Promise<void> {
  await unscopedPrisma.bookingToken.updateMany({
    where: { bookingId, usedAt: null },
    data: { usedAt: new Date() },
  });
}
