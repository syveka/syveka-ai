import { getLocale, getTranslations } from "next-intl/server";
import { PlanCards } from "@/components/billing/plan-cards";
import { UsageMeters } from "@/components/billing/usage-meters";
import { PLAN_NAMES } from "@/components/billing/plan-display";
import { openPortalAction } from "@/actions/billing";
import { PendingSubmitButton } from "@/components/billing/pending-submit-button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDateTimeInTimeZone } from "@/lib/date-time";

export const dynamic = "force-dynamic";

/** Outcomes of a plan choice or a confirmed change, shown once after the redirect back. */
const PLAN_CHANGE_NOTICES = {
  busy: "planChangeBusy",
  unavailable: "planChangeUnavailable",
  already_current: "planChangeAlreadyCurrent",
  cancellation_pending: "planChangeCancellationPending",
  not_offered: "planChangeNotOffered",
  plan_change_submitted: "planChangeSubmitted",
} as const;

/** Stored statuses in which a scheduled cancellation is still ahead. */
const CANCELLATION_AHEAD_STATUSES: ReadonlySet<string> = new Set([
  "ACTIVE",
  "TRIALING",
  "PAST_DUE",
]);

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const [
    { requirePermission },
    { can },
    { getEntitlements, getMonthUsage },
    { tenantDb, unscopedPrisma },
  ] = await Promise.all([
    import("@/server/auth/guard"),
    import("@/server/auth/permissions"),
    import("@/server/services/billing/entitlements"),
    import("@/server/db/tenant"),
  ]);

  const ctx = await requirePermission("billing:view");
  const t = await getTranslations("billingPage");
  const locale = await getLocale();
  const { status } = await searchParams;
  const canManage = can(ctx.role, "billing:manage");

  const db = tenantDb(ctx.orgId);
  const [ent, aiMessages, voiceMinutes, contacts, storageAgg, seats, subscription, viewer] =
    await Promise.all([
      getEntitlements(ctx.orgId),
      getMonthUsage(ctx.orgId, "AI_MESSAGES"),
      getMonthUsage(ctx.orgId, "VOICE_MINUTES"),
      db.contact.count({ where: { deletedAt: null } }),
      db.document.aggregate({ where: { deletedAt: null }, _sum: { sizeBytes: true } }),
      db.organizationMember.count(),
      // The webhook-synced copy of Stripe's subscription (not the cached
      // entitlements), so a cancellation or its reversal shows as soon as
      // Stripe reports it.
      db.subscription.findFirst({
        select: { plan: true, status: true, cancelAtPeriodEnd: true, currentPeriodEnd: true },
      }),
      unscopedPrisma.user.findUnique({ where: { id: ctx.userId }, select: { timezone: true } }),
    ]);

  // Stripe ends a subscription set to cancel at its period end on that date;
  // until then the plan and its limits stay as they are.
  const cancellationEnds =
    subscription?.cancelAtPeriodEnd &&
    subscription.currentPeriodEnd &&
    subscription.plan !== "FREE" &&
    CANCELLATION_AHEAD_STATUSES.has(subscription.status)
      ? formatDateTimeInTimeZone(
          subscription.currentPeriodEnd,
          // Latin digits in Arabic too, like the plan prices (plan-display.ts).
          locale === "ar" ? "ar-u-nu-latn" : locale,
          viewer?.timezone,
          {
            dateStyle: "long",
          },
        )
      : null;
  const planChangeNotice =
    status && Object.hasOwn(PLAN_CHANGE_NOTICES, status)
      ? PLAN_CHANGE_NOTICES[status as keyof typeof PLAN_CHANGE_NOTICES]
      : null;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold">{t("title")}</h1>

      {status === "success" ? (
        <Card className="border-success/40">
          <CardContent className="pt-6 text-sm text-success">{t("checkoutSuccess")}</CardContent>
        </Card>
      ) : null}
      {planChangeNotice ? (
        <Card
          className={planChangeNotice === "planChangeSubmitted" ? undefined : "border-warning/40"}
        >
          <CardContent role="status" className="pt-6 text-sm">
            {t(planChangeNotice)}
          </CardContent>
        </Card>
      ) : null}
      {cancellationEnds && subscription ? (
        <Card className="border-warning/40">
          <CardContent className="flex flex-col gap-3 pt-6 text-sm sm:flex-row sm:items-center sm:justify-between">
            <p role="status">
              {t("cancellationScheduled", {
                plan: PLAN_NAMES[subscription.plan],
                date: cancellationEnds,
              })}
            </p>
            {canManage ? (
              <form action={openPortalAction}>
                <PendingSubmitButton variant="outline">{t("renewInPortal")}</PendingSubmitButton>
              </form>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {ent.status === "INCOMPLETE" ? (
        <Card className="border-warning/40">
          <CardContent className="flex flex-col gap-3 pt-6 text-sm sm:flex-row sm:items-center sm:justify-between">
            <p role="status">{t("paymentPending")}</p>
            {canManage ? (
              <form action={openPortalAction}>
                <PendingSubmitButton>{t("completePayment")}</PendingSubmitButton>
              </form>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {ent.status === "PAST_DUE" ? (
        <Card className="border-destructive/40">
          <CardContent className="pt-6 text-sm text-destructive">{t("pastDue")}</CardContent>
        </Card>
      ) : null}

      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm text-muted-foreground">{t("currentPlan")}</p>
          <p className="text-xl font-semibold">{PLAN_NAMES[ent.plan]}</p>
        </div>
        {canManage && ent.plan !== "FREE" ? (
          <form action={openPortalAction}>
            <PendingSubmitButton variant="outline">{t("managePortal")}</PendingSubmitButton>
          </form>
        ) : null}
      </div>

      <UsageMeters
        locale={locale}
        items={[
          {
            label: t("usage.aiMessages"),
            used: aiMessages,
            limit: ent.aiMessagesPerOrgMonth,
          },
          { label: t("usage.voiceMinutes"), used: voiceMinutes, limit: ent.voiceMinutesMonth },
          { label: t("usage.contacts"), used: contacts, limit: ent.maxContacts },
          {
            label: t("usage.storage"),
            used: Math.round((storageAgg._sum.sizeBytes ?? 0) / 1_048_576),
            limit: ent.kbStorageMb,
          },
          { label: t("usage.seats"), used: seats, limit: ent.maxSeats },
        ]}
      />

      {canManage ? <PlanCards currentPlan={ent.plan} /> : null}
    </div>
  );
}
