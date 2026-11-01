import { getTranslations } from "next-intl/server";
import {
  displayActivity,
  type ActivityDisplayContext,
  type ActivityStage,
} from "@/lib/crm/activity-display";
import { formatDateTimeInTimeZone } from "@/lib/date-time";
import { Link } from "@/i18n/routing";
import { tenantDb } from "@/server/db/tenant";

export type TimelineActivity = {
  id: string;
  type: string;
  subject: string;
  body: string | null;
  metadata: unknown;
  createdAt: Date;
  user: { fullName: string | null } | null;
  /** Shown as a link on the company timeline. */
  contact?: { id: string; firstName: string; lastName: string | null } | null;
};

/**
 * The organization's pipeline stages a timeline needs to label stage changes,
 * read through the tenant-scoped Pipeline model (PipelineStage itself is only
 * scoped through its parent). Skipped when no entry is a stage change.
 */
export async function loadTimelineStages(
  orgId: string,
  activities: Array<{ type: string }>,
): Promise<ActivityStage[]> {
  if (!activities.some((a) => a.type === "STAGE_CHANGE")) return [];
  const pipelines = await tenantDb(orgId).pipeline.findMany({
    select: {
      stages: { select: { id: true, name: true, order: true, isWon: true, isLost: true } },
    },
  });
  return pipelines.flatMap((p) => p.stages);
}

/**
 * The CRM timeline shared by the deal, contact and company pages.
 *
 * Times are shown in the viewer's zone (`timeZone`, see src/lib/date-time.ts),
 * never the server runtime's (UTC). System-written stage-change and booking
 * entries are shown in the interface language when they match their exact
 * system pattern (src/lib/crm/activity-display.ts); every other entry, and
 * all stored data, is shown as stored.
 */
export async function ActivityTimeline({
  activities,
  stages,
  locale,
  timeZone,
}: {
  activities: TimelineActivity[];
  /** Pipeline stages, used only to label untouched default stages in stage changes. */
  stages: ActivityStage[];
  locale: string;
  timeZone: string;
}) {
  const t = await getTranslations("crm");
  const displayContext: ActivityDisplayContext = {
    translate: (key, values) => t(`systemActivity.${key}`, values),
    stageName: (key) => t(`defaultStages.${key}`),
    stagesById: new Map(stages.map((s) => [s.id, s])),
  };

  if (activities.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("noActivities")}</p>;
  }

  return (
    <div className="space-y-3">
      {activities.map((a) => {
        const shown = displayActivity(a, displayContext);
        return (
          <div key={a.id} className="border-s-2 border-border ps-3">
            <p className="text-sm font-medium">{shown.subject}</p>
            <p className="text-xs text-muted-foreground">
              {t(`activityTypes.${a.type}` as never)} ·{" "}
              <time dateTime={a.createdAt.toISOString()}>
                {formatDateTimeInTimeZone(a.createdAt, locale, timeZone, {
                  dateStyle: "medium",
                  timeStyle: "short",
                })}
              </time>
              {a.user?.fullName ? <> · {a.user.fullName}</> : null}
              {a.contact ? (
                <>
                  {" · "}
                  <Link href={`/crm/contacts/${a.contact.id}`} className="hover:underline">
                    {[a.contact.firstName, a.contact.lastName].filter(Boolean).join(" ")}
                  </Link>
                </>
              ) : null}
            </p>
            {shown.body && a.body !== a.subject ? (
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">{shown.body}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
