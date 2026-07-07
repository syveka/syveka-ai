import { describe, expect, it } from "vitest";
import { can, permissionsFor, PERMISSIONS } from "@/server/auth/permissions";

describe("RBAC matrix (§12.2)", () => {
  it("OWNER has every permission", () => {
    for (const p of PERMISSIONS) expect(can("OWNER", p)).toBe(true);
  });

  it("ADMIN cannot delete the org or manage billing payment", () => {
    expect(can("ADMIN", "org:delete")).toBe(false);
    expect(can("ADMIN", "billing:manage")).toBe(false);
    expect(can("ADMIN", "billing:view")).toBe(true);
    expect(can("ADMIN", "members:invite")).toBe(true);
    expect(can("ADMIN", "audit:view")).toBe(true);
  });

  it("MANAGER manages operations but not the org", () => {
    expect(can("MANAGER", "voice:configure")).toBe(true);
    expect(can("MANAGER", "workflows:manage")).toBe(true);
    expect(can("MANAGER", "crm:delete")).toBe(true);
    expect(can("MANAGER", "members:invite")).toBe(false);
    expect(can("MANAGER", "api-keys:manage")).toBe(false);
    expect(can("MANAGER", "audit:view")).toBe(false);
  });

  it("MEMBER works but cannot configure or destroy", () => {
    expect(can("MEMBER", "chat:use")).toBe(true);
    expect(can("MEMBER", "crm:write")).toBe(true);
    expect(can("MEMBER", "crm:delete")).toBe(false);
    expect(can("MEMBER", "kb:write")).toBe(false);
    expect(can("MEMBER", "voice:configure")).toBe(false);
  });

  it("VIEWER is read-only and cannot chat", () => {
    expect(can("VIEWER", "crm:read")).toBe(true);
    expect(can("VIEWER", "chat:use")).toBe(false);
    expect(can("VIEWER", "crm:write")).toBe(false);
    expect(can("VIEWER", "calendar:write")).toBe(false);
  });

  it("roles are strictly ordered by permission count", () => {
    const counts = (["VIEWER", "MEMBER", "MANAGER", "ADMIN", "OWNER"] as const).map(
      (r) => permissionsFor(r).length,
    );
    for (let i = 1; i < counts.length; i++) expect(counts[i]!).toBeGreaterThan(counts[i - 1]!);
  });
});
