import { NextResponse } from "next/server";
import { z } from "zod";
import { jobPayloadJson } from "@/server/jobs/payload";
import { USAGE_ROLLUP_BATCH_SIZE } from "@/server/jobs/usage-rollup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** The scheduled delivery has no body; a chained page carries the last organization id seen. */
const payloadSchema = z.object({ cursor: z.string().guid().optional() }).strict();

/**
 * Nightly rollup (QStash cron `0 2 * * *` → this endpoint):
 * emits 80%-quota warnings (§15.6) and prunes expired soft-deleted rows (§13.3).
 *
 * The purge runs on the first page only. Organizations are checked in id
 * order, a bounded page per delivery, and the next page is enqueued as its
 * own job: one delivery can't outlive maxDuration and lose the tail, and a
 * retry of the scheduled delivery restarts the first page, not every page.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [
    { verifyJobRequest },
    { unscopedPrisma },
    { getEntitlements, getMonthUsage },
    { enqueue },
  ] = await Promise.all([
    import("@/server/jobs/verify"),
    import("@/server/db/tenant"),
    import("@/server/services/billing/entitlements"),
    import("@/server/jobs/queue"),
  ]);

  const rawBody = await verifyJobRequest(request);
  if (rawBody === null) return NextResponse.json({ error: "invalid signature" }, { status: 401 });

  const parsed = payloadSchema.safeParse(rawBody.length > 0 ? jobPayloadJson(rawBody) : {});
  if (!parsed.success) return NextResponse.json({ error: "invalid payload" }, { status: 400 });
  const { cursor } = parsed.data;

  let purged: { contacts: number; documents: number; conversations: number } | null = null;
  if (!cursor) {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    // GDPR retention: purge soft-deleted rows older than 30 days (§13.3)
    const [contacts, docs, convs] = await Promise.all([
      unscopedPrisma.contact.deleteMany({ where: { deletedAt: { lt: cutoff } } }),
      unscopedPrisma.document.deleteMany({ where: { deletedAt: { lt: cutoff } } }),
      unscopedPrisma.conversation.deleteMany({ where: { deletedAt: { lt: cutoff } } }),
    ]);
    purged = { contacts: contacts.count, documents: docs.count, conversations: convs.count };
  }

  // 80% usage warnings, one page of organizations
  const orgs = await unscopedPrisma.organization.findMany({
    where: { deletedAt: null, ...(cursor ? { id: { gt: cursor } } : {}) },
    select: { id: true, members: { where: { role: "OWNER" }, select: { userId: true }, take: 1 } },
    orderBy: { id: "asc" },
    take: USAGE_ROLLUP_BATCH_SIZE,
  });

  let warned = 0;
  for (const org of orgs) {
    const ent = await getEntitlements(org.id);
    const checks: Array<{ used: number; limit: number; label: string }> = [
      {
        used: await getMonthUsage(org.id, "AI_MESSAGES"),
        limit: ent.aiMessagesPerOrgMonth,
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

  // A full page may have more behind it: the next page is its own delivery.
  const nextCursor = orgs.length === USAGE_ROLLUP_BATCH_SIZE ? orgs[orgs.length - 1]!.id : null;
  if (nextCursor) {
    try {
      await enqueue(
        "usage-rollup",
        { cursor: nextCursor },
        { deduplicationId: `usage-rollup:${nextCursor}` },
      );
    } catch {
      // This page's warnings are recorded; the tail is not. Non-2xx: QStash
      // delivers this page again (its warnings dedupe for 7 days).
      return NextResponse.json({ error: "failed to enqueue next page" }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, purged, warned, nextCursor });
}
