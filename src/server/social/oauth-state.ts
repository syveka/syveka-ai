import "server-only";

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { SocialPlatform } from "@prisma/client";

/**
 * HMAC-signed, expiring, tenant-bound OAuth state for the Meta OAuth
 * callback (src/app/api/v1/creator-studio/social-accounts/oauth/meta/callback).
 * Mirrors src/server/services/calendar-connections.ts's state
 * build/verify exactly: the callback is a top-level redirect from Meta, so
 * state — not a session cookie — is what proves the request belongs to a
 * specific org/user/platform.
 */

export class SocialOAuthStateError extends Error {
  constructor(
    message: string,
    public readonly code: "not_configured" | "bad_state",
  ) {
    super(message);
    this.name = "SocialOAuthStateError";
  }
}

function stateSecret(): string {
  // Reuse the QStash signing key material if a dedicated secret is not
  // configured; state only needs integrity, not confidentiality. No further
  // fallback: an unconfigured secret must fail closed (§4).
  const secret = process.env.META_OAUTH_STATE_SECRET || process.env.QSTASH_CURRENT_SIGNING_KEY;
  if (!secret) {
    throw new SocialOAuthStateError(
      "Social OAuth state signing is not configured (set META_OAUTH_STATE_SECRET or QSTASH_CURRENT_SIGNING_KEY)",
      "not_configured",
    );
  }
  return secret;
}

export function buildSocialOAuthState(
  orgId: string,
  userId: string,
  platform: SocialPlatform,
): string {
  const payload = `${orgId}.${userId}.${platform}.${Date.now()}.${randomBytes(8).toString("hex")}`;
  const sig = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${sig}`;
}

export function verifySocialOAuthState(state: string): {
  orgId: string;
  userId: string;
  platform: SocialPlatform;
} {
  const [encoded, sig] = state.split(".");
  if (!encoded || !sig) throw new SocialOAuthStateError("Malformed state", "bad_state");
  const payload = Buffer.from(encoded, "base64url").toString("utf8");
  const expected = createHmac("sha256", stateSecret()).update(payload).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new SocialOAuthStateError("Invalid state signature", "bad_state");
  }
  const [orgId, userId, platform, issuedAt] = payload.split(".");
  if (!orgId || !userId || !platform || !issuedAt) {
    throw new SocialOAuthStateError("Malformed state payload", "bad_state");
  }
  if (Date.now() - Number(issuedAt) > 10 * 60_000) {
    throw new SocialOAuthStateError("State expired", "bad_state");
  }
  return { orgId, userId, platform: platform as SocialPlatform };
}
