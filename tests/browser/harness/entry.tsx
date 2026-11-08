/**
 * Browser harness entry: renders one real UI component (the same module the
 * app's page renders) with the real locale messages, so a Playwright test can
 * drive it in Chromium. See harness-page.ts.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { BookingWidget } from "@/components/calendar/booking-widget";
import { ManageBooking } from "@/components/calendar/manage-booking";
import { ActionConfirmation } from "@/components/chat/action-confirmation";

type HarnessConfig = {
  component: "widget" | "manage" | "action";
  locale: string;
  messages: Record<string, unknown>;
  props: Record<string, unknown>;
};

const config = (window as unknown as { __HARNESS__: HarnessConfig }).__HARNESS__;

function Component() {
  switch (config.component) {
    case "widget":
      return <BookingWidget {...(config.props as React.ComponentProps<typeof BookingWidget>)} />;
    case "manage":
      return <ManageBooking {...(config.props as React.ComponentProps<typeof ManageBooking>)} />;
    case "action":
      return (
        <ActionConfirmation
          {...(config.props as React.ComponentProps<typeof ActionConfirmation>)}
        />
      );
  }
}

createRoot(document.getElementById("root")!).render(
  <NextIntlClientProvider locale={config.locale} messages={config.messages} timeZone="UTC">
    <Component />
  </NextIntlClientProvider>,
);
