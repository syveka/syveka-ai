import { describe, expect, it, vi } from "vitest";

/** The authoritative seat count: members of a non-deleted organization, scoped to it. */

vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: {} }));

import { countActiveSeats } from "@/server/services/billing/seats";

const ORG_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ORG_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type Row = Record<string, unknown>;

function makeDb(deleted: Set<string>) {
  const members = [
    ...Array.from({ length: 3 }, (_, i) => ({ id: `a${i}`, organizationId: ORG_A })),
    ...Array.from({ length: 9 }, (_, i) => ({ id: `b${i}`, organizationId: ORG_B })),
  ];
  const count = vi.fn(async ({ where }: { where: Row }) => {
    const orgId = where.organizationId as string;
    const requiresLiveOrg =
      (where.organization as { deletedAt?: null } | undefined)?.deletedAt === null;
    if (requiresLiveOrg && deleted.has(orgId)) return 0;
    return members.filter((m) => m.organizationId === orgId).length;
  });
  return { organizationMember: { count } };
}

describe("countActiveSeats", () => {
  it("counts only the given organization's members (cross-tenant)", async () => {
    const db = makeDb(new Set());
    await expect(countActiveSeats(ORG_A, db as never)).resolves.toBe(3);
    await expect(countActiveSeats(ORG_B, db as never)).resolves.toBe(9);
    for (const [args] of db.organizationMember.count.mock.calls) {
      expect((args as { where: Row }).where).toEqual({
        organizationId: expect.any(String),
        organization: { deletedAt: null },
      });
    }
  });

  it("is zero for a deleted organization", async () => {
    const db = makeDb(new Set([ORG_A]));
    await expect(countActiveSeats(ORG_A, db as never)).resolves.toBe(0);
    await expect(countActiveSeats(ORG_B, db as never)).resolves.toBe(9);
  });
});
