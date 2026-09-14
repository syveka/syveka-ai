export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { getTenantContextOrNull } from "@/server/auth/session";
import { unscopedPrisma } from "@/server/db/tenant";
import { unreadCount } from "@/server/services/notifications";
import { isFeatureEnabled } from "@/server/services/feature-flags";
import { AppSidebar } from "@/components/layout/app-sidebar";
import { Topbar } from "@/components/layout/topbar";
import { permissionsFor } from "@/server/auth/permissions";

// Must match nav-items.ts's "creatorStudio" entry's featureFlag string, and
// CREATOR_STUDIO_FLAG in @/server/services/creator-profiles (kept as a
// literal here, not imported, since that module is server-only and
// nav-items.ts is bundled into client components).
const CREATOR_STUDIO_NAV_FLAG = "creator_studio_v1";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getTenantContextOrNull();
  if (!ctx) redirect("/onboarding");

  const [org, unread, creatorStudioEnabled] = await Promise.all([
    unscopedPrisma.organization.findUniqueOrThrow({
      where: { id: ctx.orgId },
      select: { name: true },
    }),
    unreadCount(ctx),
    isFeatureEnabled(ctx.orgId, CREATOR_STUDIO_NAV_FLAG),
  ]);
  const permissions = permissionsFor(ctx.role);
  // Hides not-yet-self-serviceable features (Creator Studio, and therefore
  // its Connect Meta / social publishing sub-pages) from the nav for
  // ordinary customers until this org has the flag explicitly enabled --
  // the pages themselves already handle direct navigation gracefully
  // (see src/app/[locale]/(app)/creator-studio/layout.tsx), this only stops
  // the nav from inviting a confused click into a dead end.
  const enabledFeatures = new Set<string>(creatorStudioEnabled ? [CREATOR_STUDIO_NAV_FLAG] : []);

  return (
    <div className="flex min-h-screen">
      <AppSidebar role={ctx.role} permissions={permissions} enabledFeatures={enabledFeatures} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          userId={ctx.userId}
          orgName={org.name}
          initialUnread={unread}
          permissions={permissions}
          enabledFeatures={enabledFeatures}
        />
        <main className="flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
