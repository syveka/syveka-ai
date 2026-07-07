import { requirePermission } from "@/server/auth/guard";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { can } from "@/server/auth/permissions";
import { MembersTable } from "./members-table";
import { InviteForm } from "./invite-form";

export default async function MembersPage() {
  const ctx = await requirePermission("members:invite");
  const db = tenantDb(ctx.orgId);

  const [members, invitations] = await Promise.all([
    db.organizationMember.findMany({ orderBy: { joinedAt: "asc" } }),
    db.invitation.findMany({ where: { status: "PENDING" }, orderBy: { createdAt: "desc" } }),
  ]);

  const users = await unscopedPrisma.user.findMany({
    where: { id: { in: members.map((m) => m.userId) } },
    select: { id: true, email: true, fullName: true, avatarUrl: true },
  });
  const userById = new Map(users.map((u) => [u.id, u]));

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Team</h1>
      <InviteForm />
      <MembersTable
        currentUserId={ctx.userId}
        canManage={can(ctx.role, "members:role")}
        members={members.map((m) => ({
          id: m.id,
          role: m.role,
          userId: m.userId,
          email: userById.get(m.userId)?.email ?? "",
          name: userById.get(m.userId)?.fullName ?? null,
        }))}
        pendingInvites={invitations.map((i) => ({ id: i.id, email: i.email, role: i.role }))}
      />
    </div>
  );
}
