import { describe, expect, it } from "vitest";
import { can } from "@/server/auth/permissions";

/**
 * RBAC matrix for the Inbox MVP foundation:
 *  - view threads/messages        → inbox:read
 *  - compose/reply/send/reassign  → inbox:write
 *  - approve an AI-generated draft before it may be sent → inbox:approve
 */
describe("Inbox RBAC matrix", () => {
  it("VIEWER can read but never write or approve", () => {
    expect(can("VIEWER", "inbox:read")).toBe(true);
    expect(can("VIEWER", "inbox:write")).toBe(false);
    expect(can("VIEWER", "inbox:approve")).toBe(false);
  });

  it("MEMBER can read and write but cannot approve AI drafts", () => {
    expect(can("MEMBER", "inbox:read")).toBe(true);
    expect(can("MEMBER", "inbox:write")).toBe(true);
    expect(can("MEMBER", "inbox:approve")).toBe(false);
  });

  it("MANAGER, ADMIN and OWNER have full Inbox access", () => {
    for (const role of ["MANAGER", "ADMIN", "OWNER"] as const) {
      expect(can(role, "inbox:read")).toBe(true);
      expect(can(role, "inbox:write")).toBe(true);
      expect(can(role, "inbox:approve")).toBe(true);
    }
  });
});
