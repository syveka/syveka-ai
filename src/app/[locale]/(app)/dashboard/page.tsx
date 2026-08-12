export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { getCrmDashboard } from "@/server/services/dashboard";
import { CrmDashboardView, DashboardSkeleton } from "@/components/dashboard/crm-dashboard";
import { OrgSetupReadiness } from "./org-setup-readiness";

async function DashboardContent() {
  const ctx = await requirePermission("crm:read");
  const [dashboard, locale] = await Promise.all([getCrmDashboard(ctx), getLocale()]);

  return (
    <div className="space-y-4">
      <OrgSetupReadiness ctx={ctx} />
      <CrmDashboardView dashboard={dashboard} locale={locale} />
    </div>
  );
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}
