// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";
import { BookingWidget } from "@/components/calendar/booking-widget";

/**
 * Staging QA (2026-10-07): "A confirmation email ... is on its way" was shown
 * while no email arrived. The confirmation page now only promises the email
 * when the server reports it left.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubApi(confirmationEmailSent: boolean | undefined) {
  const slot = new Date(Date.now() + 3 * 86_400_000).toISOString();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes("/slots")) {
        return new Response(JSON.stringify({ slots: [slot] }), { status: 200 });
      }
      expect(init?.method).toBe("POST");
      return new Response(
        JSON.stringify({
          bookingId: "b-1",
          manageToken: "tok",
          startsAt: slot,
          endsAt: slot,
          confirmationMessage: null,
          ...(confirmationEmailSent === undefined ? {} : { confirmationEmailSent }),
        }),
        { status: 200 },
      );
    }),
  );
}

async function book() {
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Helsinki">
      <BookingWidget
        orgSlug="acme"
        typeSlug="intro"
        locale="en"
        durationMinutes={30}
        durationOptions={[]}
        collectPhone={false}
        collectCompany={false}
        requiresConsent={false}
        brandColor={null}
      />
    </NextIntlClientProvider>,
  );
  const slotButtons = await waitFor(() => {
    const buttons = screen
      .getAllByRole("button")
      .filter((b) => /^\d{1,2}[:.]\d{2}/.test(b.textContent ?? ""));
    expect(buttons.length).toBeGreaterThan(0);
    return buttons;
  });
  fireEvent.click(slotButtons[0]!);
  fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Guest" } });
  fireEvent.change(screen.getByLabelText("Email"), { target: { value: "guest@example.com" } });
  fireEvent.submit(screen.getByLabelText("Name").closest("form")!);
  await screen.findByText(messages.booking.confirmedTitle);
}

describe("booking confirmation email note", () => {
  it("promises the email only when the server says it was sent", async () => {
    stubApi(true);
    await book();
    expect(screen.getByText(messages.booking.confirmationEmailNote)).toBeTruthy();
    expect(screen.queryByText(messages.booking.confirmationEmailFailedNote)).toBeNull();
  });

  it("says the email could not be sent, and keeps the manage link, when it failed", async () => {
    stubApi(false);
    await book();
    expect(screen.getByText(messages.booking.confirmationEmailFailedNote)).toBeTruthy();
    expect(screen.queryByText(messages.booking.confirmationEmailNote)).toBeNull();
    expect(screen.getByText(messages.booking.manageBooking).getAttribute("href")).toBe(
      "/booking/manage/tok",
    );
  });

  it("an older server that doesn't report it keeps the original note", async () => {
    stubApi(undefined);
    await book();
    expect(screen.getByText(messages.booking.confirmationEmailNote)).toBeTruthy();
  });
});
