import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Nightly rollup (QStash cron `0 2 * * *` → this endpoint):
 * emits 80%-quota warnings (§15.6) and prunes expired soft-deleted rows (§13.3).
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [{ verifyJobRequest }, { unscopedPrisma }, { getEntitlements, getMonthUsage }] =
    await Promise.all([
      import("@/server/jobs/verify"),
      import("@/server/db/tenant"),
      import("@/server/services/billing/entitlements"),
    ]);

  const rawBody = await verifyJobRequest(request);
  if (rawBody === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  // GDPR retention: purge soft-deleted rows older than 30 days (§13.3)
  const [contacts, docs, convs] = await Promise.all([
    unscopedPrisma.contact.deleteMany({ where: { deletedAt: { lt: cutoff } } }),
    unscopedPrisma.document.deleteMany({ where: { deletedAt: { lt: cutoff } } }),
    unscopedPrisma.conversation.deleteMany({ where: { deletedAt: { lt: cutoff } } }),
  ]);

  // 80% usage warnings
  const orgs = await unscopedPrisma.organization.findMany({
    where: { deletedAt: null },
    select: { id: true, members: { where: { role: "OWNER" }, select: { userId: true }, take: 1 } },
  });

  let warned = 0;
  for (const org of orgs) {
    const ent = await getEntitlements(org.id);
    const seats = ent.seats;
    const checks: Array<{ used: number; limit: number; label: string }> = [
      {
        used: await getMonthUsage(org.id, "AI_MESSAGES"),
        limit: ent.aiMessagesPerUserMonth * seats,
        label: "AI messages",
      },
      {
        used: await getMonthUsage(org.id, "VOICE_MINUTES"),
        limit: ent.voiceMinutesMonth,
        label: "voice minutes",
      },
    ];
    for (const c of checks) {
      if (c.limit > 0 && c.limit < Number.MAX_SAFE_INTEGER && c.used >= c.limit * 0.8) {
        const owner = org.members[0];
        if (!owner) continue;
        const already = await unscopedPrisma.notification.findFirst({
          where: {
            organizationId: org.id,
            type: "usage.warning",
            body: { contains: c.label },
            createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
          },
        });
        if (!already) {
          await unscopedPrisma.notification.create({
            data: {
              organizationId: org.id,
              userId: owner.userId,
              type: "usage.warning",
              title: "Usage warning",
              body: `You have used ${Math.round((c.used / c.limit) * 100)}% of your monthly ${c.label}.`,
              href: "/settings/billing",
            },
          });
          warned++;
        }
      }
    }
  }

  return NextResponse.json({
    ok: true,
    purged: { contacts: contacts.count, documents: docs.count, conversations: convs.count },
    warned,
  });
}
