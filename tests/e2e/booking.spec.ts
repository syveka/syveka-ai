import { test, expect } from "@playwright/test";
import { hasDbAccess, getDbClient, findE2EFixtureMembership } from "./helpers/db";

/**
 * The public booking flow (src/app/[locale]/(public)/book/[org]/[slug]) had
 * zero prior coverage and is unauthenticated — a broken link here is the
 * first thing a pilot customer's own customers would hit. Two tests:
 *
 * 1. Always runs, no seeding: an unknown org/booking-type slug must 404
 *    cleanly rather than crash or hang — this alone needs no fixture data.
 * 2. Best-effort: if the shared E2E org already has a real, active booking
 *    type (scripts/ensure-e2e-org-fixture.ts does not create one today), the
 *    full guest journey runs end to end and cancels its own booking
 *    afterward. Otherwise it skips with a concrete reason rather than
 *    fabricating availability data inline — seeding a BookingType +
 *    AvailabilitySchedule is a real feature decision (open hours, duration,
 *    consent copy) that belongs in a deliberate follow-up to
 *    ensure-e2e-org-fixture.ts, not invented ad hoc here.
 */
test.describe("public booking", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("an unknown org/booking-type slug 404s instead of crashing", async ({ page }) => {
    const response = await page.goto("/book/not-a-real-org/not-a-real-slug");
    expect(response?.status()).toBe(404);
  });

  test("a guest can complete and then cancel a real booking, if one is configured", async ({
    page,
  }, testInfo) => {
    test.skip(testInfo.project.name !== "desktop", "Read-only DB lookup; running once is enough.");
    test.skip(
      !hasDbAccess(),
      "Requires DATABASE_URL to look up the E2E org's slug and any active booking type.",
    );

    const prisma = getDbClient();
    const { organizationId } = await findE2EFixtureMembership(prisma);
    const org = await prisma.organization.findUniqueOrThrow({
      where: { id: organizationId },
      select: { slug: true },
    });
    const bookingType = await prisma.bookingType.findFirst({
      where: { organizationId, isActive: true },
      select: { slug: true },
    });

    test.skip(
      !bookingType,
      "The E2E fixture org has no active BookingType yet — provisioning one (schedule, hours, " +
        "duration) is a deliberate follow-up to scripts/ensure-e2e-org-fixture.ts, not done here.",
    );

    await page.goto(`/book/${org.slug}/${bookingType!.slug}`);

    const noSlots = page.getByText("Ei vapaita aikoja tällä välillä");
    const slotButtons = page.getByRole("button").filter({ hasText: /\d{1,2}[:.]\d{2}/ });

    if (await noSlots.isVisible().catch(() => false)) {
      test.skip(
        true,
        "Booking type exists but has no open slots in its current availability window.",
      );
    }

    await slotButtons.first().click();
    await page.getByLabel("Nimi").fill("E2E Guest");
    await page.getByLabel("Sähköposti").fill(`e2e-guest-${Date.now()}@example.invalid`);

    const consent = page.getByRole("checkbox");
    if (await consent.isVisible().catch(() => false)) {
      await consent.check();
    }

    await page.getByRole("button", { name: "Vahvista varaus" }).click();

    await expect(page.getByText("Varaus vahvistettu")).toBeVisible({ timeout: 15_000 });

    const manageLink = page.getByRole("link", { name: "Hallitse varausta" });
    await manageLink.click();
    await page.getByRole("button", { name: "Peru varaus" }).click();
    await expect(page.getByText("Varaus peruttu")).toBeVisible({ timeout: 10_000 });
  });
});
