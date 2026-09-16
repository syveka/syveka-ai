"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import {
  saveAssistantAction,
  activateAssistantAction,
  deactivateAssistantAction,
  type VoiceActionState,
} from "@/actions/voice";
import { VOICE_TOOL_NAMES, type VoiceAssistantInput } from "@/lib/validators/voice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/routing";
import { AttachPhoneNumberForm } from "./attach-phone-number-form";

type Initial = VoiceAssistantInput & {
  id?: string;
  isActive?: boolean;
  phoneNumber?: string | null;
};

export function AssistantForm({ initial }: { initial?: Initial }) {
  const t = useTranslations("voice");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<VoiceActionState, FormData>(
    saveAssistantAction.bind(null, initial?.id),
    {},
  );
  const [activateState, activateAction, activatePending] = useActionState<
    VoiceActionState,
    FormData
  >(initial?.id ? activateAssistantAction.bind(null, initial.id) : async () => ({}), {});
  const [deactivateState, deactivateAction, deactivatePending] = useActionState<
    VoiceActionState,
    FormData
  >(initial?.id ? deactivateAssistantAction.bind(null, initial.id) : async () => ({}), {});

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <Link href="/voice" className="text-sm text-muted-foreground hover:underline">
          ← {t("title")}
        </Link>
        <div className="mt-1 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">{initial?.name ?? t("newAssistant")}</h1>
          {initial?.id && !initial.isActive ? (
            <form action={activateAction}>
              <Button type="submit" variant="default" disabled={activatePending}>
                {activatePending ? tc("loading") : t("activate")}
              </Button>
            </form>
          ) : null}
          {initial?.id && initial.isActive ? (
            <form action={deactivateAction}>
              <Button type="submit" variant="outline" disabled={deactivatePending}>
                {deactivatePending ? tc("loading") : t("deactivate")}
              </Button>
            </form>
          ) : null}
        </div>
        {initial?.phoneNumber ? (
          <p className="text-sm text-muted-foreground">
            {t("phoneNumber")}: <strong>{initial.phoneNumber}</strong>
          </p>
        ) : null}
        {activateState.phoneNumberPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("activatePhoneNumberPending")}
          </p>
        ) : null}
        {activateState.error ? (
          <p role="alert" className="text-sm text-destructive">
            {t("activateFailed")}
          </p>
        ) : null}
        {deactivateState.message === "deactivated" ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("deactivateSuccess")}
          </p>
        ) : null}
        {deactivateState.error ? (
          <p role="alert" className="text-sm text-destructive">
            {t("deactivateFailed")}
          </p>
        ) : null}
      </div>

      {initial?.id && !initial.phoneNumber ? (
        <AttachPhoneNumberForm assistantId={initial.id} />
      ) : null}

      <form action={action} className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("persona")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="name">{t("fields.name")}</Label>
                <Input id="name" name="name" defaultValue={initial?.name} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="language">{t("fields.language")}</Label>
                <select
                  id="language"
                  name="language"
                  defaultValue={initial?.language ?? "FI"}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  <option value="FI">Suomi</option>
                  <option value="EN">English</option>
                  <option value="AR">العربية</option>
                </select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="firstMessage">{t("fields.firstMessage")}</Label>
              <Input
                id="firstMessage"
                name="firstMessage"
                defaultValue={initial?.firstMessage}
                placeholder={t("firstMessagePlaceholder")}
                required
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="systemPrompt">{t("fields.systemPrompt")}</Label>
              <textarea
                id="systemPrompt"
                name="systemPrompt"
                defaultValue={initial?.systemPrompt}
                rows={6}
                required
                minLength={10}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
                placeholder={t("systemPromptPlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="transferNumber">{t("fields.transferNumber")}</Label>
              <Input
                id="transferNumber"
                name="transferNumber"
                type="tel"
                defaultValue={initial?.transferNumber}
                placeholder="+358 40 123 4567"
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("tools")}</CardTitle>
            <CardDescription>{t("toolsDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                name="useKnowledgeBase"
                value="true"
                defaultChecked={initial?.useKnowledgeBase ?? true}
                className="size-4"
              />
              {t("useKb")}
            </label>
            {VOICE_TOOL_NAMES.filter((n) => n !== "searchKnowledgeBase").map((tool) => (
              <label key={tool} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  name="enabledTools"
                  value={tool}
                  defaultChecked={initial?.enabledTools.includes(tool)}
                  className="size-4"
                />
                {t(`toolNames.${tool}` as never)}
              </label>
            ))}
          </CardContent>
        </Card>

        {state.error ? (
          <div role="alert" className="space-y-2">
            <p className="text-sm text-destructive">
              {t(`errors.${state.error}` as never) ?? t("errors.generic")}
            </p>
            {state.error === "entitlement_exceeded" ? (
              <Button asChild variant="outline" size="sm">
                <Link href="/settings/billing">{t("entitlementBlocked.upgradeButton")}</Link>
              </Button>
            ) : null}
          </div>
        ) : null}
        <Button type="submit" disabled={pending}>
          {pending ? tc("loading") : tc("save")}
        </Button>
      </form>
    </div>
  );
}
