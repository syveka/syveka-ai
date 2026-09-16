export const dynamic = "force-dynamic";

import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { requirePermission } from "@/server/auth/guard";
import { tenantDb } from "@/server/db/tenant";
import { getEntitlements } from "@/server/services/billing/entitlements";
import { AssistantForm } from "@/components/voice/assistant-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Link } from "@/i18n/routing";
import type { VoiceAssistantInput } from "@/lib/validators/voice";

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
      return (
        <Card className="mx-auto max-w-md">
          <CardContent className="space-y-3 py-8 text-center">
            <h1 className="text-lg font-semibold">{t("title")}</h1>
            <p className="text-sm text-muted-foreground">{t("description", { plan: ent.plan })}</p>
            <p className="text-xs text-muted-foreground">
              {t("currentPlan")}: <span className="font-medium">{ent.plan}</span>
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
  };

  return <AssistantForm initial={initial} />;
}
