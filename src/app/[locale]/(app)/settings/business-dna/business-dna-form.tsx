"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { updateBusinessDnaAction, type BusinessDnaActionState } from "@/actions/business-dna";
import { BUSINESS_DNA_LOCALES, type ExtractedBusinessDNA } from "@/lib/validators/business-dna";
import { DAY_KEYS, type DayKey, type WeekHours } from "@/lib/business-dna/opening-hours";
import {
  mergeExtractedOpeningHours,
  mergeExtractedSupportedLocales,
} from "@/lib/business-dna/merge-extracted";
import {
  applyAutoAcceptedFields,
  classifyExtractedTextFields,
  classifySupportedLocales,
  resolveFieldConflict,
  type FieldClassificationResult,
  type TextFieldClassifications,
} from "@/lib/business-dna/classify-extracted";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { RegenerateFromWebsite } from "./regenerate-from-website";
import { BusinessDnaServices, type BusinessDnaServiceItem } from "./business-dna-services";
import { FieldReviewIndicator } from "./field-review-indicator";

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
  description: string;
  productsServices: string;
  supportedLocales: string[];
  timezone: string;
  brandTone: string;
  communicationStyle: string;
  responseInstructions: string;
  openingHours: WeekHours;
  cancellationPolicy: string;
  bookingPolicy: string;
  refundPolicy: string;
  paymentPolicy: string;
  otherPolicies: string;
  currency: string;
  quoteInstructions: string;
  pricingNotes: string;
  targetCustomer: string;
  keyFacts: string[];
};

type TextFieldValues = {
  displayName: string;
  industry: string;
  description: string;
  brandTone: string;
  communicationStyle: string;
  responseInstructions: string;
  productsServices: string;
  targetCustomer: string;
  timezone: string;
  cancellationPolicy: string;
  bookingPolicy: string;
  refundPolicy: string;
  paymentPolicy: string;
  otherPolicies: string;
  currency: string;
  quoteInstructions: string;
  pricingNotes: string;
  keyFacts: string;
};

function toTextFieldValues(initial: BusinessDnaInitial): TextFieldValues {
  return {
    displayName: initial.displayName,
    industry: initial.industry,
    description: initial.description,
    brandTone: initial.brandTone,
    communicationStyle: initial.communicationStyle,
    responseInstructions: initial.responseInstructions,
    productsServices: initial.productsServices,
    targetCustomer: initial.targetCustomer,
    timezone: initial.timezone,
    cancellationPolicy: initial.cancellationPolicy,
    bookingPolicy: initial.bookingPolicy,
    refundPolicy: initial.refundPolicy,
    paymentPolicy: initial.paymentPolicy,
    otherPolicies: initial.otherPolicies,
    currency: initial.currency,
    quoteInstructions: initial.quoteInstructions,
    pricingNotes: initial.pricingNotes,
    keyFacts: initial.keyFacts.join("\n"),
  };
}

export function BusinessDnaForm({
  initial,
  isNew,
  readOnly,
  updatedAt,
  services,
  canManageServices,
}: {
  initial: BusinessDnaInitial;
  isNew: boolean;
  readOnly: boolean;
  updatedAt: string | null;
  services: BusinessDnaServiceItem[];
  canManageServices: boolean;
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
  const [fieldReview, setFieldReview] = useState<TextFieldClassifications | null>(null);
  const [localeReview, setLocaleReview] = useState<FieldClassificationResult | null>(null);
  const [extractionSourceUrl, setExtractionSourceUrl] = useState<string | null>(null);

  useEffect(() => {
    if (state.message === "saved") {
      setJustSaved(true);
      // A successful save means whatever the reviewer decided is now
      // persisted — stale review indicators from before the save would be
      // confusing to keep showing.
      setFieldReview(null);
      setLocaleReview(null);
    }
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
   * Classifies every field the extraction touches against the current form
   * state (see src/lib/business-dna/classify-extracted.ts) instead of
   * blindly merging. NEW fields (current empty) are safe to auto-apply
   * immediately — there is nothing to lose. CONFLICT fields are NEVER
   * auto-applied: the human must explicitly pick "Keep current" or "Use
   * website value" per field (`resolveFieldConflict` below). Opening hours
   * are deliberately excluded from conflict detection and keep the
   * existing whole-week-replace merge behavior — the existing merge design
   * already treats a partial week extraction as a full replacement (days
   * it doesn't mention fall back to a closed default), which would make
   * almost every extraction register as a false conflict on unmentioned
   * days; see docs/business-dna-mvp.md's "Website extraction review" section
   * for this scoped limitation.
   */
  function handleExtracted(data: ExtractedBusinessDNA, sourceUrl: string) {
    const textClassifications = classifyExtractedTextFields(values, data);
    const localeClassification = classifySupportedLocales(supportedLocales, data.supportedLocales);

    setValues((prev) => applyAutoAcceptedFields(prev, textClassifications));
    if (localeClassification.classification === "NEW") {
      setSupportedLocales((prev) => mergeExtractedSupportedLocales(prev, data));
    }
    setHours((prev) => mergeExtractedOpeningHours(prev, data));

    setFieldReview(textClassifications);
    setLocaleReview(localeClassification.classification === "SAME" ? null : localeClassification);
    setExtractionSourceUrl(sourceUrl);
    setJustRegenerated(true);
    setJustSaved(false);
  }

  /** Called when the user explicitly resolves a single conflicting field — see resolveFieldConflict in classify-extracted.ts for the pure decision logic this wraps. */
  function handleFieldReviewChoice(field: keyof TextFieldValues, useWebsiteValue: boolean) {
    const review = fieldReview?.[field];
    if (review) {
      setValues((prev) => resolveFieldConflict(prev, field, review, useWebsiteValue));
    }
    setFieldReview((prev) =>
      prev ? { ...prev, [field]: { ...prev[field], classification: "SAME" } } : prev,
    );
  }

  function resolveLocaleConflict(useWebsiteValue: boolean) {
    if (useWebsiteValue && localeReview?.extracted) {
      setSupportedLocales(localeReview.extracted.split(", ").filter(Boolean));
    }
    setLocaleReview(null);
  }

  /** One indicator call site per field, reusing the same classification map and handlers. */
  function fieldReviewFor(field: keyof TextFieldValues, fieldLabel: string) {
    return (
      <FieldReviewIndicator
        classification={fieldReview?.[field]?.classification}
        fieldLabel={fieldLabel}
        currentValue={values[field]}
        extractedValue={fieldReview?.[field]?.extracted ?? null}
        sourceUrl={extractionSourceUrl}
        onKeepCurrent={() => handleFieldReviewChoice(field, false)}
        onUseWebsite={() => handleFieldReviewChoice(field, true)}
      />
    );
  }

  return (
    // The Services section below renders its own <form> elements (add/edit/
    // deactivate each submit independently). HTML forbids nested <form>s --
    // browsers silently drop an inner one, which would make Services'
    // buttons submit this outer profile form instead. `<form className=
    // "contents">` keeps the whole profile as ONE atomic submit (all fields
    // below still post together) while giving up its own box, so its
    // order-N children lay out as direct flex items of this wrapper and
    // Services (a true DOM sibling of the form, not a descendant) can sit
    // between them via CSS order without ever being nested inside it.
    <div className="flex flex-col space-y-6">
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
          onExtracted={(data, sourceUrl) => {
            handleExtracted(data, sourceUrl);
          }}
        />
      )}
      {justRegenerated ? (
        <p className="text-sm text-primary">{t("regenerate.appliedMessage")}</p>
      ) : null}

      <form id="business-dna-form" action={action} className="contents">
        {/* 1. Company */}
        <div className="order-1">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("sections.identity")}</CardTitle>
              <CardDescription>{t("sections.identityDescription")}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <fieldset disabled={readOnly} className="space-y-4">
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
                    {fieldReviewFor("displayName", t("fields.displayName"))}
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
                    {fieldReviewFor("industry", t("fields.industry"))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="description">{t("fields.description")}</Label>
                  <textarea
                    id="description"
                    name="description"
                    value={values.description}
                    onChange={(e) => setField("description", e.target.value)}
                    rows={2}
                    maxLength={1000}
                    placeholder={t("placeholders.description")}
                    className={TEXTAREA_CLASS}
                  />
                  {fieldReviewFor("description", t("fields.description"))}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label>{t("fields.supportedLocales")}</Label>
                    <div className="flex flex-wrap gap-4 pt-2">
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
                    <FieldReviewIndicator
                      classification={localeReview?.classification}
                      fieldLabel={t("fields.supportedLocales")}
                      currentValue={localeReview?.current ?? ""}
                      extractedValue={localeReview?.extracted ?? null}
                      sourceUrl={extractionSourceUrl}
                      onKeepCurrent={() => resolveLocaleConflict(false)}
                      onUseWebsite={() => resolveLocaleConflict(true)}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="timezone">{t("fields.timezone")}</Label>
                    <Input
                      id="timezone"
                      name="timezone"
                      value={values.timezone}
                      onChange={(e) => setField("timezone", e.target.value)}
                      maxLength={100}
                      placeholder={t("placeholders.timezone")}
                    />
                    {fieldReviewFor("timezone", t("fields.timezone"))}
                  </div>
                </div>
              </fieldset>
            </CardContent>
          </Card>
        </div>

        {/* 3. Communication */}
        <div className="order-3">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("sections.communication")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <fieldset disabled={readOnly} className="space-y-4">
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
                    {fieldReviewFor("brandTone", t("fields.brandTone"))}
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
                    {fieldReviewFor("communicationStyle", t("fields.communicationStyle"))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="responseInstructions">{t("fields.responseInstructions")}</Label>
                  <textarea
                    id="responseInstructions"
                    name="responseInstructions"
                    value={values.responseInstructions}
                    onChange={(e) => setField("responseInstructions", e.target.value)}
                    rows={2}
                    maxLength={2000}
                    placeholder={t("placeholders.responseInstructions")}
                    className={TEXTAREA_CLASS}
                  />
                  {fieldReviewFor("responseInstructions", t("fields.responseInstructions"))}
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
                  {fieldReviewFor("targetCustomer", t("fields.targetCustomer"))}
                </div>
              </fieldset>
            </CardContent>
          </Card>
        </div>

        {/* 4. Hours */}
        <div className="order-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("sections.openingHours")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <fieldset disabled={readOnly} className="space-y-2">
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
                <p className="pt-1 text-xs text-muted-foreground">{t("hoursTimezoneHint")}</p>
              </fieldset>
            </CardContent>
          </Card>
        </div>

        {/* 5. Policies */}
        <div className="order-5">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("sections.policies")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <fieldset disabled={readOnly} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="cancellationPolicy">{t("fields.cancellationPolicy")}</Label>
                    <textarea
                      id="cancellationPolicy"
                      name="cancellationPolicy"
                      value={values.cancellationPolicy}
                      onChange={(e) => setField("cancellationPolicy", e.target.value)}
                      rows={2}
                      maxLength={2000}
                      className={TEXTAREA_CLASS}
                    />
                    {fieldReviewFor("cancellationPolicy", t("fields.cancellationPolicy"))}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="bookingPolicy">{t("fields.bookingPolicy")}</Label>
                    <textarea
                      id="bookingPolicy"
                      name="bookingPolicy"
                      value={values.bookingPolicy}
                      onChange={(e) => setField("bookingPolicy", e.target.value)}
                      rows={2}
                      maxLength={2000}
                      className={TEXTAREA_CLASS}
                    />
                    {fieldReviewFor("bookingPolicy", t("fields.bookingPolicy"))}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="refundPolicy">{t("fields.refundPolicy")}</Label>
                    <textarea
                      id="refundPolicy"
                      name="refundPolicy"
                      value={values.refundPolicy}
                      onChange={(e) => setField("refundPolicy", e.target.value)}
                      rows={2}
                      maxLength={2000}
                      className={TEXTAREA_CLASS}
                    />
                    {fieldReviewFor("refundPolicy", t("fields.refundPolicy"))}
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="paymentPolicy">{t("fields.paymentPolicy")}</Label>
                    <textarea
                      id="paymentPolicy"
                      name="paymentPolicy"
                      value={values.paymentPolicy}
                      onChange={(e) => setField("paymentPolicy", e.target.value)}
                      rows={2}
                      maxLength={2000}
                      className={TEXTAREA_CLASS}
                    />
                    {fieldReviewFor("paymentPolicy", t("fields.paymentPolicy"))}
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="otherPolicies">{t("fields.otherPolicies")}</Label>
                  <textarea
                    id="otherPolicies"
                    name="otherPolicies"
                    value={values.otherPolicies}
                    onChange={(e) => setField("otherPolicies", e.target.value)}
                    rows={3}
                    maxLength={4000}
                    placeholder={t("placeholders.otherPolicies")}
                    className={TEXTAREA_CLASS}
                  />
                  {fieldReviewFor("otherPolicies", t("fields.otherPolicies"))}
                </div>
              </fieldset>
            </CardContent>
          </Card>
        </div>

        {/* 6. Pricing / Quotes */}
        <div className="order-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("sections.pricingAndQuotes")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <fieldset disabled={readOnly} className="space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label htmlFor="currency">{t("fields.currency")}</Label>
                    <Input
                      id="currency"
                      name="currency"
                      value={values.currency}
                      onChange={(e) => setField("currency", e.target.value.toUpperCase())}
                      maxLength={3}
                      placeholder={t("placeholders.currency")}
                    />
                    {fieldReviewFor("currency", t("fields.currency"))}
                  </div>
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
                  {fieldReviewFor("pricingNotes", t("fields.pricingNotes"))}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="quoteInstructions">{t("fields.quoteInstructions")}</Label>
                  <textarea
                    id="quoteInstructions"
                    name="quoteInstructions"
                    value={values.quoteInstructions}
                    onChange={(e) => setField("quoteInstructions", e.target.value)}
                    rows={2}
                    maxLength={2000}
                    placeholder={t("placeholders.quoteInstructions")}
                    className={TEXTAREA_CLASS}
                  />
                  {fieldReviewFor("quoteInstructions", t("fields.quoteInstructions"))}
                </div>
              </fieldset>
            </CardContent>
          </Card>
        </div>

        {/* 7. Key facts */}
        <div className="order-7">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">{t("sections.keyFacts")}</CardTitle>
            </CardHeader>
            <CardContent>
              <fieldset disabled={readOnly}>
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
                {fieldReviewFor("keyFacts", t("fields.keyFacts"))}
              </fieldset>
            </CardContent>
          </Card>
        </div>

        {readOnly ? null : (
          <div className="order-8 flex items-center gap-3">
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

      {/* 2. Services — deliberately a sibling of the profile <form> above,
          not a descendant: it renders its own independent <form>s for
          add/edit/deactivate, and CSS `order` (not DOM position) places it
          between Company and Communication. */}
      <div className="order-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("sections.services")}</CardTitle>
            <CardDescription>{t("sections.servicesDescription")}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {isNew ? (
              <p className="text-sm text-muted-foreground">{t("services.saveProfileFirst")}</p>
            ) : (
              <BusinessDnaServices
                services={services}
                currency={values.currency}
                readOnly={!canManageServices}
              />
            )}
            <div className="space-y-1.5">
              <Label htmlFor="productsServices">{t("fields.productsServices")}</Label>
              {/* This field lives in the Services card (a DOM sibling of
                  the profile <form>, per the nesting note above) but must
                  still submit as part of that one form. The `form=""`
                  attribute is the standard HTML mechanism for associating a
                  field with a form it isn't a descendant of. */}
              <textarea
                id="productsServices"
                name="productsServices"
                form="business-dna-form"
                disabled={readOnly}
                value={values.productsServices}
                onChange={(e) => setField("productsServices", e.target.value)}
                rows={3}
                maxLength={4000}
                placeholder={t("placeholders.productsServices")}
                className={TEXTAREA_CLASS}
              />
              {fieldReviewFor("productsServices", t("fields.productsServices"))}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
