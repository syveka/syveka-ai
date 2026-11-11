export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getFormatter, getLocale, getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { tenantDb } from "@/server/db/tenant";
import { getEntitlements } from "@/server/services/billing/entitlements";
import { getAssistantReadiness } from "@/server/voice/assistant-readiness";
import {
  readRecordingSyncState,
  recordingStatusKind,
  type RecordingSyncState,
} from "@/server/voice/recording-sync";
import { AssistantForm } from "@/components/voice/assistant-form";
import { AssistantReadinessPanel } from "@/components/voice/assistant-readiness-panel";
import { RecordingStatusPanel } from "@/components/voice/recording-status-panel";
import { formatCount, PLAN_NAMES } from "@/components/billing/plan-display";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/routing";
import {
  recordingChoice,
  recordingToApply,
  type VoiceAssistantInput,
} from "@/lib/validators/voice";

export default async function AssistantPage({
  params,
}: {
  params: Promise<{ assistantId: string }>;
}) {
  const { assistantId } = await params;
  const ctx = await requirePermission("voice:configure");

  if (assistantId === "new") {
    // Detect the entitlement *before* the customer fills out the whole
    // form -- upsertAssistant() still independently enforces this at write
    // time (never removed, never weakened), but a FREE-plan org shouldn't
    // discover Voice AI is unavailable only after completing the form.
    const [ent, count] = await Promise.all([
      getEntitlements(ctx.orgId),
      tenantDb(ctx.orgId).voiceAssistant.count(),
    ]);
    if (count >= ent.voiceAssistants) {
      const t = await getTranslations("voice.entitlementBlocked");
      const plan = PLAN_NAMES[ent.plan];
      // A plan without assistants needs an upgrade; a plan at its limit
      // already includes Voice AI and has used every assistant it allows.
      const atLimit = ent.voiceAssistants > 0;
      return (
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-3 py-8 text-center">
            <h1 className="text-lg font-semibold">{atLimit ? t("limitTitle") : t("title")}</h1>
            <p className="text-sm text-muted-foreground">
              {atLimit
                ? t("limitDescription", {
                    plan,
                    limit: ent.voiceAssistants,
                    limitText: formatCount(await getLocale(), ent.voiceAssistants),
                  })
                : t("description", { plan })}
            </p>
            <p className="text-xs text-muted-foreground">
              {t("currentPlan")}: <span className="font-medium">{plan}</span>
            </p>
            <Button asChild>
              <Link href="/settings/billing">{t("upgradeButton")}</Link>
            </Button>
          </CardContent>
        </Card>
      );
    }
    return <AssistantForm />;
  }

  const assistant = await tenantDb(ctx.orgId).voiceAssistant.findFirst({
    where: { id: assistantId },
  });
  if (!assistant) notFound();

  const initial: VoiceAssistantInput & {
    id: string;
    isActive: boolean;
    phoneNumber: string | null;
  } = {
    id: assistant.id,
    isActive: assistant.isActive,
    phoneNumber: assistant.phoneNumber,
    name: assistant.name,
    language: assistant.language,
    voiceProvider: assistant.voiceProvider as "azure" | "elevenlabs",
    voiceId: assistant.voiceId ?? "",
    firstMessage: assistant.firstMessage,
    systemPrompt: assistant.systemPrompt,
    enabledTools: (assistant.enabledTools as VoiceAssistantInput["enabledTools"]) ?? [],
    useKnowledgeBase: assistant.useKnowledgeBase,
    transferNumber: assistant.transferNumber ?? "",
    recording: recordingChoice(
      recordingToApply(assistant.recordingEnabled, Boolean(assistant.vapiAssistantId)),
    ),
  };

  // The panel mustn't take the form down with it: saving is the remedy it often suggests.
  const [ent, t] = await Promise.all([
    getEntitlements(ctx.orgId).catch(() => null),
    getTranslations("voice.readiness"),
  ]);
  const readiness = await getAssistantReadiness(ctx.orgId, assistant, ent);

  // Read on every visit: a saved setting isn't what Vapi holds. Unreadable says so, never "fine".
  const recordingSync: RecordingSyncState | null =
    assistant.vapiAssistantId && assistant.recordingEnabled !== null
      ? await readRecordingSyncState(ctx.orgId, assistant.id, assistant.recordingEnabled).catch(
          () => null,
        )
      : null;
  const format = await getFormatter();
  const lastAccepted = recordingSync?.lastAccepted ?? null;

  const summaries = {
    clear: t("summaryReady"),
    blocked: t("summaryBlocked"),
    unverified: t("summaryUnverified"),
  };

  return (
    <AssistantForm
      initial={initial}
      deactivationIncomplete={Boolean(
        !assistant.isActive && assistant.vapiAssistantId && assistant.phoneNumber,
      )}
      recordingStatus={
        <RecordingStatusPanel
          assistantId={assistant.id}
          kind={recordingStatusKind({
            requested: assistant.recordingEnabled,
            inVapi: Boolean(assistant.vapiAssistantId),
            sync: recordingSync,
            reportedByVapi: readiness.recordingReportedByVapi,
          })}
          requested={assistant.recordingEnabled}
          reportedByVapi={readiness.recordingReportedByVapi}
          lastAccepted={
            lastAccepted
              ? {
                  enabled: lastAccepted.enabled,
                  at: format.dateTime(lastAccepted.at, { dateStyle: "medium", timeStyle: "short" }),
                }
              : null
          }
        />
      }
      statusPanel={
        <AssistantReadinessPanel
          text={{
            title: t("title"),
            summary: summaries[readiness.status],
            items: readiness.blockers.map((blocker) => ({
              key: blocker,
              title: t(`${blocker}.title`),
              action:
                blocker === "noPhoneNumber" && !assistant.vapiAssistantId
                  ? t("noPhoneNumber.actionOnceConnected")
                  : t(`${blocker}.action`),
            })),
            noticeLabel: t("noticeLabel"),
            notice: readiness.notice,
            noticeLanguage: assistant.language.toLowerCase(),
            noticeStatus: readiness.noticeApproved ? t("noticeApproved") : t("noticeAwaiting"),
            noticeApproved: readiness.noticeApproved,
          }}
        />
      }
    />
  );
}
