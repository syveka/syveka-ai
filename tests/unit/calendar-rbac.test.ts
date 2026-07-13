import { describe, expect, it } from "vitest";
import { can, PERMISSIONS } from "@/server/auth/permissions";

describe("calendar & booking RBAC matrix", () => {
  it("declares the new permissions", () => {
    expect(PERMISSIONS).toContain("calendar:read");
    expect(PERMISSIONS).toContain("calendar:write");
    expect(PERMISSIONS).toContain("calendar:delete");
    expect(PERMISSIONS).toContain("booking:manage");
    expect(PERMISSIONS).toContain("integrations:manage");
  });

  it("OWNER and ADMIN hold every calendar permission", () => {
    for (const role of ["OWNER", "ADMIN"] as const) {
      expect(can(role, "calendar:read")).toBe(true);
      expect(can(role, "calendar:write")).toBe(true);
      expect(can(role, "calendar:delete")).toBe(true);
      expect(can(role, "booking:manage")).toBe(true);
      expect(can(role, "integrations:manage")).toBe(true);
    }
  });

  it("MANAGER can manage bookings but not integrations", () => {
    expect(can("MANAGER", "calendar:read")).toBe(true);
    expect(can("MANAGER", "calendar:write")).toBe(true);
    expect(can("MANAGER", "calendar:delete")).toBe(true);
    expect(can("MANAGER", "booking:manage")).toBe(true);
    expect(can("MANAGER", "integrations:manage")).toBe(false);
  });

  it("MEMBER can write and delete own-calendar events but not manage booking config", () => {
    expect(can("MEMBER", "calendar:read")).toBe(true);
    expect(can("MEMBER", "calendar:write")).toBe(true);
    expect(can("MEMBER", "calendar:delete")).toBe(true);
    expect(can("MEMBER", "booking:manage")).toBe(false);
    expect(can("MEMBER", "integrations:manage")).toBe(false);
  });

  it("VIEWER is read-only", () => {
    expect(can("VIEWER", "calendar:read")).toBe(true);
    expect(can("VIEWER", "calendar:write")).toBe(false);
    expect(can("VIEWER", "calendar:delete")).toBe(false);
    expect(can("VIEWER", "booking:manage")).toBe(false);
    expect(can("VIEWER", "integrations:manage")).toBe(false);
  });
});
