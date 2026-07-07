"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { createContactAction, type CrmActionState } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export function NewContactDialog() {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<CrmActionState, FormData>(
    createContactAction,
    {},
  );

  useEffect(() => {
    if (state.message === "created") setOpen(false);
  }, [state.message]);

  if (!open) {
    return (
      <Button onClick={() => setOpen(true)} className="gap-2">
        <Plus className="size-4" />
        {t("newContact")}
      </Button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && setOpen(false)}
      role="dialog"
      aria-modal="true"
    >
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t("newContact")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="firstName">{t("fields.firstName")}</Label>
                <Input id="firstName" name="firstName" required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lastName">{t("fields.lastName")}</Label>
                <Input id="lastName" name="lastName" />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">{t("fields.email")}</Label>
              <Input id="email" name="email" type="email" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="phone">{t("fields.phone")}</Label>
                <Input id="phone" name="phone" type="tel" />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="status">{t("fields.status")}</Label>
                <select
                  id="status"
                  name="status"
                  defaultValue="LEAD"
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  {["LEAD", "PROSPECT", "CUSTOMER"].map((s) => (
                    <option key={s} value={s}>
                      {t(`statuses.${s}` as never)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="gdprConsent" value="true" className="size-4" />
              {t("gdprConsent")}
            </label>
            {state.error ? (
              <p role="alert" className="text-sm text-destructive">
                {state.error === "quota" ? t("quotaContacts") : tc("error")}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {tc("cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? tc("loading") : tc("create")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
