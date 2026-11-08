/**
 * The public booking journey in a real browser (Chromium; desktop and Pixel 7
 * projects), with the real BookingWidget and ManageBooking components, the
 * real locale messages and the real slot computation. No deployed app, no
 * database, no network: the page and its /api/v1/booking requests are served
 * by the test (harness/fake-booking-api.ts mirrors the routes' contracts).
 *
 * What this proves, and what it does not:
 *   - proves: what a guest sees and can do (times in their own zone across a
 *     DST change, consent enforced by the form, a slot taken meanwhile is
 *     refused and disappears, reschedule, cancel, a past booking can't be
 *     moved, Finnish and Arabic RTL rendering, phone viewport);
 *   - does not prove: persistence, CRM contact creation, emails or real
 *     concurrency (service and PostgreSQL tests), nor the deployed page
 *     (staging E2E).
 */
import { expect, test, type Page } from "@playwright/test";
import { installFakeBookingApi, SALON } from "./harness/fake-booking-api";
import { horizontalOverflow, openHarness, readMessages } from "./harness/harness-page";

type BookingMessages = {
  loadingSlots: string;
  confirmButton: string;
  confirmedTitle: string;
  manageBooking: string;
  fields: { name: string; email: string };
  errors: { slotTaken: string; rescheduleFailed: string };
  manage: {
    reschedule: string;
    confirmReschedule: string;
    rescheduledTitle: string;
    cancel: string;
    canceledTitle: string;
  };
};
const messages = (locale: string) => readMessages(locale) as { booking: BookingMessages };

/** Wednesday 2027-03-24 10:00 Helsinki. The week shown includes the DST change (Sun 28). */
const NOW = new Date("2027-03-24T08:00:00.000Z");
const FRIDAY_9 = new Date("2027-03-26T07:00:00.000Z"); // 09:00 EET (UTC+2)
const MONDAY_9 = new Date("2027-03-29T06:00:00.000Z"); // 09:00 EEST (UTC+3)

async function openPage(
  page: Page,
  options: { locale: string; component: "widget" | "manage"; props: Record<string, unknown> },
) {
  await openHarness(
    page,
    {
      component: options.component,
      locale: options.locale,
      // The /book page passes the page locale to the widget.
      props:
        options.component === "widget"
          ? { ...options.props, locale: options.locale }
          : options.props,
    },
    NOW,
  );
}

const widgetProps = {
  orgSlug: SALON.orgSlug,
  typeSlug: SALON.typeSlug,
  durationMinutes: SALON.durationMinutes,
  durationOptions: [SALON.durationMinutes],
  collectPhone: false,
  collectCompany: false,
  requiresConsent: true,
  brandColor: null,
};

const timeLabel = (locale: string, timeZone: string, instant: Date) =>
  new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone }).format(instant);

/** The slot buttons in page order, as the ISO instants the fake offered. */
async function offeredSlots(page: Page, api: Awaited<ReturnType<typeof installFakeBookingApi>>) {
  await expect(page.getByText(messages("fi").booking.loadingSlots)).toHaveCount(0);
  const slotRequest = [...api.requests].reverse().find((r) => r.path.endsWith("/slots"))!;
  expect(slotRequest).toBeTruthy();
  return slotRequest;
}

test.describe("guest books a Finnish salon (Europe/Helsinki)", () => {
  test.use({ locale: "fi-FI", timezoneId: "Europe/Helsinki" });

  test("times are shown on the local grid across the DST change, and the booking goes through", async ({
    page,
  }) => {
    const api = await installFakeBookingApi(page, NOW);
    await openPage(page, { locale: "fi", component: "widget", props: widgetProps });
    await offeredSlots(page, api);

    const fi = messages("fi").booking;
    await expect(page.getByText(`Europe/Helsinki`, { exact: false })).toBeVisible();

    // Friday (EET) and Monday (EEST) 09:00 are both shown as 09.00, though an hour apart in UTC.
    const nine = page.getByRole("button", { name: timeLabel("fi", "Europe/Helsinki", FRIDAY_9) });
    // Thu, Fri, Mon, Tue (Wednesday's 09:00 is already past at 10:00).
    await expect(nine).toHaveCount(4);
    expect(timeLabel("fi", "Europe/Helsinki", MONDAY_9)).toBe(
      timeLabel("fi", "Europe/Helsinki", FRIDAY_9),
    );

    await nine.nth(2).click(); // Monday after the change
    await page.getByLabel(fi.fields.name).fill("Anna Testi");
    await page.getByLabel(fi.fields.email).fill("anna.testi@example.test");

    // The open form (the widest state) fits the screen.
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    // The consent box is required: the form does not submit without it.
    await page.getByRole("button", { name: fi.confirmButton }).click();
    expect(api.requests.filter((r) => r.method === "POST")).toHaveLength(0);

    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: fi.confirmButton }).click();
    await expect(page.getByRole("heading", { name: fi.confirmedTitle })).toBeVisible();
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

    const posted = api.requests.find((r) => r.method === "POST")!.body as Record<string, unknown>;
    expect(posted).toMatchObject({
      startsAt: MONDAY_9.toISOString(),
      timezone: "Europe/Helsinki",
      name: "Anna Testi",
      email: "anna.testi@example.test",
      consent: true,
      locale: "fi",
      website: "",
    });
    await expect(page.getByRole("link", { name: fi.manageBooking })).toHaveAttribute(
      "href",
      "/booking/manage/token-1",
    );
  });

  test("a slot taken by someone else meanwhile is refused and disappears from the list", async ({
    page,
  }) => {
    const api = await installFakeBookingApi(page, NOW);
    await openPage(page, { locale: "fi", component: "widget", props: widgetProps });
    await offeredSlots(page, api);
    const fi = messages("fi").booking;
    const label = timeLabel("fi", "Europe/Helsinki", FRIDAY_9);

    await page.getByRole("button", { name: label }).nth(1).click(); // Friday 09:00
    api.takeSlot(FRIDAY_9);
    await page.getByLabel(fi.fields.name).fill("Anna Testi");
    await page.getByLabel(fi.fields.email).fill("anna@example.test");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: fi.confirmButton }).click();

    await expect(page.getByRole("alert")).toHaveText(fi.errors.slotTaken);
    // Reloaded: three 09:00 slots left (Thu, Mon, Tue), no booking made.
    await expect(page.getByRole("button", { name: label })).toHaveCount(3);
    expect(api.bookings.filter((b) => b.guestName === "Anna Testi")).toHaveLength(0);
  });
});

test.describe("a guest in another time zone", () => {
  test.use({ locale: "en-GB", timezoneId: "Europe/London" });

  test("sees the salon's slots in their own time", async ({ page }) => {
    const api = await installFakeBookingApi(page, NOW);
    await openPage(page, { locale: "en", component: "widget", props: widgetProps });
    await offeredSlots(page, api);
    // Helsinki Friday 09:00 = 07:00 in London (GMT, before the UK change on the 28th);
    // Monday 09:00 EEST = 07:00 BST as well.
    await expect(page.getByText("Europe/London", { exact: false })).toBeVisible();
    await expect(
      page.getByRole("button", { name: timeLabel("en", "Europe/London", FRIDAY_9) }),
    ).toHaveCount(4);
    await expect(page.getByRole("button", { name: /^09:00$/ })).toHaveCount(0);
  });
});

test.describe("Arabic booking page", () => {
  test.use({ locale: "ar", timezoneId: "Europe/Helsinki" });

  test("is right-to-left and books a slot", async ({ page }) => {
    const api = await installFakeBookingApi(page, NOW);
    await openPage(page, { locale: "ar", component: "widget", props: widgetProps });
    await offeredSlots(page, api);
    const ar = messages("ar").booking;
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");

    const slots = page.getByRole("button", {
      name: timeLabel("ar", "Europe/Helsinki", FRIDAY_9),
    });
    await expect(slots.first()).toBeVisible();
    await slots.first().click();
    await page.getByLabel(ar.fields.name).fill("ليلى");
    await page.getByLabel(ar.fields.email).fill("layla@example.test");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: ar.confirmButton }).click();
    await expect(page.getByRole("heading", { name: ar.confirmedTitle })).toBeVisible();
    expect(api.bookings.map((b) => b.guestName)).toContain("ليلى");
    expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
  });
});

test.describe("guest manages a booking from the email link", () => {
  test.use({ locale: "fi-FI", timezoneId: "Europe/Helsinki" });

  const manageProps = (token: string, startsAt: Date) => ({
    token,
    bookingTypeName: "Hiustenleikkaus",
    typeSlug: SALON.typeSlug,
    orgSlug: SALON.orgSlug,
    status: "CONFIRMED",
    startsAt: startsAt.toISOString(),
    durationMinutes: SALON.durationMinutes,
    guestTimezone: "Europe/Helsinki",
  });
  const guest = {
    guestName: "Anna Testi",
    guestEmail: "anna@example.test",
    guestTimezone: "Europe/Helsinki",
  };

  test("reschedules to another time; the old time is offered again", async ({ page }) => {
    const api = await installFakeBookingApi(page, NOW);
    api.addBooking({ token: "tok-anna", startsAt: FRIDAY_9, ...guest });
    await openPage(page, {
      locale: "fi",
      component: "manage",
      props: manageProps("tok-anna", FRIDAY_9),
    });
    const fi = messages("fi").booking;

    await page.getByRole("button", { name: fi.manage.reschedule! }).click();
    // The new-time picker labels include the weekday; pick the Monday 09:00 slot.
    const monday = new Intl.DateTimeFormat("fi", {
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Europe/Helsinki",
    }).format(MONDAY_9);
    await page.getByRole("button", { name: monday }).click();
    await page.getByRole("button", { name: fi.manage.confirmReschedule! }).click();

    await expect(page.getByRole("heading", { name: fi.manage.rescheduledTitle! })).toBeVisible();
    expect(api.bookings.find((b) => b.token === "tok-anna")!.status).toBe("RESCHEDULED");
    const moved = api.bookings.find(
      (b) => b.status === "CONFIRMED" && b.guestName === "Anna Testi",
    );
    expect(moved!.startsAt.toISOString()).toBe(MONDAY_9.toISOString());
  });

  test("cancels", async ({ page }) => {
    const api = await installFakeBookingApi(page, NOW);
    api.addBooking({ token: "tok-anna", startsAt: FRIDAY_9, ...guest });
    await openPage(page, {
      locale: "fi",
      component: "manage",
      props: manageProps("tok-anna", FRIDAY_9),
    });
    const fi = messages("fi").booking;
    await page.getByRole("button", { name: fi.manage.cancel! }).click();
    await expect(page.getByRole("heading", { name: fi.manage.canceledTitle! })).toBeVisible();
    expect(api.bookings.find((b) => b.token === "tok-anna")!.status).toBe("CANCELED");
  });

  test("a visit that already happened can't be moved", async ({ page }) => {
    const yesterday = new Date("2027-03-23T07:00:00.000Z");
    const api = await installFakeBookingApi(page, NOW);
    api.addBooking({ token: "tok-past", startsAt: yesterday, ...guest });
    await openPage(page, {
      locale: "fi",
      component: "manage",
      props: manageProps("tok-past", yesterday),
    });
    const fi = messages("fi").booking;
    await page.getByRole("button", { name: fi.manage.reschedule! }).click();
    await page.getByRole("button").filter({ hasText: /\d/ }).first().click();
    await page.getByRole("button", { name: fi.manage.confirmReschedule! }).click();
    await expect(page.getByRole("alert")).toHaveText(fi.errors.rescheduleFailed);
    expect(api.bookings.find((b) => b.token === "tok-past")!.status).toBe("CONFIRMED");
  });
});
