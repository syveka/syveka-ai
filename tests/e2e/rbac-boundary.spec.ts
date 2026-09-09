import { test, expect } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";
import { hasDbAccess, getDbClient, findE2EFixtureMembership } from "./helpers/db";

/**
 * No prior E2E test rendered the app under any role but the fixture's own
 * (OWNER). RBAC is unit-tested at the `can()`/service layer (crm-rbac.test.ts
 * etc.) but nothing proves the delete control is actually absent from the
 * rendered DOM for a role that lacks crm:delete — that's a real UI-layer
 * bug class unit tests can't catch (e.g. a component checking the wrong
 * permission constant would still pass every server-side unit test).
 *
 * This temporarily downgrades the shared E2E fixture user's *role* (not a
 * second identity — getTenantContext() reads the role fresh from the
 * database on every request, so no re-login is needed to observe the
 * change) and always restores it in `finally`, seeding and removing its own
 * disposable contact so the check isn't vacuously true against an empty list.
 *
 * MEMBER lacks business-dna:write and billing:view (permissions.ts), so this
 * runs in its own `rbac-mutations` project (playwright.config.ts), which
 * depends on both `desktop` and `mobile` completing first — otherwise this
 * role change could overlap business-dna.spec.ts's or billing.spec.ts's
 * requests and fail them spuriously.
 */
test.describe("rbac boundary: crm:delete", () => {
  test.beforeAll(requireE2EUserCredentials);

  test.beforeEach(async ({ page }) => {
    await openAuthenticatedE2EDashboard(page);
  });

  test("a MEMBER-role user does not see the delete control an OWNER sees", async ({ page }) => {
    test.skip(
      !hasDbAccess(),
      "Requires DATABASE_URL to temporarily change the shared E2E user's role; not wired into CI yet (see docs/DEVELOPMENT.md §13).",
    );

    const prisma = getDbClient();
    const membership = await findE2EFixtureMembership(prisma);
    expect(
      membership.role,
      "expected the shared E2E fixture user to be OWNER before this test mutates it",
    ).toBe("OWNER");

    const seeded = await prisma.contact.create({
      data: { organizationId: membership.organizationId, firstName: `E2E-RBAC-${Date.now()}` },
    });

    const deleteButton = page.getByRole("button", { name: "Poista" });

    try {
      // Positive control, while still OWNER: the control must actually exist
      // for this exact seeded row before we can trust its absence below.
      await page.goto("/crm/contacts");
      await expect(page.getByText(seeded.firstName)).toBeVisible();
      await expect(deleteButton.first()).toBeVisible();

      await prisma.organizationMember.update({
        where: { id: membership.membershipId },
        data: { role: "MEMBER" },
      });

      await page.reload();
      await expect(page.getByText(seeded.firstName)).toBeVisible(); // read access retained
      await expect(deleteButton).toHaveCount(0); // write/delete control gone
    } finally {
      await prisma.organizationMember
        .update({ where: { id: membership.membershipId }, data: { role: membership.role } })
        .catch((error) => {
          console.error("rbac-boundary cleanup: failed to restore the E2E user's role", error);
          throw error;
        });
      await prisma.contact.delete({ where: { id: seeded.id } }).catch((error) => {
        console.error("rbac-boundary cleanup: failed to delete the seeded contact", error);
      });
    }
  });
});
