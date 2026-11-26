export const dynamic = "force-dynamic";

import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { ArrowUpRight, Layers3 } from "lucide-react";
import { AdminNavigation } from "@/components/admin/admin-navigation";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { Link } from "@/i18n/routing";

export default async function SuperadminLayout({ children }: { children: React.ReactNode }) {
  try {
    await requireSuperadmin();
  } catch {
    redirect("/dashboard");
  }

  const t = await getTranslations("platformAdmin");

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-background lg:grid lg:grid-cols-[14.5rem_minmax(0,1fr)]">
      <aside className="flex flex-col gap-4 bg-slate-950 px-4 py-4 text-white lg:sticky lg:top-0 lg:h-dvh lg:gap-8 lg:px-5 lg:py-7">
        <div className="flex items-center justify-between gap-3">
          <Link href="/admin" className="inline-flex min-h-10 items-center gap-3 font-semibold">
            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-teal-300 text-slate-950">
              <Layers3 className="size-5" aria-hidden="true" />
            </span>
            {t("title")}
          </Link>
          <Link
            href="/dashboard"
            className="grid size-11 shrink-0 place-items-center rounded-lg text-slate-300 hover:bg-slate-800 lg:hidden"
            aria-label={t("exit")}
          >
            <ArrowUpRight className="size-5" aria-hidden="true" />
          </Link>
        </div>
        <AdminNavigation
          label={t("title")}
          overview={t("overview")}
          organizations={t("organizations")}
        />
        <Link
          href="/dashboard"
          className="mt-auto hidden min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-slate-300 hover:bg-slate-800 lg:flex"
        >
          <ArrowUpRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
          {t("exit")}
        </Link>
      </aside>
      <main className="min-w-0 px-4 py-6 sm:px-8 lg:py-10">
        <div className="mx-auto max-w-7xl">{children}</div>
      </main>
    </div>
  );
}
