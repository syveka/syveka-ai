export const dynamic = "force-dynamic";

import { Suspense } from "react";
import { getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { getCrmDashboard } from "@/server/services/dashboard";
import { CrmDashboardView, DashboardSkeleton } from "@/components/dashboard/crm-dashboard";

async function DashboardContent() {
  const ctx = await requirePermission("crm:read");
  const [dashboard, locale] = await Promise.all([getCrmDashboard(ctx), getLocale()]);

  return <CrmDashboardView dashboard={dashboard} locale={locale} />;
}

export default function DashboardPage() {
  return (
    <Suspense fallback={<DashboardSkeleton />}>
      <DashboardContent />
    </Suspense>
  );
}
