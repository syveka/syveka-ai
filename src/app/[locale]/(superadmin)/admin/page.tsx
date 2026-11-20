export const dynamic = "force-dynamic";

import { Activity, ArrowUpRight, Building2, CreditCard, Phone } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { requireSuperadmin } from "@/server/auth/superadmin";
import { unscopedPrisma } from "@/server/db/tenant";

export default async function AdminOverviewPage() {
  await requireSuperadmin();

  const [locale, t] = await Promise.all([getLocale(), getTranslations("platformAdmin")]);
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const firstMonth = new Date(Date.UTC(year, month - 5));
  const months = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(year, month - 5 + i)));
  const currentMonth = new Date(Date.UTC(year, month));
  const nextMonth = new Date(Date.UTC(year, month + 1));
  const organization = { deletedAt: null };
  const [organizationCount, subscriptions, messagesByDay, voice] = await Promise.all([
    unscopedPrisma.organization.count({ where: organization }),
    unscopedPrisma.subscription.groupBy({
      by: ["plan"],
      where: { status: "ACTIVE", organization },
      _count: { _all: true },
      orderBy: { plan: "asc" },
    }),
    unscopedPrisma.usageRecord.groupBy({
      by: ["periodStart"],
      where: {
        organization,
        metric: "AI_MESSAGES",
        periodStart: { gte: firstMonth, lt: nextMonth },
      },
      _sum: { quantity: true },
    }),
    unscopedPrisma.usageRecord.aggregate({
      where: {
        organization,
        metric: "VOICE_MINUTES",
        periodStart: { gte: currentMonth, lt: nextMonth },
      },
      _sum: { quantity: true },
    }),
  ]);

  const number = new Intl.NumberFormat(locale);
  const monthShort = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
  const monthLong = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  const messageTotals = new Map<number, number>();
  for (const { periodStart, _sum } of messagesByDay) {
    const key = Date.UTC(periodStart.getUTCFullYear(), periodStart.getUTCMonth());
    messageTotals.set(key, (messageTotals.get(key) ?? 0) + (_sum.quantity ?? 0));
  }

  const messageMax = Math.max(0, ...messageTotals.values());
  const subscriptionCount = subscriptions.reduce((sum, item) => sum + item._count._all, 0);
  const paidCount = subscriptions
    .filter(({ plan }) => plan !== "FREE")
    .reduce((sum, item) => sum + item._count._all, 0);
  const metrics = [
    { label: t("organizations"), value: organizationCount, icon: Building2 },
    { label: t("activePaidPlans"), value: paidCount, icon: CreditCard },
    {
      label: t("monthlyMessages"),
      value: messageTotals.get(currentMonth.getTime()) ?? 0,
      icon: Activity,
    },
    { label: t("monthlyVoice"), value: voice._sum.quantity ?? 0, icon: Phone },
  ];

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("overview")}</h1>
          <p className="text-sm text-muted-foreground">{monthLong.format(currentMonth)} · UTC</p>
        </div>
        <Link
          href="/admin/organizations"
          className="inline-flex min-h-11 items-center gap-2 rounded-xl bg-slate-950 px-4 text-sm font-medium text-white hover:bg-slate-800 dark:bg-teal-300 dark:text-slate-950 dark:hover:bg-teal-200"
        >
          {t("manageOrganizations")}
          <ArrowUpRight className="size-4 rtl:-scale-x-100" aria-hidden="true" />
        </Link>
      </header>

      <dl className="grid grid-cols-2 gap-3 lg:gap-4 xl:grid-cols-4">
        {metrics.map(({ label, value, icon: Icon }) => (
          <div key={label} className="min-w-0 rounded-2xl border bg-card p-4 shadow-sm sm:p-5">
            <span className="mb-4 grid size-9 place-items-center rounded-xl bg-teal-50 text-teal-800 dark:bg-teal-950 dark:text-teal-200">
              <Icon className="size-4" aria-hidden="true" />
            </span>
            <dt className="text-sm leading-snug text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words text-2xl font-semibold tabular-nums sm:text-3xl">
              {number.format(value)}
            </dd>
          </div>
        ))}
      </dl>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="min-w-0 rounded-2xl bg-slate-950 p-4 text-white shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold">{t("messageHistory")}</h2>
          <p className="mt-1 text-sm text-slate-300">{t("messageHistoryPeriod")}</p>

          {messageMax > 0 ? (
            <ul className="mt-8 grid grid-cols-3 gap-x-3 gap-y-6 sm:grid-cols-6">
              {months.map((date) => {
                const count = messageTotals.get(date.getTime()) ?? 0;

                return (
                  <li key={date.toISOString()} className="flex min-w-0 flex-col items-center gap-2">
                    <span className="sr-only">{monthLong.format(date)}</span>
                    <span className="max-w-full break-all text-sm tabular-nums">
                      {number.format(count)}
                    </span>
                    <div
                      className="flex h-24 w-full max-w-12 items-end rounded-lg bg-slate-800 sm:h-36"
                      aria-hidden="true"
                    >
                      <div
                        className="w-full rounded-lg bg-gradient-to-t from-teal-600 to-teal-200"
                        style={{ height: `${(100 * count) / messageMax}%` }}
                      />
                    </div>
                    <span className="text-center text-xs text-slate-300" aria-hidden="true">
                      {monthShort.format(date)}
                    </span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-8 rounded-xl border border-slate-700 p-4 text-sm text-slate-300">
              {t("noMessageHistory")}
            </p>
          )}
        </section>

        <section className="rounded-2xl border bg-card p-4 shadow-sm sm:p-6">
          <h2 className="text-lg font-semibold">{t("planDistribution")}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("activeSubscriptions", { count: subscriptionCount })}
          </p>
          {subscriptionCount > 0 && (
            <ul className="mt-6 space-y-4">
              {subscriptions.map(({ plan, _count }) => (
                <li key={plan} className="space-y-2">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="font-medium">{t(`plans.${plan}`)}</span>
                    <span className="tabular-nums">{number.format(_count._all)}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-secondary" aria-hidden="true">
                    <div
                      className="h-full rounded-full bg-teal-600 dark:bg-teal-300"
                      style={{ width: `${(100 * _count._all) / subscriptionCount}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
