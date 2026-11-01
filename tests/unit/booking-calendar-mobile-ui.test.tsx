// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import en from "../../messages/en.json";
import fi from "../../messages/fi.json";
import ar from "../../messages/ar.json";

/**
 * Staging QA on Android Chrome (narrow portrait, EN/FI/AR) of the booking and
 * calendar screens. Layout widths can't be measured in jsdom, so these tests
 * pin the structure the fixes rely on: names, labels, the copy result, the
 * attendee picker's clear/remove actions and its unchanged form value, the
 * month view's accessible labels, the guest language switcher and the
 * "booking page not available" page.
 */

const nav = vi.hoisted(() => ({
  pathname: "/calendar",
  query: "",
  replace: vi.fn(),
}));

vi.mock("@/actions/calendar", () => ({
  saveEventAction: vi.fn(async () => ({})),
  cancelEventAction: vi.fn(async () => ({})),
  deleteEventAction: vi.fn(async () => ({})),
  schedulingAssistantAction: vi.fn(async () => ({})),
  meetingSummaryAction: vi.fn(async () => ({})),
}));
vi.mock("@/actions/booking-types", () => ({
  saveBookingTypeAction: vi.fn(async () => ({})),
  deleteBookingTypeAction: vi.fn(async () => ({})),
}));
vi.mock("@/i18n/routing", () => ({
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => nav.pathname,
  // Renders the URL next-intl would build: the locale prefix, then the path.
  Link: ({
    href,
    locale,
    children,
    ...rest
  }: { href: string; locale?: string; children: React.ReactNode } & Record<string, unknown>) => (
    <a href={`${locale ? `/${locale}` : ""}${href}`} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
}));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async (namespace: string) => {
    const { createTranslator } = await import("next-intl");
    return createTranslator({ locale: "fi", messages: fi, namespace: namespace as never });
  }),
}));

const { EventDialog } = await import("@/components/calendar/event-dialog");
const { CalendarView } = await import("@/components/calendar/calendar-view");
const { BookingTypesManager } = await import("@/components/calendar/booking-types-manager");
const { PublicLanguageSwitcher } = await import("@/components/calendar/public-language-switcher");
const { default: BookingPageUnavailable } =
  await import("@/app/[locale]/(public)/book/[org]/[slug]/not-found");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MESSAGES = { en, fi, ar } as const;

let root: Root | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
beforeEach(() => {
  nav.pathname = "/calendar";
  nav.query = "";
  nav.replace.mockClear();
});

async function render(ui: React.ReactNode, locale: keyof typeof MESSAGES = "en") {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <NextIntlClientProvider
        locale={locale}
        messages={MESSAGES[locale]}
        timeZone="Europe/Helsinki"
      >
        {ui}
      </NextIntlClientProvider>,
    );
  });
  return host;
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error("element not found");
  await act(async () => {
    (el as HTMLElement).click();
  });
}

const CONTACTS = [
  { id: "c-anna", name: "Anna Virtanen" },
  { id: "c-ben", name: "Ben Example" },
];

function eventDialog(onClose = vi.fn()) {
  return (
    <EventDialog
      date="2026-11-02"
      prefill={null}
      timeZone="Europe/Helsinki"
      canWrite
      canDelete={false}
      options={{ owners: [], contacts: CONTACTS, companies: [], deals: [] }}
      onClose={onClose}
    />
  );
}

function attendeesValue(host: HTMLElement) {
  const input = host.querySelector<HTMLInputElement>('input[name="attendees"]')!;
  return JSON.parse(input.value) as Array<{ contactId?: string; email?: string }>;
}

describe("event dialog on a phone", () => {
  it("is a labelled modal that Escape closes", async () => {
    const onClose = vi.fn();
    const host = await render(eventDialog(onClose));
    const dialog = host.querySelector('[role="dialog"]')!;
    const titleId = dialog.getAttribute("aria-labelledby")!;
    expect(document.getElementById(titleId)?.textContent).toBe("New event");

    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab and Shift+Tab inside the dialog (the calendar behind stays out of reach)", async () => {
    const host = await render(eventDialog());
    const dialog = host.querySelector<HTMLElement>('[role="dialog"]')!;
    const focusable = Array.from(
      dialog.querySelectorAll<HTMLElement>(
        'a[href], button, input:not([type="hidden"]), select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).filter((el) => !el.hasAttribute("disabled"));
    const first = focusable[0]!;
    const last = focusable.at(-1)!;
    const tab = (shiftKey = false) =>
      act(async () => {
        document.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", shiftKey, cancelable: true }),
        );
      });

    // Focus starts on the dialog itself: Tab enters at the first control.
    expect(document.activeElement).toBe(dialog);
    await tab();
    expect(document.activeElement).toBe(first);
    await tab(true);
    expect(document.activeElement).toBe(last);
    await tab();
    expect(document.activeElement).toBe(first);
  });

  it("fits the viewport: dynamic-viewport height, screen-bound width, scrolls inside", async () => {
    const host = await render(eventDialog());
    const card = host.querySelector('[role="dialog"] > div')!;
    expect(card.className).toContain("max-h-[calc(100dvh-2rem)]");
    expect(card.className).toContain("max-w-[min(32rem,calc(100vw-2rem))]");
    expect(card.className).toContain("overflow-y-auto");
  });

  it("stacks start/end and timezone/repeat on narrow screens", async () => {
    const host = await render(eventDialog());
    for (const id of ["startsAt", "timezone"]) {
      const grid = host.querySelector(`#${id}`)!.parentElement!.parentElement!;
      expect(grid.className).toContain("grid-cols-1");
      expect(grid.className).toContain("sm:grid-cols-2");
    }
  });

  it("guest emails have a visible label and a wrapping hint, not a clipped placeholder", async () => {
    const host = await render(eventDialog(), "fi");
    const input = host.querySelector<HTMLInputElement>("#guestEmails")!;
    expect(host.querySelector('label[for="guestEmails"]')?.textContent).toBe(
      "Vieraiden sähköpostit",
    );
    expect(input.placeholder).toBe("");
    const hint = document.getElementById(input.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe(fi.calendar.fields.guestEmailsHint);
    expect(hint.className).toContain("break-words");
  });
});

describe("attendee picker", () => {
  it("lists every contact as a labelled checkbox; nothing is selected at first", async () => {
    const host = await render(eventDialog());
    const group = host.querySelector("fieldset[aria-labelledby]")!;
    expect(document.getElementById(group.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Attendees",
    );
    const boxes = [...group.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.map((b) => b.closest("label")!.textContent)).toEqual([
      "Anna Virtanen",
      "Ben Example",
    ]);
    expect(group.textContent).toContain("No contacts selected");
    expect(attendeesValue(host)).toEqual([]);
  });

  it("checked contacts become chips with a remove button, and the form value carries their ids", async () => {
    const host = await render(eventDialog());
    const boxes = host.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]');
    await click(boxes[0]);
    await click(boxes[1]);

    expect(host.textContent).toContain("2 contacts selected");
    expect(attendeesValue(host)).toEqual([{ contactId: "c-anna" }, { contactId: "c-ben" }]);

    await click(host.querySelector('button[aria-label="Remove Anna Virtanen"]'));
    expect(attendeesValue(host)).toEqual([{ contactId: "c-ben" }]);
    expect(boxes[0]!.checked).toBe(false);
  });

  it("Clear all removes every contact but keeps typed guest emails", async () => {
    const host = await render(eventDialog());
    const boxes = host.querySelectorAll<HTMLInputElement>('fieldset input[type="checkbox"]');
    await click(boxes[0]);
    await click(boxes[1]);
    const emails = host.querySelector<HTMLInputElement>("#guestEmails")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setValue.call(emails, "guest@example.com");
      emails.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const clear = [...host.querySelectorAll("button")].find((b) => b.textContent === "Clear all");
    await click(clear);

    expect(attendeesValue(host)).toEqual([{ email: "guest@example.com" }]);
    expect(host.querySelector('button[aria-label^="Remove"]')).toBeNull();
    expect([...boxes].every((b) => !b.checked)).toBe(true);
  });

  it("the checkboxes submit nothing themselves (the hidden attendees field stays the only contract)", async () => {
    const host = await render(eventDialog());
    await click(host.querySelector('fieldset input[type="checkbox"]'));
    const names = [...new FormData(host.querySelector("form")!).keys()];
    expect(names.filter((n) => n === "attendees")).toHaveLength(1);
    expect(names).not.toContain("attendeeContacts");
    expect(host.querySelectorAll("fieldset input[name]")).toHaveLength(0);
  });
});

describe("booking pages: public URL and copy", () => {
  const LONG_URL_BASE = "https://app.example.com/book/a-very-long-organization-slug-for-testing";
  const types = [
    {
      id: "bt-1",
      slug: "initial-consultation-sixty-minutes",
      name: "Initial consultation",
      description: null,
      durationMinutes: 60,
      durationOptions: [],
      locationType: "VIDEO",
      location: null,
      bufferBeforeMinutes: 0,
      bufferAfterMinutes: 0,
      minNoticeMinutes: 120,
      maxWindowDays: 60,
      brandColor: null,
      confirmationMessage: null,
      collectPhone: false,
      collectCompany: false,
      requiresConsent: true,
      isActive: true,
      scheduleId: null,
    },
  ];
  const fullUrl = `${LONG_URL_BASE}/initial-consultation-sixty-minutes`;

  function manager(locale: keyof typeof MESSAGES = "en") {
    return render(
      <BookingTypesManager types={types} schedules={[]} baseUrl={LONG_URL_BASE} />,
      locale,
    );
  }

  function copyButton(host: HTMLElement) {
    return [...host.querySelectorAll("button")].find((b) => b.textContent === "Copy link")!;
  }

  it("shows the whole URL, wrapping and left-to-right even in Arabic, and the copy button is described by it", async () => {
    const host = await manager("ar");
    const button = [...host.querySelectorAll("button")].find(
      (b) => b.textContent === ar.calendar.bookingTypes.copyLink,
    )!;
    const url = document.getElementById(button.getAttribute("aria-describedby")!)!;
    expect(url.textContent).toBe(fullUrl);
    expect(url.getAttribute("dir")).toBe("ltr");
    expect(url.className).toContain("break-all");
    expect(url.className).not.toContain("truncate");
  });

  it("copies the URL and announces it", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const host = await manager();
    await click(copyButton(host));
    expect(writeText).toHaveBeenCalledWith(fullUrl);
    expect(host.querySelector('[role="status"]')?.textContent).toBe("Copied!");
  });

  it("says so when copying is refused, instead of claiming it was copied", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("denied"))) },
    });
    const host = await manager();
    await click(copyButton(host));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      en.calendar.bookingTypes.copyFailed,
    );
  });

  it("a browser without clipboard access gets the same message, not a crash", async () => {
    vi.stubGlobal("navigator", {});
    const host = await manager();
    await click(copyButton(host));
    expect(host.querySelector('[role="status"]')?.textContent).toBe(
      en.calendar.bookingTypes.copyFailed,
    );
  });

  it("the edit dialog is a labelled modal with stacked fields on phones", async () => {
    const host = await manager();
    await click([...host.querySelectorAll("button")].find((b) => b.textContent === "Edit"));
    const dialog = host.querySelector('[role="dialog"]')!;
    expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe(
      "Initial consultation",
    );
    const nameGrid = host.querySelector("#bt-name")!.parentElement!.parentElement!;
    expect(nameGrid.className).toContain("grid-cols-1");
  });
});

describe("month view labels", () => {
  const event = (id: string, startsAt: string, title: string) => ({
    id,
    title,
    startsAt,
    endsAt: new Date(new Date(startsAt).getTime() + 30 * 60_000).toISOString(),
    allDay: false,
    source: "BOOKING",
    status: "CONFIRMED",
    timezone: "Europe/Helsinki",
    location: null,
    description: null,
    recurrenceRule: null,
    isOccurrence: false,
    contactId: null,
    companyId: null,
    dealId: null,
    ownerId: null,
    attendees: [],
  });
  // Monday 2026-11-02, 10:00 and 13:30 Helsinki (EET, UTC+2).
  const events = [
    event("e1", "2026-11-02T08:00:00.000Z", "Intro call — Guest One"),
    event("e2", "2026-11-02T11:30:00.000Z", "Follow-up"),
  ];

  function month() {
    return render(
      <CalendarView
        view="month"
        anchor="2026-11-01"
        q=""
        events={events}
        canWrite
        canDelete={false}
        options={{ owners: [], contacts: [], companies: [], deals: [] }}
        timeZone="Europe/Helsinki"
      />,
    );
  }

  it("each event chip is named by its full time and title, also as a tooltip", async () => {
    const host = await month();
    const time = (iso: string) =>
      new Intl.DateTimeFormat("en", {
        hour: "2-digit",
        minute: "2-digit",
        timeZone: "Europe/Helsinki",
      }).format(new Date(iso));
    const chips = [...host.querySelectorAll("button[title]")];
    expect(chips.map((c) => [c.getAttribute("aria-label"), c.getAttribute("title")])).toEqual([
      [
        `${time(events[0]!.startsAt)} Intro call — Guest One`,
        `${time(events[0]!.startsAt)} Intro call — Guest One`,
      ],
      [`${time(events[1]!.startsAt)} Follow-up`, `${time(events[1]!.startsAt)} Follow-up`],
    ]);
    expect(chips[0]!.getAttribute("aria-label")).toMatch(/^10:00/);
  });

  it("on phones the day shows a count named in words, which opens that day", async () => {
    const host = await month();
    const count = host.querySelector(
      'button[aria-label="2 events on Monday, November 2. Open the day view."]',
    )!;
    expect(count.textContent).toBe("2");
    expect(count.className).toContain("sm:hidden");

    await click(count);
    expect(nav.replace).toHaveBeenCalledWith("/calendar?view=day&date=2026-11-02");
  });
});

describe("guest language switcher", () => {
  it("offers FI/EN/AR, each named in itself, keeping the booking path and query", async () => {
    nav.pathname = "/book/acme/intro-call";
    nav.query = "utm_source=newsletter";
    const host = await render(<PublicLanguageSwitcher />, "fi");

    const navEl = host.querySelector("nav")!;
    expect(navEl.getAttribute("aria-label")).toBe("Kieli");
    const links = [...navEl.querySelectorAll("a")];
    expect(
      links.map((a) => [a.textContent, a.getAttribute("href"), a.getAttribute("lang")]),
    ).toEqual([
      ["Suomi", "/fi/book/acme/intro-call?utm_source=newsletter", "fi"],
      ["English", "/en/book/acme/intro-call?utm_source=newsletter", "en"],
      ["العربية", "/ar/book/acme/intro-call?utm_source=newsletter", "ar"],
    ]);
    expect(links.map((a) => a.getAttribute("aria-current"))).toEqual(["page", null, null]);
  });

  it("marks Arabic as current on the Arabic page", async () => {
    nav.pathname = "/book/acme/intro-call";
    const host = await render(<PublicLanguageSwitcher />, "ar");
    const current = host.querySelector('a[aria-current="page"]')!;
    expect(current.getAttribute("href")).toBe("/ar/book/acme/intro-call");
    expect(host.querySelector("nav")!.getAttribute("aria-label")).toBe("اللغة");
  });

  it("is on the public booking page", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/app/[locale]/(public)/book/[org]/[slug]/page.tsx", "utf8"),
    );
    expect(source).toContain("<PublicLanguageSwitcher />");
  });
});

describe("booking page not available", () => {
  it("explains it in the guest's language, offers the switcher, and names nothing from the link", async () => {
    nav.pathname = "/book/acme-private-org/paused-type";
    const page = await BookingPageUnavailable();
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="fi" messages={fi} timeZone="Europe/Helsinki">
        {page}
      </NextIntlClientProvider>,
    );

    expect(html).toContain(
      `<h1 class="text-xl font-semibold">${fi.booking.unavailable.title}</h1>`,
    );
    expect(html).toContain(fi.booking.unavailable.description);
    expect(html).toContain(fi.booking.unavailable.contactHint);
    expect(html).toContain('aria-label="Kieli"');
    // The only place the path appears is the switcher's own links back to it.
    const withoutLinks = html.replace(/href="[^"]*"/g, "");
    expect(withoutLinks).not.toContain("acme-private-org");
    expect(withoutLinks).not.toContain("paused-type");
  });
});
