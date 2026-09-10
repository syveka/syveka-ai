import { describe, expect, it } from "vitest";
import { can } from "@/server/auth/permissions";

describe("Creator Studio RBAC matrix", () => {
  it("VIEWER can read but never generate, approve, publish, or manage accounts", () => {
    expect(can("VIEWER", "creator:read")).toBe(true);
    expect(can("VIEWER", "creator:write")).toBe(false);
    expect(can("VIEWER", "creator:generate")).toBe(false);
    expect(can("VIEWER", "creator:approve")).toBe(false);
    expect(can("VIEWER", "creator:publish")).toBe(false);
    expect(can("VIEWER", "creator:manage-social-accounts")).toBe(false);
    expect(can("VIEWER", "creator:manage-autopilot")).toBe(false);
  });

  it("MEMBER can create drafts and generate content but not approve, publish, or connect accounts", () => {
    expect(can("MEMBER", "creator:read")).toBe(true);
    expect(can("MEMBER", "creator:write")).toBe(true);
    expect(can("MEMBER", "creator:generate")).toBe(true);
    expect(can("MEMBER", "creator:approve")).toBe(false);
    expect(can("MEMBER", "creator:publish")).toBe(false);
    expect(can("MEMBER", "creator:manage-social-accounts")).toBe(false);
    expect(can("MEMBER", "creator:manage-autopilot")).toBe(false);
  });

  it("MANAGER, ADMIN and OWNER have full Creator Studio access", () => {
    for (const role of ["MANAGER", "ADMIN", "OWNER"] as const) {
      expect(can(role, "creator:read")).toBe(true);
      expect(can(role, "creator:write")).toBe(true);
      expect(can(role, "creator:generate")).toBe(true);
      expect(can(role, "creator:approve")).toBe(true);
      expect(can(role, "creator:publish")).toBe(true);
      expect(can(role, "creator:manage-social-accounts")).toBe(true);
      expect(can(role, "creator:manage-autopilot")).toBe(true);
    }
  });
});
