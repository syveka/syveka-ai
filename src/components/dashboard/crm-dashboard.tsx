import {
  Bot,
  CalendarClock,
  CheckCircle2,
  Clock3,
  HandCoins,
  Mail,
  MessageSquare,
  Sparkles,
  TrendingUp,
  UserPlus,
  Users,
} from "lucide-react";
import type React from "react";
import { getTranslations } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CrmDashboard } from "@/server/services/dashboard";
import { cn, formatCents, formatDate } from "@/lib/utils";

type DashboardProps = {
  dashboard: CrmDashboard;
  locale: string;
};

type DashboardLabels = {
  title: string;
  subtitle: string;
  totalCustomers: string;
  activeDeals: string;
  revenue: string;
  tasksDueToday: string;
  aiConversations: string;
  growthPct: string;
  growthDetail: string;
  aiMessagesDetail: string;
  activityFeed: string;
  latestCustomerActivity: string;
  latestAiActivity: string;
  latestPayments: string;
  latestTasks: string;
  quickActions: string;
  newLead: string;
  newCustomer: string;
  createDeal: string;
  scheduleMeeting: string;
  aiChat: string;
  sendEmail: string;
  pipelinePreview: string;
  pipelineForecast: string;
  calendarWidget: string;
  upcomingMeetings: string;
  upcomingTasks: string;
  aiInsights: string;
  generatedWith: string;
  aiConversation: string;
  billingStatus: string;
  currentPeriodEnds: string;
  completed: string;
  emptyValue: string;
  paymentSummary: string;
  stageSummary: string;
  noPipeline: string;
  emptyActivity: string;
  emptyPayments: string;
  emptyTasks: string;
  emptyMeetings: string;
  insightActiveDeals: string;
  insightNoActiveDeals: string;
  insightOverdueTasks: string;
  insightNoOverdueTasks: string;
  insightCustomerGrowth: string;
  insightNoCustomerGrowth: string;
  insightAiMessages: string;
  insightNoAiMessages: string;
};

function formatDateTime(date: Date | string | null, locale: string): string {
  if (!date) return "";
  return formatDate(date, locale, { dateStyle: "medium", timeStyle: "short" });
}

function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

function formatPercent(value: number | null, locale: string, emptyValue: string): string {
  if (value === null) return emptyValue;
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 0,
  }).format(value / 100);
}

function EmptyState({ label }: { label: string }) {
  return <p className="py-4 text-start text-sm text-muted-foreground">{label}</p>;
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return <h3 className="text-start text-sm font-medium text-muted-foreground">{children}</h3>;
}

function KpiCard({
  label,
  value,
  detail,
  icon: Icon,
  tone = "default",
}: {
  label: string;
  value: string | number;
  detail?: string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: "default" | "success" | "warning";
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
        <span
          className={cn(
            "rounded-md border p-2",
            tone === "success" && "border-success/20 bg-success/10 text-success",
            tone === "warning" && "border-warning/30 bg-warning/10 text-warning",
            tone === "default" && "bg-muted text-muted-foreground",
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </span>
      </CardHeader>
      <CardContent>
        <p className="text-start text-2xl font-semibold md:text-3xl">{value}</p>
        {detail ? <p className="mt-1 text-start text-sm text-muted-foreground">{detail}</p> : null}
      </CardContent>
    </Card>
  );
}

function ActivityRow({
  title,
  meta,
  at,
  locale,
}: {
  title: string;
  meta?: string | null;
  at?: Date | string | null;
  locale: string;
}) {
  return (
    <li className="flex items-start justify-between gap-3 border-b py-3 last:border-0">
      <div className="min-w-0">
        <p className="truncate text-start text-sm font-medium">{title}</p>
        {meta ? <p className="truncate text-start text-xs text-muted-foreground">{meta}</p> : null}
      </div>
      {at ? (
        <time
          className="shrink-0 text-start text-xs text-muted-foreground"
          dateTime={new Date(at).toISOString()}
        >
          {formatDateTime(at, locale)}
        </time>
      ) : null}
    </li>
  );
}

function ActivityFeed({ dashboard, locale, labels }: DashboardProps & { labels: DashboardLabels }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{labels.activityFeed}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5 lg:grid-cols-2">
        <section>
          <SectionTitle>{labels.latestCustomerActivity}</SectionTitle>
          {dashboard.feed.customerActivities.length > 0 ? (
            <ul>
              {dashboard.feed.customerActivities.map((item) => (
                <ActivityRow
                  key={item.id}
                  title={item.subject}
                  meta={item.contactName ?? item.dealTitle}
                  at={item.at}
                  locale={locale}
                />
              ))}
            </ul>
          ) : (
            <EmptyState label={labels.emptyActivity} />
          )}
        </section>

        {dashboard.permissions.canUseChat ? (
          <section>
            <SectionTitle>{labels.latestAiActivity}</SectionTitle>
            {dashboard.feed.aiActivities.length > 0 ? (
              <ul>
                {dashboard.feed.aiActivities.map((item) => (
                  <ActivityRow
                    key={item.id}
                    title={item.title}
                    meta={item.model ?? labels.aiConversation}
                    at={item.at}
                    locale={locale}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState label={labels.emptyActivity} />
            )}
          </section>
        ) : null}

        {dashboard.permissions.canViewBilling ? (
          <section>
            <SectionTitle>{labels.latestPayments}</SectionTitle>
            {dashboard.feed.payments.length > 0 ? (
              <ul>
                {dashboard.feed.payments.map((item) => (
                  <ActivityRow
                    key={item.id}
                    title={labels.paymentSummary
                      .replace("{plan}", item.plan)
                      .replace("{status}", item.status)}
                    meta={
                      item.currentPeriodEnd
                        ? labels.currentPeriodEnds.replace(
                            "{date}",
                            formatDateTime(item.currentPeriodEnd, locale),
                          )
                        : labels.billingStatus
                    }
                    at={item.at}
                    locale={locale}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState label={labels.emptyPayments} />
            )}
          </section>
        ) : null}

        <section>
          <SectionTitle>{labels.latestTasks}</SectionTitle>
          {dashboard.feed.tasks.length > 0 ? (
            <ul>
              {dashboard.feed.tasks.map((item) => (
                <ActivityRow
                  key={item.id}
                  title={item.subject}
                  meta={item.completedAt ? labels.completed : (item.contactName ?? item.dealTitle)}
                  at={item.dueAt}
                  locale={locale}
                />
              ))}
            </ul>
          ) : (
            <EmptyState label={labels.emptyTasks} />
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function QuickActions({ dashboard, labels }: DashboardProps & { labels: DashboardLabels }) {
  const actions = [
    dashboard.permissions.canWriteCrm
      ? { label: labels.newLead, href: "/crm/contacts", icon: UserPlus }
      : null,
    dashboard.permissions.canWriteCrm
      ? { label: labels.newCustomer, href: "/crm/contacts", icon: Users }
      : null,
    dashboard.permissions.canWriteCrm
      ? { label: labels.createDeal, href: "/crm/deals", icon: HandCoins }
      : null,
    dashboard.permissions.canReadCalendar
      ? { label: labels.scheduleMeeting, href: "/calendar", icon: CalendarClock }
      : null,
    dashboard.permissions.canUseChat
      ? { label: labels.aiChat, href: "/chat", icon: MessageSquare }
      : null,
  ].filter((action): action is Exclude<typeof action, null> => action !== null);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{labels.quickActions}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {actions.map((action) => (
          <Button key={action.label} asChild variant="outline" className="justify-start">
            <Link href={action.href}>
              <action.icon className="size-4" aria-hidden="true" />
              {action.label}
            </Link>
          </Button>
        ))}
        <Button asChild variant="outline" className="justify-start">
          <a href="mailto:">
            <Mail className="size-4" aria-hidden="true" />
            {labels.sendEmail}
          </a>
        </Button>
      </CardContent>
    </Card>
  );
}

function PipelinePreview({
  dashboard,
  locale,
  labels,
}: DashboardProps & { labels: DashboardLabels }) {
  const max = Math.max(1, ...dashboard.pipeline.stages.map((stage) => stage.count));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{labels.pipelinePreview}</CardTitle>
      </CardHeader>
      <CardContent>
        {dashboard.pipeline.stages.length > 0 ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-muted-foreground">{dashboard.pipeline.name}</span>
              <strong>{formatCents(dashboard.pipeline.openValueCents, locale)}</strong>
            </div>
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-muted-foreground">{labels.pipelineForecast}</span>
              <span className="text-muted-foreground">
                {formatCents(dashboard.pipeline.forecastValueCents, locale)}
              </span>
            </div>
            {dashboard.pipeline.stages.map((stage) => (
              <div key={stage.id}>
                <div className="mb-1 flex items-center justify-between gap-3 text-sm">
                  <span className="truncate text-start">{stage.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {labels.stageSummary
                      .replace("{count}", formatNumber(stage.count, locale))
                      .replace("{value}", formatCents(stage.valueCents, locale))}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded bg-muted">
                  <div
                    className={cn(
                      "h-full rounded",
                      stage.isWon
                        ? "bg-success"
                        : stage.isLost
                          ? "bg-destructive/70"
                          : "bg-primary/70",
                    )}
                    style={{ width: `${Math.max(4, (stage.count / max) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState label={labels.noPipeline} />
        )}
      </CardContent>
    </Card>
  );
}

function CalendarWidget({
  dashboard,
  locale,
  labels,
}: DashboardProps & { labels: DashboardLabels }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{labels.calendarWidget}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {dashboard.permissions.canReadCalendar ? (
          <section>
            <SectionTitle>{labels.upcomingMeetings}</SectionTitle>
            {dashboard.calendar.meetings.length > 0 ? (
              <ul>
                {dashboard.calendar.meetings.map((meeting) => (
                  <ActivityRow
                    key={meeting.id}
                    title={meeting.title}
                    meta={meeting.source}
                    at={meeting.startsAt}
                    locale={locale}
                  />
                ))}
              </ul>
            ) : (
              <EmptyState label={labels.emptyMeetings} />
            )}
          </section>
        ) : null}
        <section>
          <SectionTitle>{labels.upcomingTasks}</SectionTitle>
          {dashboard.calendar.tasks.length > 0 ? (
            <ul>
              {dashboard.calendar.tasks.map((task) => (
                <ActivityRow
                  key={task.id}
                  title={task.subject}
                  meta={task.contactName ?? task.dealTitle}
                  at={task.dueAt}
                  locale={locale}
                />
              ))}
            </ul>
          ) : (
            <EmptyState label={labels.emptyTasks} />
          )}
        </section>
      </CardContent>
    </Card>
  );
}

function AiInsights({ dashboard, labels }: DashboardProps & { labels: DashboardLabels }) {
  const items = [
    dashboard.insights.activeDeals > 0 ? labels.insightActiveDeals : labels.insightNoActiveDeals,
    dashboard.insights.overdueTasks > 0 ? labels.insightOverdueTasks : labels.insightNoOverdueTasks,
    dashboard.insights.customerGrowthPct !== null
      ? labels.insightCustomerGrowth
      : labels.insightNoCustomerGrowth,
    dashboard.permissions.canUseChat
      ? dashboard.insights.aiMessagesThisMonth > 0
        ? labels.insightAiMessages
        : labels.insightNoAiMessages
      : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">{labels.aiInsights}</CardTitle>
        <Sparkles className="size-4 text-primary" aria-hidden="true" />
      </CardHeader>
      <CardContent>
        <ul className="space-y-3">
          {items.map((item) => (
            <li key={item} className="flex gap-3 text-sm">
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
              <span className="text-start">{item}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-xs text-muted-foreground">
          {labels.generatedWith}: {dashboard.insights.provider} / {dashboard.insights.model}
        </p>
      </CardContent>
    </Card>
  );
}

export async function CrmDashboardView({ dashboard, locale }: DashboardProps) {
  const t = await getTranslations("dashboard");
  const labels = {
    title: t("title"),
    subtitle: t("subtitle"),
    totalCustomers: t("totalCustomers"),
    activeDeals: t("activeDeals"),
    revenue: t("revenue"),
    tasksDueToday: t("tasksDueToday"),
    aiConversations: t("aiConversations"),
    growthPct: t("growthPct"),
    growthDetail: t("growthDetail"),
    aiMessagesDetail: t("aiMessagesDetail", {
      count: formatNumber(dashboard.kpis.aiMessagesThisMonth, locale),
    }),
    activityFeed: t("activityFeed"),
    latestCustomerActivity: t("latestCustomerActivity"),
    latestAiActivity: t("latestAiActivity"),
    latestPayments: t("latestPayments"),
    latestTasks: t("latestTasks"),
    quickActions: t("quickActions"),
    newLead: t("newLead"),
    newCustomer: t("newCustomer"),
    createDeal: t("createDeal"),
    scheduleMeeting: t("scheduleMeeting"),
    aiChat: t("aiChat"),
    sendEmail: t("sendEmail"),
    pipelinePreview: t("pipelinePreview"),
    pipelineForecast: t("pipelineForecast"),
    calendarWidget: t("calendarWidget"),
    upcomingMeetings: t("upcomingMeetings"),
    upcomingTasks: t("upcomingTasks"),
    aiInsights: t("aiInsights"),
    generatedWith: t("generatedWith"),
    aiConversation: t("aiConversation"),
    billingStatus: t("billingStatus"),
    currentPeriodEnds: t("currentPeriodEnds", { date: "{date}" }),
    completed: t("completed"),
    emptyValue: t("emptyValue"),
    paymentSummary: t("paymentSummary", { plan: "{plan}", status: "{status}" }),
    stageSummary: t("stageSummary", { count: "{count}", value: "{value}" }),
    noPipeline: t("noPipeline"),
    emptyActivity: t("emptyActivity"),
    emptyPayments: t("emptyPayments"),
    emptyTasks: t("emptyTasks"),
    emptyMeetings: t("emptyMeetings"),
    insightActiveDeals: t("insightActiveDeals", {
      count: formatNumber(dashboard.insights.activeDeals, locale),
    }),
    insightNoActiveDeals: t("insightNoActiveDeals"),
    insightOverdueTasks: t("insightOverdueTasks", {
      count: formatNumber(dashboard.insights.overdueTasks, locale),
    }),
    insightNoOverdueTasks: t("insightNoOverdueTasks"),
    insightCustomerGrowth: t("insightCustomerGrowth", {
      percent: formatPercent(dashboard.insights.customerGrowthPct, locale, t("emptyValue")),
    }),
    insightNoCustomerGrowth: t("insightNoCustomerGrowth"),
    insightAiMessages: t("insightAiMessages", {
      count: formatNumber(dashboard.insights.aiMessagesThisMonth, locale),
    }),
    insightNoAiMessages: t("insightNoAiMessages"),
  };

  const growthValue = formatPercent(dashboard.kpis.customerGrowthPct, locale, labels.emptyValue);

  return (
    <div className="space-y-6 text-start">
      <div className="flex flex-col gap-2 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{labels.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{labels.subtitle}</p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        <KpiCard
          label={labels.totalCustomers}
          value={formatNumber(dashboard.kpis.totalCustomers, locale)}
          icon={Users}
        />
        <KpiCard
          label={labels.activeDeals}
          value={formatNumber(dashboard.kpis.activeDeals, locale)}
          icon={HandCoins}
        />
        <KpiCard
          label={labels.revenue}
          value={formatCents(dashboard.kpis.revenueCents, locale)}
          icon={TrendingUp}
          tone="success"
        />
        <KpiCard
          label={labels.tasksDueToday}
          value={formatNumber(dashboard.kpis.tasksDueToday, locale)}
          icon={Clock3}
          tone={dashboard.kpis.tasksDueToday > 0 ? "warning" : "default"}
        />
        {dashboard.permissions.canUseChat ? (
          <KpiCard
            label={labels.aiConversations}
            value={formatNumber(dashboard.kpis.aiConversations, locale)}
            detail={labels.aiMessagesDetail}
            icon={Bot}
          />
        ) : null}
        <KpiCard
          label={labels.growthPct}
          value={growthValue}
          detail={labels.growthDetail}
          icon={TrendingUp}
          tone="success"
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <ActivityFeed dashboard={dashboard} locale={locale} labels={labels} />
        <QuickActions dashboard={dashboard} locale={locale} labels={labels} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <PipelinePreview dashboard={dashboard} locale={locale} labels={labels} />
        <CalendarWidget dashboard={dashboard} locale={locale} labels={labels} />
        <AiInsights dashboard={dashboard} locale={locale} labels={labels} />
      </div>
    </div>
  );
}

export function DashboardSkeleton() {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-4 w-72 max-w-full animate-pulse rounded bg-muted" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, index) => (
          <Card key={index}>
            <CardHeader className="pb-2">
              <div className="h-4 w-24 animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardContent>
              <div className="h-8 w-20 animate-pulse rounded bg-muted" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <Card>
          <CardHeader>
            <div className="h-5 w-32 animate-pulse rounded bg-muted" />
          </CardHeader>
          <CardContent className="grid gap-4 lg:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="space-y-3">
                <div className="h-4 w-28 animate-pulse rounded bg-muted" />
                <div className="h-12 animate-pulse rounded bg-muted" />
                <div className="h-12 animate-pulse rounded bg-muted" />
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="h-5 w-28 animate-pulse rounded bg-muted" />
          </CardHeader>
          <CardContent className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }).map((_, index) => (
              <div key={index} className="h-9 animate-pulse rounded-md bg-muted" />
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
