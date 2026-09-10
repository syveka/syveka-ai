import "server-only";

import { NextResponse } from "next/server";
import { AuthError } from "@/server/auth/session";
import { EntitlementError } from "@/server/services/billing/entitlements";
import { InsufficientCreditsError } from "@/server/services/creator-credits";
import { CreatorProfileError } from "@/server/services/creator-profiles";
import { PostWorkflowError } from "@/server/services/creator-posts";
import { CampaignError } from "@/server/services/creator-campaigns";
import { FeatureDisabledError } from "@/server/services/feature-flags";
import { DocumentIngestionError } from "@/server/security/document-ingestion";
import { SocialProviderNotImplementedError } from "@/server/social";
import {
  IdempotencyConflictError,
  IdempotencyKeyTooLongError,
} from "@/server/services/creator-studio-idempotency";

/**
 * Shared error → HTTP response mapping for every /api/v1/creator-studio/**
 * route, so the growing set of Creator Studio domain error classes maps to
 * a consistent status code everywhere instead of each route re-deriving it.
 * Errors this doesn't recognize are rethrown for Next.js's default 500
 * handling (never silently swallowed).
 */
export function handleCreatorStudioError(e: unknown): NextResponse {
  if (e instanceof AuthError) {
    return NextResponse.json({ error: { code: "forbidden" } }, { status: e.status });
  }
  if (e instanceof FeatureDisabledError) {
    return NextResponse.json({ error: { code: e.code } }, { status: 403 });
  }
  if (e instanceof EntitlementError) {
    return NextResponse.json({ error: { code: e.code, limit: e.limit } }, { status: 402 });
  }
  if (e instanceof InsufficientCreditsError) {
    return NextResponse.json({ error: { code: e.code } }, { status: 402 });
  }
  if (e instanceof IdempotencyConflictError) {
    return NextResponse.json({ error: { code: e.code } }, { status: 409 });
  }
  if (e instanceof IdempotencyKeyTooLongError) {
    return NextResponse.json({ error: { code: e.code } }, { status: 400 });
  }
  if (e instanceof SocialProviderNotImplementedError) {
    return NextResponse.json(
      { error: { code: "social_provider_not_implemented" } },
      { status: 501 },
    );
  }
  if (
    e instanceof CreatorProfileError ||
    e instanceof PostWorkflowError ||
    e instanceof CampaignError
  ) {
    const status = e.code === "not_found" ? 404 : 409;
    return NextResponse.json({ error: { code: e.code, message: e.message } }, { status });
  }
  if (e instanceof DocumentIngestionError) {
    return NextResponse.json({ error: { code: e.code } }, { status: 400 });
  }
  throw e;
}
