import "server-only";

import type { Role } from "@/generated/prisma/client/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { createSupabaseAdmin } from "@/server/supabase/server";
import { assertWithinLimit } from "./billing/entitlements";
import { sendEmail } from "@/server/integrations/resend";
import { InvitationEmail } from "../../../emails/invitation";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import { getAppUrlEnv } from "@/env";

const INVITE_EXPIRY_DAYS = 7;

/** A member-management rule the operator can act on; `code` is shown translated. */
export class MemberError extends Error {
  constructor(
    message: string,
    public readonly code: "already_member",
  ) {
    super(message);
    this.name = "MemberError";
  }
}

export async function inviteMember(
  ctx: TenantContext,
  input: { email: string; role: Role },
): Promise<void> {
  const db = tenantDb(ctx.orgId);

  const seatCount = await db.organizationMember.count();
  await assertWithinLimit(ctx.orgId, { kind: "seats", current: seatCount });

  const existingUser = await unscopedPrisma.user.findUnique({ where: { email: input.email } });
  if (existingUser) {
    const existingMember = await db.organizationMember.findFirst({
      where: { userId: existingUser.id },
    });
    if (existingMember) throw new MemberError("Already a member", "already_member");
  }

  const org = await unscopedPrisma.organization.findUniqueOrThrow({
    where: { id: ctx.orgId },
    select: { name: true, defaultLocale: true },
  });

  const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

  const invitation = await unscopedPrisma.invitation.upsert({
    where: { organizationId_email: { organizationId: ctx.orgId, email: input.email } },
    create: {
      organizationId: ctx.orgId,
      email: input.email,
      role: input.role,
      invitedById: ctx.userId,
      expiresAt,
    },
    update: { role: input.role, status: "PENDING", expiresAt, invitedById: ctx.userId },
  });

  await sendEmail({
    to: input.email,
    subject:
      org.defaultLocale === "FI"
        ? `Kutsu: liity organisaatioon ${org.name} Syvekassa`
        : `You've been invited to ${org.name} on Syveka`,
    react: InvitationEmail({
      orgName: org.name,
      inviteUrl: `${getAppUrlEnv().NEXT_PUBLIC_APP_URL}/invite/${invitation.token}`,
      locale: org.defaultLocale,
    }),
  });

  await audit(ctx, {
    action: "member.invite",
    resourceType: "invitation",
    resourceId: invitation.id,
    after: { email: input.email, role: input.role },
  });
}

export async function acceptInvitation(token: string, userId: string): Promise<string> {
  const invitation = await unscopedPrisma.invitation.findUnique({ where: { token } });
  if (!invitation || invitation.status !== "PENDING") throw new Error("Invalid invitation");
  if (invitation.expiresAt < new Date()) {
    await unscopedPrisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "EXPIRED" },
    });
    throw new Error("Invitation expired");
  }

  const user = await unscopedPrisma.user.findUniqueOrThrow({ where: { id: userId } });
  if (user.email.toLowerCase() !== invitation.email.toLowerCase()) {
    throw new Error("Invitation was sent to a different email address");
  }

  await unscopedPrisma.$transaction([
    unscopedPrisma.organizationMember.create({
      data: {
        organizationId: invitation.organizationId,
        userId,
        role: invitation.role,
      },
    }),
    unscopedPrisma.invitation.update({
      where: { id: invitation.id },
      data: { status: "ACCEPTED" },
    }),
  ]);

  const admin = createSupabaseAdmin();
  await admin.auth.admin.updateUserById(userId, {
    app_metadata: { last_active_org: invitation.organizationId },
  });

  await audit(
    { orgId: invitation.organizationId, userId },
    { action: "member.join", resourceType: "organization_member", resourceId: userId },
  );

  return invitation.organizationId;
}

export async function changeMemberRole(
  ctx: TenantContext,
  memberId: string,
  role: Role,
): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const member = await db.organizationMember.findFirstOrThrow({ where: { id: memberId } });

  if (member.role === "OWNER") throw new Error("Transfer ownership instead");
  if (member.userId === ctx.userId) throw new Error("Cannot change your own role");

  await db.organizationMember.update({ where: { id: memberId }, data: { role } });

  await audit(ctx, {
    action: "member.role_change",
    resourceType: "organization_member",
    resourceId: memberId,
    before: { role: member.role },
    after: { role },
  });
}

export async function removeMember(ctx: TenantContext, memberId: string): Promise<void> {
  const db = tenantDb(ctx.orgId);
  const member = await db.organizationMember.findFirstOrThrow({ where: { id: memberId } });

  if (member.role === "OWNER") throw new Error("Cannot remove the owner");

  // The membership and the member's calendar access in this organization end
  // together. The DELETE runs first: it waits for any in-flight calendar
  // write that holds the membership row (lockCalendarMember), and the
  // invalidation after it then clears whatever that write committed. Local
  // credentials are removed; the grant at the provider is the user's own
  // and is not revoked here (it may serve their other organizations).
  const invalidated = await unscopedPrisma.$transaction(async (tx) => {
    await tx.organizationMember.delete({
      where: { id: memberId, organizationId: ctx.orgId },
    });
    const connections = await tx.calendarConnection.findMany({
      where: { organizationId: ctx.orgId, userId: member.userId },
      select: { id: true },
    });
    const connectionIds = connections.map((c) => c.id);
    if (connectionIds.length === 0) return 0;
    await tx.calendarConnection.updateMany({
      where: { id: { in: connectionIds }, organizationId: ctx.orgId },
      data: {
        status: "DISCONNECTED",
        accessTokenEnc: null,
        refreshTokenEnc: null,
        tokenExpiresAt: null,
        lastError: "membership_removed",
        lastCheckedAt: new Date(),
      },
    });
    // Same as turning sync off for a calendar: no further webhook renewal,
    // and the stored webhook secret is dropped, so pings fail verification.
    const calendars = { connectionId: { in: connectionIds }, organizationId: ctx.orgId };
    await tx.externalCalendar.updateMany({ where: calendars, data: { syncEnabled: false } });
    await tx.calendarSyncState.deleteMany({
      where: { organizationId: ctx.orgId, externalCalendar: calendars },
    });
    return connectionIds.length;
  });

  await audit(ctx, {
    action: "member.remove",
    resourceType: "organization_member",
    resourceId: memberId,
    before: { userId: member.userId, role: member.role },
    after: { calendarConnectionsDisabled: invalidated },
  });
}
