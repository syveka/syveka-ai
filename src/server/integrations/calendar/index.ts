import "server-only";

import type { CalendarProvider } from "@prisma/client";
import { googleCalendarAdapter } from "./google";
import { microsoftCalendarAdapter } from "./microsoft";
import { mockCalendarAdapter } from "./mock";
import type { CalendarProviderAdapter } from "./types";

const ADAPTERS: Record<CalendarProvider, CalendarProviderAdapter> = {
  GOOGLE: googleCalendarAdapter,
  MICROSOFT: microsoftCalendarAdapter,
  MOCK: mockCalendarAdapter,
};

export function getProviderAdapter(provider: CalendarProvider): CalendarProviderAdapter {
  return ADAPTERS[provider];
}

/** Providers offered in the connection settings UI for this environment. */
export function listAvailableProviders(): Array<{
  provider: CalendarProvider;
  configured: boolean;
}> {
  const out: Array<{ provider: CalendarProvider; configured: boolean }> = [
    { provider: "GOOGLE", configured: googleCalendarAdapter.isConfigured() },
    { provider: "MICROSOFT", configured: microsoftCalendarAdapter.isConfigured() },
  ];
  if (process.env.CALENDAR_MOCK_PROVIDER === "1" || process.env.NODE_ENV !== "production") {
    out.push({ provider: "MOCK", configured: true });
  }
  return out;
}
