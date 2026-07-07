import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { Card, CardContent } from "@/components/ui/card";
import { StatCard } from "@/components/analytics/charts";

export default async function AdminOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  await requireSuperadmin();
  const { q } = await searchParams;

  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);

  const [orgs, totals, planCounts] = await Promise.all([
    unscopedPrisma.organization.findMany({
      where: {
        deletedAt: null,
        ...(q ? { name: { contains: q, mode: "insensitive" } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: 50,
      include: {
        subscription: { select: { plan: true, status: true, seats: true } },
        _count: { select: { members: true, contacts: true, voiceCalls: true } },
      },
    }),
    unscopedPrisma.usageRecord.groupBy({
      by: ["metric"],
      where: { periodStart: { gte: monthStart } },
      _sum: { quantity: true },
    }),
    unscopedPrisma.subscription.groupBy({ by: ["plan"], _count: true }),
  ]);

  const metric = (m: string) => totals.find((t) => t.metric === m)?._sum.quantity ?? 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Organizations</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Organizations" value={orgs.length} />
        <StatCard
          label="Paying"
          value={planCounts.filter((p) => p.plan !== "FREE").reduce((n, p) => n + p._count, 0)}
        />
        <StatCard label="AI messages (month)" value={metric("AI_MESSAGES").toLocaleString()} />
        <StatCard label="Voice minutes (month)" value={metric("VOICE_MINUTES").toLocaleString()} />
      </div>

      <form method="get">
        <input
          name="q"
          defaultValue={q}
          placeholder="Search organizations…"
          className="h-9 w-full max-w-xs rounded-md border border-input bg-transparent px-3 text-sm"
        />
      </form>

      <Card>
        <CardContent className="divide-y p-0">
          {orgs.map((org) => (
            <div key={org.id} className="flex items-center gap-4 p-4 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{org.name}</p>
                <p className="text-xs text-muted-foreground">
                  {org.slug} · {org.businessId ?? "no Y-tunnus"} · created{" "}
                  {org.createdAt.toISOString().slice(0, 10)}
                </p>
              </div>
              <span className="text-xs text-muted-foreground">
                {org._count.members} members · {org._count.contacts} contacts ·{" "}
                {org._count.voiceCalls} calls
              </span>
              <span className="rounded-full bg-secondary px-2 py-0.5 text-xs">
                {org.subscription?.plan ?? "FREE"}
                {org.subscription?.status !== "ACTIVE" ? ` (${org.subscription?.status})` : ""}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
