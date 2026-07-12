"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Pencil, Plus } from "lucide-react";
import { createDealAction, updateDealAction, type DealActionState } from "@/actions/deals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { DEAL_CURRENCIES } from "@/lib/validators/crm";

export type Option = { id: string; name: string };

export type StageOption = { id: string; name: string };

export type DealFormValues = {
  id: string;
  title: string;
  valueCents: number;
  currency: string;
  probability: number | null;
  contactId: string | null;
  companyId: string | null;
  ownerId: string | null;
  stageId: string;
  expectedCloseAt: string | null;
};

const selectClass = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm";

export function DealDialog({
  mode,
  deal,
  stages,
  contacts,
  companies,
  owners,
}: {
  mode: "create" | "edit";
  deal?: DealFormValues;
  stages: StageOption[];
  contacts: Option[];
  companies: Option[];
  owners: Option[];
}) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const isEdit = mode === "edit" && deal !== undefined;
  const [value, setValue] = useState(isEdit ? (deal.valueCents / 100).toString() : "");

  const [state, action, pending] = useActionState<DealActionState, FormData>(
    isEdit ? updateDealAction.bind(null, deal.id) : createDealAction,
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
        {t("newDeal")}
      </Button>
    );
  }

  const valueCents = Math.round((Number.parseFloat(value.replace(",", ".")) || 0) * 100);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && setOpen(false)}
      role="dialog"
      aria-modal="true"
    >
      <Card className="max-h-full w-full max-w-md overflow-y-auto">
        <CardHeader>
          <CardTitle>{isEdit ? t("editDeal") : t("newDeal")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-3">
            <input type="hidden" name="valueCents" value={valueCents} />
            <div className="space-y-1.5">
              <Label htmlFor="title">{t("dealFields.title")}</Label>
              <Input id="title" name="title" required defaultValue={deal?.title ?? ""} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="dealValue">{t("dealFields.value")}</Label>
                <Input
                  id="dealValue"
                  inputMode="decimal"
                  min="0"
                  step="0.01"
                  type="number"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="currency">{t("dealFields.currency")}</Label>
                <select
                  id="currency"
                  name="currency"
                  defaultValue={deal?.currency ?? "EUR"}
                  className={selectClass}
                >
                  {DEAL_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="stageId">{t("dealFields.stage")}</Label>
                <select
                  id="stageId"
                  name="stageId"
                  required
                  defaultValue={deal?.stageId ?? stages[0]?.id ?? ""}
                  className={selectClass}
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="probability">{t("dealFields.probability")}</Label>
                <Input
                  id="probability"
                  name="probability"
                  type="number"
                  min="0"
                  max="100"
                  placeholder={t("probabilityFromStage")}
                  defaultValue={deal?.probability ?? ""}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="contactId">{t("fields.contact")}</Label>
                <select
                  id="contactId"
                  name="contactId"
                  defaultValue={deal?.contactId ?? ""}
                  className={selectClass}
                >
                  <option value="">{t("noContact")}</option>
                  {contacts.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="companyId">{t("fields.company")}</Label>
                <select
                  id="companyId"
                  name="companyId"
                  defaultValue={deal?.companyId ?? ""}
                  className={selectClass}
                >
                  <option value="">{t("noCompany")}</option>
                  {companies.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="ownerId">{t("dealFields.owner")}</Label>
                <select
                  id="ownerId"
                  name="ownerId"
                  defaultValue={deal?.ownerId ?? ""}
                  className={selectClass}
                >
                  <option value="">{t("meAsOwner")}</option>
                  {owners.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="expectedCloseAt">{t("dealFields.expectedClose")}</Label>
                <Input
                  id="expectedCloseAt"
                  name="expectedCloseAt"
                  type="date"
                  defaultValue={deal?.expectedCloseAt ?? ""}
                />
              </div>
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
