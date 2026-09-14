export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { listAllGrants } from "@/server/services/billing/entitlements";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/routing";
import { GrantForm } from "@/components/admin/grant-form";
import { RevokeGrantButton } from "@/components/admin/revoke-grant-button";

const METRIC_LABELS: Record<string, string> = {
  MAX_SEATS: "Seats",
  AI_MESSAGES_PER_USER_MONTH: "AI messages / user / month",
  VOICE_ASSISTANTS: "Voice assistants",
  VOICE_MINUTES_MONTH: "Voice minutes / month",
  KB_STORAGE_MB: "Knowledge base storage (MB)",
  ACTIVE_WORKFLOWS: "Active workflows",
  MAX_CONTACTS: "Max contacts",
  AUDIT_RETENTION_DAYS: "Audit retention (days)",
  CREATOR_CREDITS_PER_MONTH: "Creator Studio credits / month",
};

export default async function AdminOrganizationDetailPage({
  params,
}: {
  params: Promise<{ orgId: string }>;
}) {
  await requireSuperadmin();
  const { orgId } = await params;

  const org = await unscopedPrisma.organization.findUnique({
    where: { id: orgId },
    include: { subscription: { select: { plan: true, status: true } } },
  });
  if (!org) notFound();

  const grants = await listAllGrants(orgId);
  const now = Date.now();
  const activeGrants = grants.filter(
    (g) => !g.revokedAt && (!g.expiresAt || g.expiresAt.getTime() > now),
  );
  const inactiveGrants = grants.filter((g) => !activeGrants.includes(g));

  return (
    <div className="space-y-6">
      <div>
        <Link href="/admin/organizations" className="text-sm text-muted-foreground hover:underline">
          ← Organizations
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{org.name}</h1>
        <p className="text-sm text-muted-foreground">
          Plan: <span className="font-medium">{org.subscription?.plan ?? "FREE"}</span>{" "}
          <span className="text-xs">
            (real Stripe billing plan — never changed by a grant below)
          </span>
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Internal / Pilot Entitlement Grants</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">
            Additive, temporary overrides on top of the org&apos;s real plan — not a subscription,
            not a paid plan, and never shown to the customer as one. Every grant/revoke is
            superadmin-only and fully audited.
          </p>

          {activeGrants.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active grants.</p>
          ) : (
            <div className="divide-y rounded-md border">
              {activeGrants.map((g) => (
                <div key={g.id} className="flex items-center justify-between gap-4 p-3 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">
                      +{g.amount} {METRIC_LABELS[g.metric] ?? g.metric}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {g.reason} · granted {g.createdAt.toISOString().slice(0, 10)}
                      {g.expiresAt ? ` · expires ${g.expiresAt.toISOString().slice(0, 10)}` : ""}
                    </p>
                  </div>
                  <RevokeGrantButton grantId={g.id} organizationId={orgId} />
                </div>
              ))}
            </div>
          )}

          <GrantForm organizationId={orgId} metricLabels={METRIC_LABELS} />

          {inactiveGrants.length > 0 ? (
            <details className="text-xs text-muted-foreground">
              <summary className="cursor-pointer">
                {inactiveGrants.length} expired/revoked grant
                {inactiveGrants.length === 1 ? "" : "s"}
              </summary>
              <div className="mt-2 space-y-1">
                {inactiveGrants.map((g) => (
                  <p key={g.id}>
                    +{g.amount} {METRIC_LABELS[g.metric] ?? g.metric} — {g.reason} (
                    {g.revokedAt ? "revoked" : "expired"})
                  </p>
                ))}
              </div>
            </details>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
