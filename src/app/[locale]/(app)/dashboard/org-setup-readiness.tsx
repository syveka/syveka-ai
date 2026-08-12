import { getTranslations } from "next-intl/server";
import { CheckCircle2, AlertCircle, XCircle, HelpCircle } from "lucide-react";
import { can } from "@/server/auth/permissions";
import { getOrgSetupReadiness, type ReadinessState } from "@/server/services/setup-readiness";
import type { TenantContext } from "@/server/auth/session";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/routing";

const ACTION_HREF: Partial<Record<string, string>> = {
  businessDna: "/settings/business-dna",
  booking: "/calendar/booking-types",
  voice: "/voice",
};

/**
 * Owner/admin-only readiness checklist for the org's core MVP loop. Never
 * shown to MEMBER/VIEWER roles — setup actions aren't theirs to take, and an
 * unactionable checklist is just noise. Truthful states only: never claims
 * "Ready" for something unconfigured or unverified, never shows a
 * fabricated "Blocked" state nothing in this codebase can actually detect
 * yet. Takes the already-authorized dashboard `ctx` as a prop rather than
 * re-deriving it — the dashboard page has already called
 * `requirePermission("crm:read")`.
 */
export async function OrgSetupReadiness({ ctx }: { ctx: TenantContext }) {
  if (!can(ctx.role, "org:update")) return null;

  const t = await getTranslations("setupReadiness");
  const items = await getOrgSetupReadiness(ctx);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        {items.map((item) => {
          const href = ACTION_HREF[item.key];
          const row = (
            <div className="flex items-center justify-between gap-2 py-1 text-sm">
              <span>{t(`items.${item.key}`)}</span>
              <StateBadge state={item.state} t={t} />
            </div>
          );
          return href && item.state !== "ready" ? (
            <Link key={item.key} href={href} className="block hover:underline">
              {row}
            </Link>
          ) : (
            <div key={item.key}>{row}</div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function StateBadge({
  state,
  t,
}: {
  state: ReadinessState;
  t: Awaited<ReturnType<typeof getTranslations<"setupReadiness">>>;
}) {
  if (state === "ready") {
    return (
      <span className="flex items-center gap-1 text-primary">
        <CheckCircle2 className="size-4" />
        {t("state.ready")}
      </span>
    );
  }
  if (state === "setup_required") {
    return (
      <span className="flex items-center gap-1 text-amber-600">
        <AlertCircle className="size-4" />
        {t("state.setup_required")}
      </span>
    );
  }
  if (state === "not_configured") {
    return (
      <span className="flex items-center gap-1 text-muted-foreground">
        <XCircle className="size-4" />
        {t("state.not_configured")}
      </span>
    );
  }
  if (state === "verification_required") {
    return (
      <span className="flex items-center gap-1 text-amber-600">
        <HelpCircle className="size-4" />
        {t("state.verification_required")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-destructive">
      <XCircle className="size-4" />
      {t("state.blocked")}
    </span>
  );
}
