/**
 * Canonical identity for the staging E2E fixture organization, shared between
 * its creator (ensure-e2e-org-fixture.ts) and every mutating E2E test's
 * refuse-to-run guard (tests/e2e/helpers/db.ts) -- a single constant so the
 * two can never drift apart the way "Syveka E2E Test" (a name the fixture
 * script never creates) vs "Syveka E2E Fixture" did.
 */
export const E2E_FIXTURE_ORG_NAME = "Syveka E2E Fixture";
