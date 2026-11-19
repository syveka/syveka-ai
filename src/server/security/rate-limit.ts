import "server-only";

import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { checkRateLimit, type LimitDecision, type RateLimiters } from "@/server/integrations/redis";

function retryAfterSeconds(reset: number): string {
  return String(Math.max(1, Math.ceil((reset - Date.now()) / 1000)));
}

/**
 * Checks a named limiter for a route handler (checkRateLimit, fail closed).
 * Returns the refusal to send, or null to continue: 429 with Retry-After when
 * the limit is reached, 503 when it can't be verified.
 */
export async function rateLimitRefusal(
  name: keyof RateLimiters,
  key: string,
): Promise<NextResponse | null> {
  return refusalFor(await checkRateLimit(name, key));
}

export function refusalFor(decision: LimitDecision): NextResponse | null {
  if (decision.ok) return null;
  if (decision.reason === "unavailable") {
    return NextResponse.json({ error: { code: "service_unavailable" } }, { status: 503 });
  }
  return NextResponse.json(
    { error: { code: "rate_limited" } },
    {
      status: 429,
      headers: {
        "Retry-After": retryAfterSeconds(decision.reset),
        "X-RateLimit-Limit": String(decision.limit),
        "X-RateLimit-Remaining": String(decision.remaining),
        "X-RateLimit-Reset": String(decision.reset),
      },
    },
  );
}

/**
 * The same check for a server action: the error code to return, or null to
 * continue. Limits are checked in order; the first refusal wins.
 */
export async function actionRateLimitError(
  ...checks: Array<[name: keyof RateLimiters, key: string]>
): Promise<"rate_limited" | "service_unavailable" | null> {
  for (const [name, key] of checks) {
    const decision = await checkRateLimit(name, key);
    if (!decision.ok) {
      return decision.reason === "unavailable" ? "service_unavailable" : "rate_limited";
    }
  }
  return null;
}

/** The areas whose plain write actions share one per-user allowance each. */
export type WriteArea = "crm" | "calendar" | "booking" | "integrations" | "members" | "voice";

/**
 * The limit for an authenticated write action that has no limiter of its
 * own (CRM records, calendar events, booking set-up, calendar integrations,
 * team changes that send nothing):
 * one allowance per user and area on the shared `api` limiter, failing
 * closed like every other action limit. Keyed by area so a burst in one
 * place (a CRM import) doesn't block the same person's calendar. Actions
 * that send email, call a paid provider or spend AI quota keep their own,
 * tighter limits.
 */
export async function actionWriteLimitError(
  area: WriteArea,
  ctx: { orgId: string; userId: string },
): Promise<"rate_limited" | "service_unavailable" | null> {
  return actionRateLimitError(["api", `${area}-write:${ctx.orgId}:${ctx.userId}`]);
}

/**
 * A stable key part for an email address that doesn't store the address in
 * the limiter's keys (Redis). Addresses that reach the same mailbox share a
 * key, so a per-recipient cap can't be stepped around with aliases:
 * `a+1@x` is `a@x`, and Gmail ignores dots (`a.b@gmail.com` is
 * `ab@gmail.com`). Folding can only merge distinct addresses into one key,
 * which over-counts: the safe direction for a cap.
 */
export function emailKey(email: string): string {
  return createHash("sha256").update(mailbox(email)).digest("hex").slice(0, 32);
}

function mailbox(email: string): string {
  const address = email.trim().toLowerCase();
  const at = address.lastIndexOf("@");
  if (at <= 0) return address;
  let local = address.slice(0, at).split("+")[0] || address.slice(0, at);
  let domain = address.slice(at + 1);
  if (domain === "googlemail.com") domain = "gmail.com";
  if (domain === "gmail.com") local = local.split(".").join("");
  return `${local}@${domain}`;
}
