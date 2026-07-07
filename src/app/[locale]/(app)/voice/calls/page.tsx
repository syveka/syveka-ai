import { getTranslations, getLocale } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { listCalls } from "@/server/services/voice";
import { Link } from "@/i18n/routing";
import { Card, CardContent } from "@/components/ui/card";
import { formatDate, cn } from "@/lib/utils";

const SENTIMENT_STYLE: Record<string, string> = {
  positive: "bg-success/15 text-success",
  neutral: "bg-muted text-muted-foreground",
  negative: "bg-destructive/15 text-destructive",
};

export default async function CallsPage() {
  const ctx = await requirePermission("voice:view-calls");
  const t = await getTranslations("voice");
  const locale = await getLocale();
  const calls = await listCalls(ctx);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t("callLog")}</h1>
      <Card>
        <CardContent className="divide-y p-0">
          {calls.length === 0 ? (
            <p className="p-8 text-center text-sm text-muted-foreground">{t("noCalls")}</p>
          ) : (
            calls.map((call) => (
              <Link
                key={call.id}
                href={`/voice/calls/${call.id}`}
                className="flex items-center gap-3 p-4 hover:bg-accent/40"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">
                    {call.callerNumber ?? t("unknownCaller")} → {call.assistant.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {formatDate(call.startedAt, locale, { dateStyle: "medium", timeStyle: "short" })}
                    {call.durationSeconds
                      ? ` · ${Math.round(call.durationSeconds / 60)} min`
                      : ""}
                  </p>
                </div>
                {call.sentiment ? (
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs",
                      SENTIMENT_STYLE[call.sentiment],
                    )}
                  >
                    {t(`sentiment.${call.sentiment}` as never)}
                  </span>
                ) : null}
                <span className="text-xs text-muted-foreground">{call.status}</span>
              </Link>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
