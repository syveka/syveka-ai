"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import {
  createBusinessDnaServiceAction,
  deactivateBusinessDnaServiceAction,
  reactivateBusinessDnaServiceAction,
  updateBusinessDnaServiceAction,
  type BusinessDnaServiceActionState,
} from "@/actions/business-dna-services";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type BusinessDnaServiceItem = {
  id: string;
  name: string;
  description: string | null;
  priceCents: number | null;
  priceNote: string | null;
  durationMinutes: number | null;
  isActive: boolean;
};

type FormValues = {
  name: string;
  description: string;
  price: string;
  priceNote: string;
  durationMinutes: string;
  isActive: boolean;
};

const EMPTY_FORM: FormValues = {
  name: "",
  description: "",
  price: "",
  priceNote: "",
  durationMinutes: "",
  isActive: true,
};

function formatPrice(service: BusinessDnaServiceItem, currency: string): string {
  const amount = service.priceCents != null ? (service.priceCents / 100).toFixed(2) : null;
  if (amount && service.priceNote) return `${amount} ${currency} (${service.priceNote})`;
  if (amount) return `${amount} ${currency}`;
  if (service.priceNote) return service.priceNote;
  return "—";
}

function ServiceForm({
  editing,
  initial,
  onDone,
}: {
  editing: string | null;
  initial: FormValues;
  onDone: () => void;
}) {
  const t = useTranslations("businessDna");
  const action = editing
    ? updateBusinessDnaServiceAction.bind(null, editing)
    : createBusinessDnaServiceAction;
  const [state, formAction, pending] = useActionState<BusinessDnaServiceActionState, FormData>(
    action,
    {},
  );
  const [values, setValues] = useState<FormValues>(initial);

  useEffect(() => {
    setValues(initial);
  }, [initial]);

  useEffect(() => {
    if (state.message === "created" || state.message === "saved") onDone();
  }, [state.message, onDone]);

  function setField<K extends keyof FormValues>(field: K, value: FormValues[K]) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  return (
    <form action={formAction} className="space-y-3 rounded-md border p-4">
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="service-name">{t("services.fields.name")}</Label>
          <Input
            id="service-name"
            name="name"
            value={values.name}
            onChange={(e) => setField("name", e.target.value)}
            maxLength={200}
            required
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="service-duration">{t("services.fields.duration")}</Label>
          <Input
            id="service-duration"
            name="durationMinutes"
            type="number"
            min={0}
            value={values.durationMinutes}
            onChange={(e) => setField("durationMinutes", e.target.value)}
            placeholder={t("services.placeholders.duration")}
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="service-price">{t("services.fields.price")}</Label>
          <Input
            id="service-price"
            name="price"
            type="number"
            min={0}
            step="0.01"
            value={values.price}
            onChange={(e) => setField("price", e.target.value)}
            placeholder={t("services.placeholders.price")}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="service-price-note">{t("services.fields.priceNote")}</Label>
          <Input
            id="service-price-note"
            name="priceNote"
            value={values.priceNote}
            onChange={(e) => setField("priceNote", e.target.value)}
            maxLength={200}
            placeholder={t("services.placeholders.priceNote")}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="service-description">{t("services.fields.description")}</Label>
        <Input
          id="service-description"
          name="description"
          value={values.description}
          onChange={(e) => setField("description", e.target.value)}
          maxLength={2000}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="isActive"
          checked={values.isActive}
          onChange={(e) => setField("isActive", e.target.checked)}
          className="size-4 rounded border-input"
        />
        {t("services.fields.active")}
      </label>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={pending}>
          {pending ? t("services.saving") : editing ? t("services.saveEdit") : t("services.add")}
        </Button>
        {editing ? (
          <Button type="button" size="sm" variant="ghost" onClick={onDone}>
            {t("services.cancel")}
          </Button>
        ) : null}
        {state.error ? <p className="text-sm text-destructive">{t("invalidInput")}</p> : null}
      </div>
    </form>
  );
}

export function BusinessDnaServices({
  services,
  currency,
  readOnly,
}: {
  services: BusinessDnaServiceItem[];
  currency: string;
  readOnly: boolean;
}) {
  const t = useTranslations("businessDna");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const editingService = services.find((s) => s.id === editingId) ?? null;

  return (
    <div className="space-y-4">
      {services.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("services.empty")}</p>
      ) : (
        <ul className="divide-y rounded-md border">
          {services.map((service) => (
            <li key={service.id} className="flex items-center justify-between gap-3 p-3 text-sm">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-medium">
                  {service.name}
                  {!service.isActive ? (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                      {t("services.inactive")}
                    </span>
                  ) : null}
                </p>
                <p className="text-muted-foreground">
                  {formatPrice(service, currency || t("services.defaultCurrencyLabel"))}
                  {service.durationMinutes != null
                    ? ` · ${t("services.durationSuffix", { minutes: service.durationMinutes })}`
                    : ""}
                </p>
              </div>
              {readOnly ? null : (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setAdding(false);
                      setEditingId(service.id);
                    }}
                  >
                    {t("services.edit")}
                  </Button>
                  <form
                    action={
                      service.isActive
                        ? deactivateBusinessDnaServiceAction.bind(null, service.id)
                        : reactivateBusinessDnaServiceAction.bind(null, service.id)
                    }
                  >
                    <Button type="submit" size="sm" variant="ghost">
                      {service.isActive ? t("services.deactivate") : t("services.reactivate")}
                    </Button>
                  </form>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {readOnly ? null : editingService ? (
        <ServiceForm
          editing={editingService.id}
          initial={{
            name: editingService.name,
            description: editingService.description ?? "",
            price:
              editingService.priceCents != null ? (editingService.priceCents / 100).toFixed(2) : "",
            priceNote: editingService.priceNote ?? "",
            durationMinutes: editingService.durationMinutes?.toString() ?? "",
            isActive: editingService.isActive,
          }}
          onDone={() => setEditingId(null)}
        />
      ) : adding ? (
        <ServiceForm editing={null} initial={EMPTY_FORM} onDone={() => setAdding(false)} />
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setAdding(true)}>
          {t("services.add")}
        </Button>
      )}
    </div>
  );
}
