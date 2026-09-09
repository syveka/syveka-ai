import { test, expect } from "@playwright/test";
import { openAuthenticatedE2EDashboard, requireE2EUserCredentials } from "./helpers/auth";
import { hasDbAccess, getDbClient } from "./helpers/db";

/**
 * This complements, not replaces, tests/rls/*.sql (which prove isolation at
 * the raw Postgres role level). Nothing before this proved isolation from a
 * real authenticated browser session hitting the actual app-layer query path
 * (tenantDb()'s Prisma extension, not RLS — see docs/DATABASE-AUDIT.md on why
 * RLS alone doesn't cover DATABASE_URL's connection role). Seeds a wholly
 * disposable second organization (never the shared E2E fixture org) so
 * cleanup is a plain delete with no restore-to-original-value concern.
 */
test.describe("tenant isolation", () => {
  test.beforeAll(requireE2EUserCredentials);

  test.beforeEach(async ({ page }) => {
    await openAuthenticatedE2EDashboard(page);
  });

  test("the E2E org's user cannot open a contact belonging to a different organization", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop",
      "Seeds/tears down a disposable org — running once avoids two concurrent disposable orgs racing.",
    );
    test.skip(
      !hasDbAccess(),
      "Requires DATABASE_URL to seed a disposable second organization; not wired into CI yet (see docs/DEVELOPMENT.md §13).",
    );

    const prisma = getDbClient();
    let otherOrgId: string | undefined;

    try {
      const otherOrg = await prisma.organization.create({
        data: {
          name: "E2E Tenant-Isolation Fixture (disposable)",
          slug: `e2e-tenant-isolation-${Date.now()}`,
          defaultLocale: "FI",
        },
      });
      otherOrgId = otherOrg.id;

      const secretName = `TenantB-Secret-${Date.now()}`;
      const otherContact = await prisma.contact.create({
        data: { organizationId: otherOrg.id, firstName: secretName },
      });

      const response = await page.goto(`/crm/contacts/${otherContact.id}`);
      expect(
        response?.status(),
        "expected the cross-tenant contact route to respond 404, not leak data",
      ).toBe(404);
      await expect(page.getByText(secretName)).toHaveCount(0);
    } finally {
      // Cascades to the seeded contact (Contact.organization is onDelete: Cascade).
      // Covers the org-created-but-contact-create-failed case too, since
      // otherOrgId is set as soon as the org exists, before anything else runs.
      if (otherOrgId) {
        await prisma.organization.delete({ where: { id: otherOrgId } }).catch((error) => {
          console.error("tenant-isolation cleanup: failed to delete the disposable org", error);
        });
      }
    }
  });
});
