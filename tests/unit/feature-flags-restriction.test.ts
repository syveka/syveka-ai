import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * isRestrictionSet reads a flag that RESTRICTS an organization (such as
 * workflow_steps_internal_only). Unlike isFeatureEnabled, which only counts
 * JSON true, anything but an absent key, false or null counts as set: a
 * mistyped value restricts instead of silently leaving the org unrestricted.
 */
const store = vi.hoisted(() => ({ settings: {} as unknown }));
vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    organization: { findUnique: vi.fn(async () => ({ settings: store.settings })) },
  },
}));

import { isFeatureEnabled, isRestrictionSet } from "@/server/services/feature-flags";

const KEY = "workflow_steps_internal_only";

beforeEach(() => {
  store.settings = {};
});

describe("isRestrictionSet", () => {
  it.each([
    [true, true],
    ["true", true],
    [1, true],
    ["yes", true],
    [{}, true],
    [false, false],
    [null, false],
  ])("value %j → restricted: %s", async (value, expected) => {
    store.settings = { [KEY]: value };
    expect(await isRestrictionSet("org", KEY)).toBe(expected);
  });

  it("an absent key, or no settings at all, is not restricted", async () => {
    expect(await isRestrictionSet("org", KEY)).toBe(false);
    store.settings = null;
    expect(await isRestrictionSet("org", KEY)).toBe(false);
  });

  it("feature flags keep the strict reading (only JSON true enables)", async () => {
    store.settings = { creator_studio_v1: "true" };
    expect(await isFeatureEnabled("org", "creator_studio_v1")).toBe(false);
  });
});
