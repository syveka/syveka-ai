"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Pencil, Plus } from "lucide-react";
import { createCompanyAction, updateCompanyAction } from "@/actions/companies";
import type { CrmActionState } from "@/actions/contacts";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type CompanyFormValues = {
  id: string;
  name: string;
  domain: string | null;
  industry: string | null;
  size: string | null;
  website: string | null;
  businessId: string | null;
};

export function CompanyDialog({
  mode,
  company,
}: {
  mode: "create" | "edit";
  company?: CompanyFormValues;
}) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const isEdit = mode === "edit" && company !== undefined;

  const [state, action, pending] = useActionState<CrmActionState, FormData>(
    isEdit ? updateCompanyAction.bind(null, company.id) : createCompanyAction,
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
        {t("newCompany")}
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
          <CardTitle>{isEdit ? t("editCompany") : t("newCompany")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="name">{t("companyFields.name")}</Label>
              <Input id="name" name="name" required defaultValue={company?.name ?? ""} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="domain">{t("companyFields.domain")}</Label>
                <Input
                  id="domain"
                  name="domain"
                  placeholder="example.com"
                  defaultValue={company?.domain ?? ""}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="website">{t("companyFields.website")}</Label>
                <Input
                  id="website"
                  name="website"
                  type="url"
                  placeholder="https://example.com"
                  defaultValue={company?.website ?? ""}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="industry">{t("companyFields.industry")}</Label>
                <Input id="industry" name="industry" defaultValue={company?.industry ?? ""} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="size">{t("companyFields.size")}</Label>
                <Input
                  id="size"
                  name="size"
                  placeholder="10-49"
                  defaultValue={company?.size ?? ""}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="businessId">{t("companyFields.businessId")}</Label>
              <Input id="businessId" name="businessId" defaultValue={company?.businessId ?? ""} />
            </div>
            {state.error ? (
              <p role="alert" className="text-sm text-destructive">
                {state.error === "invalid_input" ? t("invalidInput") : tc("error")}
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
