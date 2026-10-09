import "server-only";

import { AuthError } from "@/server/auth/session";
import { EntitlementError } from "@/server/services/billing/entitlements";
import { InsufficientCreditsError } from "@/server/services/creator-credits";
import { CreatorProfileError } from "@/server/services/creator-profiles";
import { PostWorkflowError } from "@/server/services/creator-posts";
import { CampaignError } from "@/server/services/creator-campaigns";
import { SocialConnectError } from "@/server/services/creator-social-accounts";
import { FeatureDisabledError } from "@/server/services/feature-flags";
import { DocumentIngestionError } from "@/server/security/document-ingestion";
import { SocialProviderNotImplementedError } from "@/server/social";
import { CreatorMediaProviderUnavailableError } from "@/server/ai/creator/router";
import {
  IdempotencyConflictError,
  IdempotencyKeyTooLongError,
} from "@/server/services/creator-studio-idempotency";

// The domain errors handleCreatorStudioError (creator-studio-http.ts) maps for the API routes,
// plus SocialConnectError: all raised deliberately with text written for the user.
const USER_FACING_ERRORS = [
  AuthError,
  FeatureDisabledError,
  EntitlementError,
  InsufficientCreditsError,
  IdempotencyConflictError,
  IdempotencyKeyTooLongError,
  CreatorMediaProviderUnavailableError,
  SocialProviderNotImplementedError,
  CreatorProfileError,
  PostWorkflowError,
  CampaignError,
  DocumentIngestionError,
  SocialConnectError,
];

/**
 * The error a Creator Studio server action returns to the browser. Any other error (a provider
 * response body, a database error) becomes `fallbackCode` and is logged by class name only, since
 * its message can carry provider or query detail (CLAUDE.md §4).
 */
export function creatorActionError(error: unknown, fallbackCode: string): string {
  if (USER_FACING_ERRORS.some((ErrorClass) => error instanceof ErrorClass)) {
    return (error as Error).message;
  }
  console.error("creator studio action failed", {
    errorClass: error instanceof Error ? error.constructor.name : typeof error,
  });
  return fallbackCode;
}
