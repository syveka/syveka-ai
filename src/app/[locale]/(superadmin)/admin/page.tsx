export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { requireSuperadminPage } from "@/server/auth/page-guard";

export default async function AdminIndex() {
  // Guarded like every page in this group, so a denied visit to /admin is
  // logged here too instead of only being redirected by the layout.
  await requireSuperadminPage();
  redirect("/admin/organizations" as never);
}
