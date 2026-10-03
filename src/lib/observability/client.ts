import type * as SentrySdk from "@sentry/nextjs";
import { parseSentryDsn } from "@/lib/observability/dsn";

type SentryModule = typeof SentrySdk;

let sentry: Promise<SentryModule | null> | null = null;

/**
 * Browser error tracking. Without NEXT_PUBLIC_SENTRY_DSN nothing is loaded,
 * initialized or sent; the SDK is a separate chunk fetched only when a DSN
 * is configured. Called once from `instrumentation-client.ts`.
 */
export function initClientErrorTracking(
  rawDsn: string | undefined = process.env.NEXT_PUBLIC_SENTRY_DSN,
): Promise<SentryModule | null> | null {
  const parsed = parseSentryDsn(rawDsn);
  if (!parsed) return null;
  sentry ??= Promise.all([import("@sentry/nextjs"), import("@/lib/observability/options")])
    .then(([Sentry, { sentryOptions }]) => {
      Sentry.init(sentryOptions(parsed.dsn));
      return Sentry;
    })
    // Error tracking must never break the app.
    .catch(() => null);
  return sentry;
}

/**
 * Reports an error caught by a route error boundary. Errors with a digest
 * came from the server, where onRequestError already reported them.
 */
export function reportBoundaryError(error: Error & { digest?: string }): void {
  if (!sentry || error.digest) return;
  void sentry.then((Sentry) => Sentry?.captureException(error));
}

/** Test-only: forget the initialized SDK. */
export function resetClientErrorTrackingForTests(): void {
  sentry = null;
}
