// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";
import { BookingWidget } from "@/components/calendar/booking-widget";

/**
 * The public booking page is server-rendered on Vercel (runtime zone UTC)
 * and hydrated in the guest's browser (e.g. Europe/Helsinki). Anything the
 * widget renders from the *runtime* timezone during that first render
 * differs between the two and fails hydration -- React's production build
 * reports it as error #418 (seen on staging 2026-10-07 02:29 EEST on
 * /[locale]/book/[org]/[slug]). This renders on the "server" in one zone and
 * hydrates in another, and requires zero hydration errors.
 */

const realResolvedOptions = Intl.DateTimeFormat.prototype.resolvedOptions;

function runtimeTimeZone(timeZone: string) {
  vi.spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions").mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...realResolvedOptions.call(this), timeZone };
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

function widget() {
  return (
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
    </NextIntlClientProvider>
  );
}

async function hydrationErrors(serverZone: string, browserZone: string): Promise<unknown[]> {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ slots: [] }), { status: 200 })),
  );
  runtimeTimeZone(serverZone);
  const html = renderToString(widget());
  vi.restoreAllMocks();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ slots: [] }), { status: 200 })),
  );

  runtimeTimeZone(browserZone);
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const errors: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => {
    hydrateRoot(container, widget(), { onRecoverableError: (error) => errors.push(error) });
  });
  return errors;
}

describe("public booking widget hydration", () => {
  it.each([
    ["UTC", "Europe/Helsinki"],
    ["UTC", "America/New_York"],
    ["UTC", "Asia/Tokyo"],
    ["UTC", "UTC"],
  ])("server zone %s, browser zone %s: hydrates without a mismatch", async (server, browser) => {
    expect(await hydrationErrors(server, browser)).toEqual([]);
  });

  it("after hydration, shows the guest's own browser timezone", async () => {
    await hydrationErrors("UTC", "Europe/Helsinki");
    await act(async () => {});
    expect(document.body.textContent).toContain("Times shown in Europe/Helsinki");
    expect(document.body.textContent).not.toContain("Times shown in UTC");
  });
});
