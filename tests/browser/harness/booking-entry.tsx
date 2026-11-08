/**
 * Browser harness entry: renders the real public booking components (the same
 * modules the /book and /booking/manage pages render) with the real locale
 * messages, so a Playwright test can drive them in Chromium. The page and its
 * /api/v1/booking requests are served by the test (see booking-journey.spec.ts).
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { BookingWidget } from "@/components/calendar/booking-widget";
import { ManageBooking } from "@/components/calendar/manage-booking";

type HarnessConfig =
  | {
      component: "widget";
      locale: string;
      messages: Record<string, unknown>;
      props: React.ComponentProps<typeof BookingWidget>;
    }
  | {
      component: "manage";
      locale: string;
      messages: Record<string, unknown>;
      props: React.ComponentProps<typeof ManageBooking>;
    };

const config = (window as unknown as { __HARNESS__: HarnessConfig }).__HARNESS__;

createRoot(document.getElementById("root")!).render(
  <NextIntlClientProvider locale={config.locale} messages={config.messages} timeZone="UTC">
    {config.component === "widget" ? (
      <BookingWidget {...config.props} />
    ) : (
      <ManageBooking {...config.props} />
    )}
  </NextIntlClientProvider>,
);
