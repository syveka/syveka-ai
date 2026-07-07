"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { forgotPasswordAction, type AuthActionState } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ForgotPasswordForm() {
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<AuthActionState, FormData>(
    forgotPasswordAction,
    {},
  );

  if (state.message === "verify_email_sent") {
    return (
      <Card>
        <CardContent className="pt-6 text-center text-sm">{t("verifyEmailSent")}</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{t("forgotPassword")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t("email")}</Label>
            <Input id="email" name="email" type="email" required />
          </div>
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? tc("loading") : tc("confirm")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
