import type { init } from "@sentry/nextjs";
import { scrubBreadcrumb, scrubEvent } from "@/lib/observability/scrub";

/**
 * Integrations removed from the SDK defaults: tracing, Session Replay, user
 * feedback, release-health sessions and console capture. Errors only.
 */
const DISABLED_INTEGRATIONS = new Set([
  "BrowserTracing",
  "Replay",
  "ReplayCanvas",
  "Feedback",
  "BrowserSession",
  "Console",
]);

type SharedOptions = Parameters<typeof init>[0];

/** Lowercase name, as Sentry accepts it: no spaces, slashes or newlines. */
const ENVIRONMENT_NAME = /^[a-z][a-z0-9_-]{0,31}$/;

/**
 * The Sentry environment label, from NEXT_PUBLIC_SENTRY_ENVIRONMENT (inlined
 * at build, so the browser and the server agree). Without it the SDK falls
 * back to the Vercel target or NODE_ENV, which reads "production" for every
 * `vercel build --prod`, including the stable staging alias. Unset or invalid
 * leaves that default unchanged.
 */
export function sentryEnvironment(
  raw: string | undefined = process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
): string | undefined {
  const value = raw?.trim();
  return value && ENVIRONMENT_NAME.test(value) ? value : undefined;
}

/** SDK options for both runtimes: error events only, scrubbed, no identity. */
export function sentryOptions(dsn: string, release?: string): SharedOptions {
  const environment = sentryEnvironment();
  return {
    dsn,
    release: release || undefined,
    // Only when configured: an explicit undefined would replace the SDK's
    // own default rather than fall back to it.
    ...(environment ? { environment } : {}),
    // Collect nothing beyond the error itself. beforeSend still scrubs
    // everything, in case an integration adds data regardless.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    // Tracing stays disabled: no sample rate, no sampler, and no trace
    // headers added to outgoing requests (to our APIs or third parties).
    tracesSampleRate: undefined,
    tracesSampler: undefined,
    tracePropagationTargets: [],
    includeServerName: false,
    sendClientReports: false,
    attachStacktrace: false,
    maxBreadcrumbs: 20,
    integrations: (defaults) =>
      defaults.filter((integration) => !DISABLED_INTEGRATIONS.has(integration.name)),
    beforeSend: (event) => scrubEvent(event),
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    beforeBreadcrumb: (breadcrumb) => scrubBreadcrumb(breadcrumb),
  };
}
