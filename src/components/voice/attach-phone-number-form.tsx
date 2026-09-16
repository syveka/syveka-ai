"use client";

import { useActionState, useState } from "react";
import { useTranslations } from "next-intl";
import { attachPhoneNumberAction, type VoiceActionState } from "@/actions/voice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

/**
 * Attach an existing, externally-held number (Twilio import, or a generic
 * BYO SIP trunk) -- the only route to a real +358 (or any other non-US/CA)
 * number today, since Vapi's own native pool is US/Canada-only. Shown once
 * the assistant is synced to Vapi but has no phone number yet.
 */
export function AttachPhoneNumberForm({ assistantId }: { assistantId: string }) {
  const t = useTranslations("voice.attachPhoneNumber");
  const tc = useTranslations("common");
  const [provider, setProvider] = useState<"twilio" | "byo-phone-number">("twilio");
  const [state, action, pending] = useActionState<VoiceActionState, FormData>(
    attachPhoneNumberAction.bind(null, assistantId),
    {},
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="provider">{t("provider")}</Label>
            <select
              id="provider"
              name="provider"
              value={provider}
              onChange={(e) => setProvider(e.target.value as typeof provider)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              <option value="twilio">{t("providerTwilio")}</option>
              <option value="byo-phone-number">{t("providerByo")}</option>
            </select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="phoneNumber">{t("phoneNumber")}</Label>
            <Input
              id="phoneNumber"
              name="phoneNumber"
              type="tel"
              placeholder="+358401234567"
              required
            />
          </div>

          {provider === "twilio" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="twilioAccountSid">{t("twilioAccountSid")}</Label>
                <Input id="twilioAccountSid" name="twilioAccountSid" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="twilioAuthToken">{t("twilioAuthToken")}</Label>
                <Input id="twilioAuthToken" name="twilioAuthToken" type="password" required />
              </div>
            </>
          ) : (
            <div className="space-y-1.5">
              <Label htmlFor="sipUri">{t("sipUri")}</Label>
              <Input id="sipUri" name="sipUri" required />
            </div>
          )}

          {state.message === "phone_number_attached" ? (
            <p role="status" className="text-sm text-success">
              {t("success")}
            </p>
          ) : null}
          {state.error === "phone_number_in_use" ? (
            <p role="alert" className="text-sm text-destructive">
              {t("errors.phoneNumberInUse")}
            </p>
          ) : null}
          {state.error === "assistant_not_synced" ? (
            <p role="alert" className="text-sm text-destructive">
              {t("errors.assistantNotSynced")}
            </p>
          ) : null}
          {state.error === "invalid_input" ? (
            <p role="alert" className="text-sm text-destructive">
              {t("errors.invalidInput")}
            </p>
          ) : null}
          {state.error &&
          !["phone_number_in_use", "assistant_not_synced", "invalid_input"].includes(
            state.error,
          ) ? (
            <p role="alert" className="text-sm text-destructive">
              {t("errors.generic")}
            </p>
          ) : null}

          <Button type="submit" disabled={pending} variant="outline">
            {pending ? tc("loading") : t("submit")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
