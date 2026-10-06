import { initClientErrorTracking } from "@/lib/observability/client";

// No-op unless NEXT_PUBLIC_SENTRY_DSN is configured.
initClientErrorTracking();
