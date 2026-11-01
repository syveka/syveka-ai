export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getTranslations, getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { can } from "@/server/auth/permissions";
import {
  effectiveProbability,
  expectedRevenueCents,
  getDeal,
  listContactOptions,
  listOwnerOptions,
} from "@/server/services/deals";
import { listCompanyOptions } from "@/server/services/companies";
import { addDealNoteAction, deleteDealAction } from "@/actions/deals";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DealDialog } from "@/components/crm/deal-dialog";
import { DealInsights } from "@/components/crm/deal-insights";
import { DealTasks } from "@/components/crm/deal-tasks";
import { EntityActions } from "@/components/crm/entity-actions";
import { NoteComposer } from "@/components/crm/note-composer";
import { formatCents } from "@/lib/utils";
import { formatDateTimeInTimeZone } from "@/lib/date-time";
import { getViewerTimeZone } from "@/server/services/viewer-time-zone";
import { ActivityTimeline } from "@/components/crm/activity-timeline";
import { stageLabel } from "@/lib/crm/stage-labels";
import { Link } from "@/i18n/routing";
import { EntityMeetings } from "@/components/calendar/entity-meetings";

export default async function DealDetailPage({ params }: { params: Promise<{ dealId: string }> }) {
  const { dealId } = await params;
  const ctx = await requirePermission("crm:read");
  const t = await getTranslations("crm");
  const stageName = (s: { name: string; order: number; isWon: boolean; isLost: boolean }) =>
    stageLabel(s, (key) => t(`defaultStages.${key}`));
  const locale = await getLocale();
  const canWrite = can(ctx.role, "crm:write");
  const canDelete = can(ctx.role, "crm:delete");

  const [deal, contacts, companies, owners, timeZone] = await Promise.all([
    getDeal(ctx, dealId),
    canWrite ? listContactOptions(ctx) : Promise.resolve([]),
    canWrite ? listCompanyOptions(ctx) : Promise.resolve([]),
    listOwnerOptions(ctx),
    getViewerTimeZone(ctx.userId),
  ]);
  if (!deal) notFound();
  // Instants in the viewer's zone. The expected close date is a calendar date
  // stored as UTC midnight (YYYY-MM-DD from the form), so it is read in UTC.
  const formatDay = (value: Date, zone: string = timeZone) =>
    formatDateTimeInTimeZone(value, locale, zone, { dateStyle: "medium" });

  const probability = effectiveProbability(deal, deal.stage);
  const forecast = expectedRevenueCents(deal.valueCents, probability);
  const contact = deal.contact && !deal.contact.deletedAt ? deal.contact : null;
  const company = deal.company && !deal.company.deletedAt ? deal.company : null;
  const ownerName = deal.ownerId ? (owners.find((o) => o.id === deal.ownerId)?.name ?? null) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link href="/crm/deals" className="text-sm text-muted-foreground hover:underline">
            ← {t("deals")}
          </Link>
          <div className="mt-1 flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{deal.title}</h1>
            {deal.stage.isWon ? (
              <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                {t("wonBadge")}
              </span>
            ) : deal.stage.isLost ? (
              <span className="rounded-full bg-destructive/10 px-2 py-0.5 text-xs font-medium text-destructive">
                {t("lostBadge")}
              </span>
            ) : null}
          </div>
          <p className="text-sm text-muted-foreground">
            {formatCents(deal.valueCents, locale, deal.currency)} · {stageName(deal.stage)} ·{" "}
            {probability}%
          </p>
        </div>
        <div className="flex items-center gap-2">
          {canWrite ? (
            <DealDialog
              mode="edit"
              stages={deal.pipeline.stages.map((s) => ({ id: s.id, name: stageName(s) }))}
              contacts={contacts}
              companies={companies}
              owners={owners}
              deal={{
                id: deal.id,
                title: deal.title,
                valueCents: deal.valueCents,
                currency: deal.currency,
                probability: deal.probability,
                contactId: contact?.id ?? null,
                companyId: company?.id ?? null,
                ownerId: deal.ownerId,
                stageId: deal.stageId,
                expectedCloseAt: deal.expectedCloseAt?.toISOString().slice(0, 10) ?? null,
              }}
            />
          ) : null}
          <EntityActions
            archived={false}
            canWrite={canWrite}
            canDelete={canDelete}
            deleteAction={deleteDealAction.bind(null, deal.id)}
            afterDeleteHref="/crm/deals"
          />
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("about")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm">
              <InfoRow
                label={t("dealFields.value")}
                value={formatCents(deal.valueCents, locale, deal.currency)}
              />
              <InfoRow label={t("dealFields.probability")} value={`${probability}%`} />
              <InfoRow
                label={t("dealFields.forecast")}
                value={formatCents(forecast, locale, deal.currency)}
              />
              <InfoRow label={t("dealFields.stage")} value={stageName(deal.stage)} />
              <InfoRow label={t("dealFields.owner")} value={ownerName} />
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("fields.contact")}</span>
                {contact ? (
                  <Link href={`/crm/contacts/${contact.id}`} className="hover:underline">
                    {[contact.firstName, contact.lastName].filter(Boolean).join(" ")}
                  </Link>
                ) : (
                  <span>—</span>
                )}
              </div>
              <div className="flex justify-between gap-4">
                <span className="text-muted-foreground">{t("fields.company")}</span>
                {company ? (
                  <Link href={`/crm/companies/${company.id}`} className="hover:underline">
                    {company.name}
                  </Link>
                ) : (
                  <span>—</span>
                )}
              </div>
              <InfoRow
                label={t("dealFields.expectedClose")}
                value={deal.expectedCloseAt ? formatDay(deal.expectedCloseAt, "UTC") : null}
              />
              {deal.closedAt ? (
                <InfoRow label={t("closedLabel")} value={formatDay(deal.closedAt)} />
              ) : null}
              <InfoRow label={t("createdLabel")} value={formatDay(deal.createdAt)} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("tasks")}</CardTitle>
            </CardHeader>
            <CardContent>
              <DealTasks
                dealId={deal.id}
                canWrite={canWrite}
                timeZone={timeZone}
                tasks={deal.tasks.map((task) => ({
                  id: task.id,
                  subject: task.subject,
                  dueAt: task.dueAt?.toISOString() ?? null,
                  completedAt: task.completedAt?.toISOString() ?? null,
                }))}
              />
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle className="text-base">{t("timeline")}</CardTitle>
            {canWrite ? <DealInsights dealId={deal.id} /> : null}
          </CardHeader>
          <CardContent className="space-y-4">
            {canWrite ? <NoteComposer action={addDealNoteAction.bind(null, deal.id)} /> : null}
            <ActivityTimeline
              activities={deal.timeline}
              stages={deal.pipeline.stages}
              locale={locale}
              timeZone={timeZone}
            />
          </CardContent>
        </Card>
      </div>

      {can(ctx.role, "calendar:read") ? <EntityMeetings ctx={ctx} dealId={dealId} /> : null}
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4">
      <span className="text-muted-foreground">{label}</span>
      <span className="text-end">{value || "—"}</span>
    </div>
  );
}
