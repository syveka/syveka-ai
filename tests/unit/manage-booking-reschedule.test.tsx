// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";
import { ManageBooking } from "@/components/calendar/manage-booking";

/**
 * Guest reschedule page (/booking/manage/[token]).
 * - The new-time slots were requested at the booking type's default length,
 *   so a 45-minute booking of a 30-minute type was offered 30-minute gaps.
 *   The page now passes the booking's own length and the request carries it.
 * - After a reschedule the page promised a confirmation email even when none
 *   left; it now follows the server's confirmationEmailSent and always links
 *   to the new manage token (the old one no longer works).
 *
 * Mocked: booking lookup, organization lookup, fetch. Real: page, component, messages.
 */

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/server/services/booking", () => ({
  getBookingByToken: vi.fn(async (): Promise<unknown> => ({
    organizationId: "org-a",
    status: "CONFIRMED",
    startsAt: new Date("2026-11-02T09:00:00.000Z"),
    endsAt: new Date("2026-11-02T09:45:00.000Z"),
    guestTimezone: "Europe/Helsinki",
    bookingType: {
      name: "Intro call",
      slug: "intro",
      durationOptions: [30, 45],
      durationMinutes: 30,
    },
  })),
}));
vi.mock("@/server/services/booking-tokens", () => ({
  BookingTokenError: class BookingTokenError extends Error {},
}));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: { organization: { findUnique: vi.fn(async () => ({ slug: "acme" })) } },
}));

import ManageBookingPage from "@/app/[locale]/(public)/booking/manage/[token]/page";
import { getBookingByToken } from "@/server/services/booking";

const SLOT = "2026-11-05T10:00:00.000Z";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function stubApi(confirmationEmailSent: boolean) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (String(url).includes("/slots")) {
      return new Response(JSON.stringify({ slots: [SLOT] }), { status: 200 });
    }
    expect(init?.method).toBe("POST");
    return new Response(
      JSON.stringify({
        bookingId: "b-1",
        manageToken: "tok-new",
        startsAt: SLOT,
        confirmationEmailSent,
      }),
      { status: 200 },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function renderManage() {
  render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Helsinki">
      <ManageBooking
        token="tok-old"
        bookingTypeName="Intro call"
        typeSlug="intro"
        orgSlug="acme"
        status="CONFIRMED"
        startsAt="2026-11-02T09:00:00.000Z"
        durationMinutes={45}
        guestTimezone="Europe/Helsinki"
      />
    </NextIntlClientProvider>,
  );
}

async function openReschedule() {
  fireEvent.click(screen.getByRole("button", { name: messages.booking.manage.reschedule }));
  const fixed = [messages.booking.manage.confirmReschedule, messages.booking.manage.back];
  return waitFor(() => {
    const slotButtons = screen
      .getAllByRole("button")
      .filter((b) => !fixed.includes(b.textContent ?? ""));
    expect(slotButtons).toHaveLength(1);
    return slotButtons[0]!;
  });
}

async function reschedule() {
  fireEvent.click(await openReschedule());
  fireEvent.click(screen.getByRole("button", { name: messages.booking.manage.confirmReschedule }));
  await screen.findByText(messages.booking.manage.rescheduledTitle);
}

describe("reschedule slots use the booking's own length", () => {
  it("the page passes the booking's duration in minutes", async () => {
    const el = (await ManageBookingPage({ params: Promise.resolve({ token: "tok-old" }) })) as {
      props: Record<string, unknown>;
    };
    expect(el.props).toMatchObject({ orgSlug: "acme", typeSlug: "intro", durationMinutes: 45 });
  });

  it("uses the type's default when the type no longer offers the booking's length", async () => {
    // The server reschedules at the default then, and refuses slots for an
    // unoffered length, so asking for 45 here would make rescheduling fail.
    vi.mocked(getBookingByToken).mockResolvedValueOnce({
      organizationId: "org-a",
      status: "CONFIRMED",
      startsAt: new Date("2026-11-02T09:00:00.000Z"),
      endsAt: new Date("2026-11-02T09:45:00.000Z"),
      guestTimezone: "Europe/Helsinki",
      bookingType: {
        name: "Intro call",
        slug: "intro",
        durationOptions: [30],
        durationMinutes: 30,
      },
    } as never);
    const el = (await ManageBookingPage({ params: Promise.resolve({ token: "tok-old" }) })) as {
      props: Record<string, unknown>;
    };
    expect(el.props).toMatchObject({ durationMinutes: 30 });
  });

  it("the slots request carries that duration", async () => {
    const fetchMock = stubApi(true);
    renderManage();
    await openReschedule();
    const slotsUrl = String(fetchMock.mock.calls[0]![0]);
    expect(slotsUrl).toContain("/api/v1/booking/acme/intro/slots?");
    expect(new URL(slotsUrl, "http://localhost").searchParams.get("duration")).toBe("45");
  });
});

describe("rescheduled confirmation", () => {
  it("says the email could not be sent, and links to the new manage token, when it failed", async () => {
    stubApi(false);
    renderManage();
    await reschedule();
    expect(screen.getByText(messages.booking.confirmationEmailFailedNote)).toBeTruthy();
    expect(screen.queryByText(messages.booking.confirmationEmailNote)).toBeNull();
    expect(screen.getByText(messages.booking.manageBooking).getAttribute("href")).toBe(
      "/booking/manage/tok-new",
    );
  });

  it("promises the email when it was sent, and still links to the new manage token", async () => {
    stubApi(true);
    renderManage();
    await reschedule();
    expect(screen.getByText(messages.booking.confirmationEmailNote)).toBeTruthy();
    expect(screen.queryByText(messages.booking.confirmationEmailFailedNote)).toBeNull();
    expect(screen.getByText(messages.booking.manageBooking).getAttribute("href")).toBe(
      "/booking/manage/tok-new",
    );
  });
});
