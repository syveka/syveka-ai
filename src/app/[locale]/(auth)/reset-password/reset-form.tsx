"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { resetPasswordAction, type AuthActionState } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function ResetPasswordForm() {
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<AuthActionState, FormData>(
    resetPasswordAction,
    {},
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{t("password")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">{t("password")}</Label>
            <Input id="password" name="password" type="password" minLength={12} autoComplete="new-password" required />
          </div>
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">{tc("error")}</p>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? tc("loading") : tc("save")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
