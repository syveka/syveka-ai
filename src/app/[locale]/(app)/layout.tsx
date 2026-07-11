export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getTenantContextOrNull } from "@/server/auth/session";
import { unscopedPrisma } from "@/server/db/tenant";
import { unreadCount } from "@/server/services/notifications";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { Topbar } from "@/components/layout/topbar";
import { permissionsFor } from "@/server/auth/permissions";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getTenantContextOrNull();
  if (!ctx) redirect("/onboarding");

  const [org, unread] = await Promise.all([
    unscopedPrisma.organization.findUniqueOrThrow({
      where: { id: ctx.orgId },
      select: { name: true },
    }),
    unreadCount(ctx),
  ]);

  return (
    <div className="flex min-h-screen">
      <AppSidebar role={ctx.role} permissions={permissionsFor(ctx.role)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar userId={ctx.userId} orgName={org.name} initialUnread={unread} />
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
