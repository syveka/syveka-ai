import { describe, expect, it } from "vitest";
import { can } from "@/server/auth/permissions";

/**
 * RBAC matrix for Business DNA:
 *  - view profile          → business-dna:read
 *  - create/update profile → business-dna:write
 */
describe("Business DNA RBAC matrix", () => {
  it("VIEWER can read but never write", () => {
    expect(can("VIEWER", "business-dna:read")).toBe(true);
    expect(can("VIEWER", "business-dna:write")).toBe(false);
  });

  it("MEMBER can read but not write", () => {
    expect(can("MEMBER", "business-dna:read")).toBe(true);
    expect(can("MEMBER", "business-dna:write")).toBe(false);
  });

  it("MANAGER, ADMIN and OWNER have full Business DNA access", () => {
    for (const role of ["MANAGER", "ADMIN", "OWNER"] as const) {
      expect(can(role, "business-dna:read")).toBe(true);
      expect(can(role, "business-dna:write")).toBe(true);
    }
  });
});
