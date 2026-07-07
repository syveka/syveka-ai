import "server-only";

import type { Role } from "@prisma/client";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { createSupabaseAdmin } from "@/server/supabase/server";
import { assertWithinLimit } from "./billing/entitlements";
import { sendEmail } from "@/server/integrations/resend";
import { InvitationEmail } from "../../../emails/invitation";
import { audit } from "./audit";
import type { TenantContext } from "@/server/auth/session";
import { env } from "@/env";

const INVITE_EXPIRY_DAYS = 7;

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
    if (existingMember) throw new Error("Already a member");
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
      inviteUrl: `${env.NEXT_PUBLIC_APP_URL}/invite/${invitation.token}`,
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

  await db.organizationMember.delete({ where: { id: memberId } });

  await audit(ctx, {
    action: "member.remove",
    resourceType: "organization_member",
    resourceId: memberId,
    before: { userId: member.userId, role: member.role },
  });
}
