/**
 * Canonical identity for the staging E2E fixture organization, shared between
 * its creator (ensure-e2e-org-fixture.ts) and every mutating E2E test's
 * refuse-to-run guard (tests/e2e/helpers/db.ts) -- a single constant so the
 * two can never drift apart the way "Syveka E2E Test" (a name the fixture
 * script never creates) vs "Syveka E2E Fixture" did.
 */
export const E2E_FIXTURE_ORG_NAME = "Syveka E2E Fixture";

/**
 * The exact, one-time historical drift found in staging on 2026-09-06: the
 * shared E2E user's real organization was named "Syveka E2E Test" (created by
 * hand, once, at onboarding, before this fixture script ever ran for that
 * user) instead of E2E_FIXTURE_ORG_NAME. This is NOT a general "accept any
 * name" allowance -- ensure-e2e-org-fixture.ts only ever repairs a name match
 * against this exact known value, and only after re-verifying live that the
 * organization is still empty (see isSafeToRepairKnownFixtureDrift). Any
 * other mismatch still fails closed.
 */
export const KNOWN_FIXTURE_NAME_DRIFT = {
  observedName: "Syveka E2E Test",
  observedSlug: "syveka-e2e-test",
} as const;

export type FixtureRepairCandidate = {
  name: string;
  slug: string;
  businessId: string | null;
  stripeCustomerId: string | null;
  contactCount: number;
  companyCount: number;
  dealCount: number;
};

/**
 * True only when every one of these exact conditions holds: the org is
 * *precisely* the known historical drift (name and slug both match, not just
 * one), carries no real-business markers (no business ID, no Stripe
 * customer), and contains zero CRM records. A future, different-looking
 * mismatch (any other name, or this name with any data in it) must still
 * fail closed in ensure-e2e-org-fixture.ts rather than being silently
 * "repaired" -- this predicate is intentionally narrow, not a general
 * fixture-identity relaxation.
 */
export function isSafeToRepairKnownFixtureDrift(org: FixtureRepairCandidate): boolean {
  return (
    org.name === KNOWN_FIXTURE_NAME_DRIFT.observedName &&
    org.slug === KNOWN_FIXTURE_NAME_DRIFT.observedSlug &&
    org.businessId === null &&
    org.stripeCustomerId === null &&
    org.contactCount === 0 &&
    org.companyCount === 0 &&
    org.dealCount === 0
  );
}
