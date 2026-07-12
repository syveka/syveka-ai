"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Pencil, Plus } from "lucide-react";
import { createContactAction, updateContactAction, type CrmActionState } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

const STATUS_OPTIONS = ["LEAD", "PROSPECT", "CUSTOMER", "CHURNED"] as const;

export type CompanyOption = { id: string; name: string };

export type ContactFormValues = {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
  companyId: string | null;
  status: string;
};

export function ContactDialog({
  mode,
  contact,
  companies,
}: {
  mode: "create" | "edit";
  contact?: ContactFormValues;
  companies: CompanyOption[];
}) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const isEdit = mode === "edit" && contact !== undefined;

  const [state, action, pending] = useActionState<CrmActionState, FormData>(
    isEdit ? updateContactAction.bind(null, contact.id) : createContactAction,
    {},
  );

  useEffect(() => {
    if (state.message === "created" || state.message === "updated") setOpen(false);
  }, [state.message]);

  if (!open) {
    return isEdit ? (
      <Button variant="outline" onClick={() => setOpen(true)} className="gap-2">
        <Pencil className="size-4" />
        {tc("edit")}
      </Button>
    ) : (
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
      <Card className="max-h-full w-full max-w-md overflow-y-auto">
        <CardHeader>
          <CardTitle>{isEdit ? t("editContact") : t("newContact")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="firstName">{t("fields.firstName")}</Label>
                <Input
                  id="firstName"
                  name="firstName"
                  required
                  defaultValue={contact?.firstName ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="lastName">{t("fields.lastName")}</Label>
                <Input id="lastName" name="lastName" defaultValue={contact?.lastName ?? ""} />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="email">{t("fields.email")}</Label>
              <Input id="email" name="email" type="email" defaultValue={contact?.email ?? ""} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="phone">{t("fields.phone")}</Label>
                <Input id="phone" name="phone" type="tel" defaultValue={contact?.phone ?? ""} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="title">{t("fields.title")}</Label>
                <Input id="title" name="title" defaultValue={contact?.title ?? ""} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="companyId">{t("fields.company")}</Label>
                <select
                  id="companyId"
                  name="companyId"
                  defaultValue={contact?.companyId ?? ""}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  <option value="">{t("noCompany")}</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="status">{t("fields.status")}</Label>
                <select
                  id="status"
                  name="status"
                  defaultValue={contact?.status ?? "LEAD"}
                  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {t(`statuses.${s}` as never)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            {isEdit ? null : (
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="gdprConsent" value="true" className="size-4" />
                {t("gdprConsent")}
              </label>
            )}
            {state.error ? (
              <p role="alert" className="text-sm text-destructive">
                {state.error === "quota"
                  ? t("quotaContacts")
                  : state.error === "invalid_input"
                    ? t("invalidInput")
                    : tc("error")}
              </p>
            ) : null}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
                {tc("cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? tc("loading") : isEdit ? tc("save") : tc("create")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
