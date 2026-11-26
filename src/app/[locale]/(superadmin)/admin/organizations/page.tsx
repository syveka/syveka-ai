export const dynamic = "force-dynamic";

import { Building2, ChevronRight, Search } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";
import { Link } from "@/i18n/routing";

export default async function AdminOrganizationsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string | string[] }>;
}) {
  await requireSuperadmin();

  const [{ q }, locale, t, common] = await Promise.all([
    searchParams,
    getLocale(),
    getTranslations("platformAdmin"),
    getTranslations("common"),
  ]);
  const query = typeof q === "string" ? q.trim() : "";
  const orgs = await unscopedPrisma.organization.findMany({
    where: {
      deletedAt: null,
      ...(query ? { name: { contains: query, mode: "insensitive" } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: {
      subscription: { select: { plan: true, status: true } },
      _count: { select: { members: true, contacts: true, voiceCalls: true } },
    },
  });
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });

  return (
    <div className="space-y-6">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("organizations")}</h1>

      <form method="get" role="search" className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-0 flex-1 sm:max-w-sm">
          <span className="sr-only">{t("searchOrganizations")}</span>
          <Search
            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            name="q"
            defaultValue={query}
            placeholder={t("searchOrganizations")}
            className="h-11 w-full rounded-xl border bg-card pe-3 ps-9 text-sm"
          />
        </label>
        <button
          type="submit"
          className="min-h-11 rounded-xl border bg-card px-4 text-sm font-medium hover:bg-accent"
        >
          {common("search")}
        </button>
      </form>

      <div className="overflow-hidden rounded-2xl border bg-card shadow-sm">
        {orgs.length === 0 ? (
          <p className="p-5 text-sm text-muted-foreground">{t("noOrganizations")}</p>
        ) : (
          <ul className="divide-y">
            {orgs.map((org) => (
              <li key={org.id}>
                <Link
                  href={`/admin/organizations/${org.id}`}
                  className="flex items-center gap-3 px-4 py-4 hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:gap-4 sm:px-5"
                >
                  <span className="hidden size-10 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200 sm:grid">
                    <Building2 className="size-4" aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="break-words text-sm font-semibold">{org.name}</p>
                    <p className="break-words text-xs text-muted-foreground">
                      <bdi>{org.slug}</bdi> ·{" "}
                      {org.businessId ? <bdi>{org.businessId}</bdi> : t("noBusinessId")} ·{" "}
                      {date.format(org.createdAt)}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {t("organizationCounts", {
                        members: org._count.members,
                        contacts: org._count.contacts,
                        calls: org._count.voiceCalls,
                      })}
                    </p>
                  </div>
                  <div className="space-y-1 text-end">
                    <span className="inline-block rounded-full bg-secondary px-2.5 py-1 text-xs font-medium">
                      {t(`plans.${org.subscription?.plan ?? "FREE"}`)}
                    </span>
                    {org.subscription && org.subscription.status !== "ACTIVE" && (
                      <p className="text-xs text-muted-foreground">
                        {t(`statuses.${org.subscription.status}`)}
                      </p>
                    )}
                  </div>
                  <ChevronRight
                    className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
