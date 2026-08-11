"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { updateBusinessDnaAction, type BusinessDnaActionState } from "@/actions/business-dna";
import { BUSINESS_DNA_LOCALES, type ExtractedBusinessDNA } from "@/lib/validators/business-dna";
import { DAY_KEYS, type DayKey, type WeekHours } from "@/lib/business-dna/opening-hours";
import {
  mergeExtractedOpeningHours,
  mergeExtractedSupportedLocales,
  mergeExtractedTextFields,
} from "@/lib/business-dna/merge-extracted";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RegenerateFromWebsite } from "./regenerate-from-website";

const TEXTAREA_CLASS =
  "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50";

const LOCALE_LABELS: Record<(typeof BUSINESS_DNA_LOCALES)[number], string> = {
  FI: "Suomi",
  EN: "English",
  AR: "العربية",
};

export type BusinessDnaInitial = {
  displayName: string;
  industry: string;
  productsServices: string;
  supportedLocales: string[];
  brandTone: string;
  communicationStyle: string;
  openingHours: WeekHours;
  policies: string;
  pricingNotes: string;
  targetCustomer: string;
  keyFacts: string[];
};

type TextFieldValues = {
  displayName: string;
  industry: string;
  brandTone: string;
  communicationStyle: string;
  productsServices: string;
  targetCustomer: string;
  policies: string;
  pricingNotes: string;
  keyFacts: string;
};

function toTextFieldValues(initial: BusinessDnaInitial): TextFieldValues {
  return {
    displayName: initial.displayName,
    industry: initial.industry,
    brandTone: initial.brandTone,
    communicationStyle: initial.communicationStyle,
    productsServices: initial.productsServices,
    targetCustomer: initial.targetCustomer,
    policies: initial.policies,
    pricingNotes: initial.pricingNotes,
    keyFacts: initial.keyFacts.join("\n"),
  };
}

export function BusinessDnaForm({
  initial,
  isNew,
  readOnly,
  updatedAt,
}: {
  initial: BusinessDnaInitial;
  isNew: boolean;
  readOnly: boolean;
  updatedAt: string | null;
}) {
  const t = useTranslations("businessDna");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<BusinessDnaActionState, FormData>(
    updateBusinessDnaAction,
    {},
  );
  const [values, setValues] = useState<TextFieldValues>(() => toTextFieldValues(initial));
  const [supportedLocales, setSupportedLocales] = useState<string[]>(initial.supportedLocales);
  const [hours, setHours] = useState<WeekHours>(initial.openingHours);
  const [justSaved, setJustSaved] = useState(false);
  const [justRegenerated, setJustRegenerated] = useState(false);

  useEffect(() => {
    if (state.message === "saved") setJustSaved(true);
  }, [state.message]);

  function setDay(day: DayKey, patch: Partial<WeekHours[DayKey]>) {
    setHours((prev) => ({ ...prev, [day]: { ...prev[day], ...patch } }));
  }

  function setField(field: keyof TextFieldValues, value: string) {
    setValues((prev) => ({ ...prev, [field]: value }));
  }

  function toggleLocale(locale: string, checked: boolean) {
    setSupportedLocales((prev) => (checked ? [...prev, locale] : prev.filter((l) => l !== locale)));
  }

  /**
   * Merges only the fields the extraction actually returned — every field
   * is optional in `ExtractedBusinessDNA` (a scrape may only surface a
   * handful of facts), so anything absent leaves the human-edited value
   * untouched rather than being cleared.
   */
  function handleExtracted(data: ExtractedBusinessDNA) {
    setValues((prev) => mergeExtractedTextFields(prev, data));
    setSupportedLocales((prev) => mergeExtractedSupportedLocales(prev, data));
    setHours((prev) => mergeExtractedOpeningHours(prev, data));
    setJustRegenerated(true);
    setJustSaved(false);
  }

  return (
    <form action={action} className="space-y-6">
      {isNew && !justSaved ? (
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {t("emptyBanner")}
        </div>
      ) : !justSaved && updatedAt ? (
        <p className="text-xs text-muted-foreground">
          {t("updated", { date: new Date(updatedAt).toLocaleDateString() })}
        </p>
      ) : null}

      {readOnly ? null : (
        <RegenerateFromWebsite
          onExtracted={(data) => {
            handleExtracted(data);
          }}
        />
      )}
      {justRegenerated ? (
        <p className="text-sm text-primary">{t("regenerate.appliedMessage")}</p>
      ) : null}

      <fieldset disabled={readOnly} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("sections.identity")}</CardTitle>
            <CardDescription>{t("sections.identityDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="displayName">{t("fields.displayName")}</Label>
                <Input
                  id="displayName"
                  name="displayName"
                  value={values.displayName}
                  onChange={(e) => setField("displayName", e.target.value)}
                  maxLength={200}
                  placeholder={t("placeholders.displayName")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="industry">{t("fields.industry")}</Label>
                <Input
                  id="industry"
                  name="industry"
                  value={values.industry}
                  onChange={(e) => setField("industry", e.target.value)}
                  maxLength={120}
                  placeholder={t("placeholders.industry")}
                />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="brandTone">{t("fields.brandTone")}</Label>
                <Input
                  id="brandTone"
                  name="brandTone"
                  value={values.brandTone}
                  onChange={(e) => setField("brandTone", e.target.value)}
                  maxLength={200}
                  placeholder={t("placeholders.brandTone")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="communicationStyle">{t("fields.communicationStyle")}</Label>
                <Input
                  id="communicationStyle"
                  name="communicationStyle"
                  value={values.communicationStyle}
                  onChange={(e) => setField("communicationStyle", e.target.value)}
                  maxLength={200}
                  placeholder={t("placeholders.communicationStyle")}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>{t("fields.supportedLocales")}</Label>
              <div className="flex flex-wrap gap-4">
                {BUSINESS_DNA_LOCALES.map((locale) => (
                  <label key={locale} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="supportedLocales"
                      value={locale}
                      checked={supportedLocales.includes(locale)}
                      onChange={(e) => toggleLocale(locale, e.target.checked)}
                      className="size-4 rounded border-input"
                    />
                    {LOCALE_LABELS[locale]}
                  </label>
                ))}
              </div>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("sections.productsAndCustomers")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="productsServices">{t("fields.productsServices")}</Label>
              <textarea
                id="productsServices"
                name="productsServices"
                value={values.productsServices}
                onChange={(e) => setField("productsServices", e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder={t("placeholders.productsServices")}
                className={TEXTAREA_CLASS}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="targetCustomer">{t("fields.targetCustomer")}</Label>
              <textarea
                id="targetCustomer"
                name="targetCustomer"
                value={values.targetCustomer}
                onChange={(e) => setField("targetCustomer", e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder={t("placeholders.targetCustomer")}
                className={TEXTAREA_CLASS}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("sections.openingHours")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {DAY_KEYS.map((day) => {
              const dayLabel = t(`weekdays.${day}`);
              return (
                <div key={day} className="flex flex-wrap items-center gap-3 text-sm">
                  <span className="w-24 shrink-0">{dayLabel}</span>
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={hours[day].closed}
                      onChange={(e) => setDay(day, { closed: e.target.checked })}
                      className="size-4 rounded border-input"
                    />
                    {t("closed")}
                  </label>
                  {!hours[day].closed ? (
                    <>
                      <input
                        type="time"
                        value={hours[day].open}
                        onChange={(e) => setDay(day, { open: e.target.value })}
                        aria-label={t("openTimeLabel", { day: dayLabel })}
                        className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                      />
                      <span aria-hidden="true">–</span>
                      <input
                        type="time"
                        value={hours[day].close}
                        onChange={(e) => setDay(day, { close: e.target.value })}
                        aria-label={t("closeTimeLabel", { day: dayLabel })}
                        className="h-8 rounded-md border border-input bg-transparent px-2 text-sm"
                      />
                    </>
                  ) : null}
                </div>
              );
            })}
            <input type="hidden" name="openingHours" value={JSON.stringify(hours)} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("sections.policiesAndPricing")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="policies">{t("fields.policies")}</Label>
              <textarea
                id="policies"
                name="policies"
                value={values.policies}
                onChange={(e) => setField("policies", e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder={t("placeholders.policies")}
                className={TEXTAREA_CLASS}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="pricingNotes">{t("fields.pricingNotes")}</Label>
              <textarea
                id="pricingNotes"
                name="pricingNotes"
                value={values.pricingNotes}
                onChange={(e) => setField("pricingNotes", e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder={t("placeholders.pricingNotes")}
                className={TEXTAREA_CLASS}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("sections.keyFacts")}</CardTitle>
          </CardHeader>
          <CardContent>
            <textarea
              id="keyFacts"
              name="keyFacts"
              value={values.keyFacts}
              onChange={(e) => setField("keyFacts", e.target.value)}
              rows={5}
              maxLength={6000}
              placeholder={t("placeholders.keyFacts")}
              className={TEXTAREA_CLASS}
            />
          </CardContent>
        </Card>
      </fieldset>

      {readOnly ? null : (
        <div className="flex items-center gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? tc("loading") : tc("save")}
          </Button>
          {justSaved && state.message === "saved" ? (
            <p className="text-sm text-success">{t("savedMessage")}</p>
          ) : null}
          {state.error === "invalid_input" ? (
            <p className="text-sm text-destructive">{t("invalidInput")}</p>
          ) : null}
          {state.error === "failed" ? (
            <p className="text-sm text-destructive">{t("saveFailed")}</p>
          ) : null}
        </div>
      )}
    </form>
  );
}
