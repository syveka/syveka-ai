import { describe, expect, it } from "vitest";
import {
  E2E_FIXTURE_ORG_NAME,
  isSafeToRepairKnownFixtureDrift,
  KNOWN_FIXTURE_NAME_DRIFT,
  type FixtureRepairCandidate,
} from "../../scripts/e2e-fixture-identity";

/**
 * This predicate gates a real database rename in
 * scripts/ensure-e2e-org-fixture.ts. It must stay narrow: only the exact,
 * pre-verified historical drift (staging, 2026-09-06) is repairable
 * automatically. Anything else -- a different name, the right name with real
 * data in it, a partial match -- must still fail closed.
 */
function baseCandidate(): FixtureRepairCandidate {
  return {
    name: KNOWN_FIXTURE_NAME_DRIFT.observedName,
    slug: KNOWN_FIXTURE_NAME_DRIFT.observedSlug,
    businessId: null,
    stripeCustomerId: null,
    contactCount: 0,
    companyCount: 0,
    dealCount: 0,
  };
}

describe("isSafeToRepairKnownFixtureDrift", () => {
  it("allows the exact known historical drift, verified empty", () => {
    expect(isSafeToRepairKnownFixtureDrift(baseCandidate())).toBe(true);
  });

  it("refuses a name that isn't the known drift or the canonical fixture name", () => {
    expect(
      isSafeToRepairKnownFixtureDrift({ ...baseCandidate(), name: "A Real Customer Organization" }),
    ).toBe(false);
  });

  it("refuses when the slug doesn't also match, even if the name does", () => {
    expect(isSafeToRepairKnownFixtureDrift({ ...baseCandidate(), slug: "some-other-slug" })).toBe(
      false,
    );
  });

  it("refuses when the organization has a business ID", () => {
    expect(isSafeToRepairKnownFixtureDrift({ ...baseCandidate(), businessId: "1234567-8" })).toBe(
      false,
    );
  });

  it("refuses when the organization has a Stripe customer", () => {
    expect(
      isSafeToRepairKnownFixtureDrift({ ...baseCandidate(), stripeCustomerId: "cus_real" }),
    ).toBe(false);
  });

  it("refuses when the organization has any contacts, companies, or deals", () => {
    expect(isSafeToRepairKnownFixtureDrift({ ...baseCandidate(), contactCount: 1 })).toBe(false);
    expect(isSafeToRepairKnownFixtureDrift({ ...baseCandidate(), companyCount: 1 })).toBe(false);
    expect(isSafeToRepairKnownFixtureDrift({ ...baseCandidate(), dealCount: 1 })).toBe(false);
  });

  it("refuses an organization that's already correctly named (nothing to repair)", () => {
    expect(
      isSafeToRepairKnownFixtureDrift({ ...baseCandidate(), name: E2E_FIXTURE_ORG_NAME }),
    ).toBe(false);
  });
});
