import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { tenantDb } from "@/server/db/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/routing";

type TranscriptTurn = { role?: string; message?: string; content?: string };

export default async function CallDetailPage({
  params,
}: {
  params: Promise<{ callId: string }>;
}) {
  const { callId } = await params;
  const ctx = await requirePermission("voice:view-calls");
  const t = await getTranslations("voice");

  const call = await tenantDb(ctx.orgId).voiceCall.findFirst({
    where: { id: callId },
    include: { assistant: { select: { name: true } } },
  });
  if (!call) notFound();

  const transcript = (call.transcript as TranscriptTurn[] | null) ?? [];
  const followUps = (call.actionsTaken as string[]) ?? [];

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href="/voice/calls" className="text-sm text-muted-foreground hover:underline">
          ← {t("callLog")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">
          {call.callerNumber ?? t("unknownCaller")} → {call.assistant.name}
        </h1>
      </div>

      {call.summary ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("summary")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p>{call.summary}</p>
            {followUps.length > 0 ? (
              <div>
                <p className="font-medium">{t("followUps")}:</p>
                <ul className="ms-4 list-disc space-y-1 text-muted-foreground">
                  {followUps.map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {call.recordingUrl ? (
        <Card>
          <CardContent className="pt-6">
            <audio controls src={call.recordingUrl} className="w-full" />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("transcript")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {transcript.length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            transcript
              .filter((turn) => turn.role !== "system")
              .map((turn, i) => (
                <div key={i} className="text-sm">
                  <span className="font-medium">
                    {turn.role === "bot" || turn.role === "assistant"
                      ? call.assistant.name
                      : t("caller")}
                    :
                  </span>{" "}
                  <span className="text-muted-foreground">{turn.message ?? turn.content ?? ""}</span>
                </div>
              ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
