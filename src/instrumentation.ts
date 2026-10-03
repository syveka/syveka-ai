import type { Instrumentation } from "next";
import { parseSentryDsn } from "@/lib/observability/dsn";

/**
 * Server error tracking (Node.js runtime only). Without SENTRY_DSN, nothing
 * is imported, initialized or sent. The SDK is loaded only behind the
 * NEXT_RUNTIME check so the Edge middleware bundle never includes it.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const parsed = parseSentryDsn(process.env.SENTRY_DSN);
    if (!parsed) {
      // Never log the value itself.
      if (process.env.SENTRY_DSN?.trim()) {
        console.warn("error_tracking_disabled: SENTRY_DSN is not a valid DSN");
      }
      return;
    }
    const [Sentry, { sentryOptions }] = await Promise.all([
      import("@sentry/nextjs"),
      import("@/lib/observability/options"),
    ]);
    Sentry.init(sentryOptions(parsed.dsn, process.env.VERCEL_GIT_COMMIT_SHA));
  }
}

/** Uncaught errors from route handlers, server components and server actions. */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (!parseSentryDsn(process.env.SENTRY_DSN)) return;
    const Sentry = await import("@sentry/nextjs");
    Sentry.captureRequestError(error, request, context);
  }
};
