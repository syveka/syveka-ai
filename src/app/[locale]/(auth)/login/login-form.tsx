"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { loginAction, type AuthActionState } from "@/actions/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/routing";

export function LoginForm() {
  const t = useTranslations("auth");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<AuthActionState, FormData>(loginAction, {});

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-2xl">{t("login")}</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={action} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">{t("email")}</Label>
            <Input id="email" name="email" type="email" autoComplete="email" required />
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">{t("password")}</Label>
              <Link href="/forgot-password" className="text-sm text-primary hover:underline">
                {t("forgotPassword")}
              </Link>
            </div>
            <Input
              id="password"
              name="password"
              type="password"
              autoComplete="current-password"
              required
            />
          </div>
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {tc("error")}
            </p>
          ) : null}
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? tc("loading") : t("login")}
          </Button>
          <p className="text-center text-sm text-muted-foreground">
            {t("noAccount")}{" "}
            <Link href="/register" className="text-primary hover:underline">
              {t("register")}
            </Link>
          </p>
        </form>
      </CardContent>
    </Card>
  );
}
