import { redirect } from "next/navigation";
import { getTenantContextOrNull } from "@/server/auth/session";
import { permissionsFor } from "@/server/auth/permissions";
import { SettingsNav } from "@/components/settings/settings-nav";

/**
 * Shared navigation for every Settings page. Links are filtered by the same
 * permissions the pages enforce; each page still calls its own
 * requirePermission(), so hiding a link is never the authorization boundary.
 */
export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await getTenantContextOrNull();
  if (!ctx) redirect("/onboarding");

  return (
    <div className="flex flex-col gap-6 md:flex-row">
      <SettingsNav permissions={permissionsFor(ctx.role)} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
