import { describe, expect, it } from "vitest";
import { can } from "@/server/auth/permissions";

/**
 * RBAC matrix for the CRM Contacts & Companies module. These mirror the
 * guards used by the server actions:
 *  - list/detail pages          → crm:read
 *  - create/edit/archive/notes  → crm:write
 *  - delete                     → crm:delete
 */
describe("CRM RBAC matrix", () => {
  it("VIEWER can read but never mutate", () => {
    expect(can("VIEWER", "crm:read")).toBe(true);
    expect(can("VIEWER", "crm:write")).toBe(false);
    expect(can("VIEWER", "crm:delete")).toBe(false);
  });

  it("MEMBER can write but not delete", () => {
    expect(can("MEMBER", "crm:read")).toBe(true);
    expect(can("MEMBER", "crm:write")).toBe(true);
    expect(can("MEMBER", "crm:delete")).toBe(false);
  });

  it("MANAGER, ADMIN and OWNER have full CRM access", () => {
    for (const role of ["MANAGER", "ADMIN", "OWNER"] as const) {
      expect(can(role, "crm:read")).toBe(true);
      expect(can(role, "crm:write")).toBe(true);
      expect(can(role, "crm:delete")).toBe(true);
    }
  });
});
