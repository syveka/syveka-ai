export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { Link } from "@/i18n/routing";

export default async function SuperadminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireSuperadmin();
  } catch {
    redirect("/dashboard");
  }

  return (
    <div className="min-h-screen">
      <header className="flex h-12 items-center gap-4 border-b bg-destructive/10 px-4 text-sm">
        <span className="font-semibold text-destructive">SYVEKA ADMIN</span>
        <Link href={"/admin/organizations" as never} className="hover:underline">
          Organizations
        </Link>
        <Link href="/dashboard" className="ms-auto text-muted-foreground hover:underline">
          Exit admin
        </Link>
      </header>
      <main className="p-6">{children}</main>
    </div>
  );
}
