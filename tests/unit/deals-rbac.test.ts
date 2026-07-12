import { describe, expect, it } from "vitest";
import { can } from "@/server/auth/permissions";

/**
 * RBAC matrix for the CRM Deals & Sales Pipeline module. These mirror the
 * guards used by the server actions:
 *  - board / deal detail                → crm:read
 *  - create/edit/move/notes/tasks/AI    → crm:write
 *  - delete deal                        → crm:delete
 *  - add/edit/delete pipeline stages    → crm:manage-pipeline
 */
describe("Deals RBAC matrix", () => {
  it("VIEWER can see the board but never mutate", () => {
    expect(can("VIEWER", "crm:read")).toBe(true);
    expect(can("VIEWER", "crm:write")).toBe(false);
    expect(can("VIEWER", "crm:delete")).toBe(false);
    expect(can("VIEWER", "crm:manage-pipeline")).toBe(false);
  });

  it("MEMBER works deals but cannot delete or reconfigure the pipeline", () => {
    expect(can("MEMBER", "crm:read")).toBe(true);
    expect(can("MEMBER", "crm:write")).toBe(true);
    expect(can("MEMBER", "crm:delete")).toBe(false);
    expect(can("MEMBER", "crm:manage-pipeline")).toBe(false);
  });

  it("MANAGER, ADMIN and OWNER have full deals access including stages", () => {
    for (const role of ["MANAGER", "ADMIN", "OWNER"] as const) {
      expect(can(role, "crm:read")).toBe(true);
      expect(can(role, "crm:write")).toBe(true);
      expect(can(role, "crm:delete")).toBe(true);
      expect(can(role, "crm:manage-pipeline")).toBe(true);
    }
  });
});
