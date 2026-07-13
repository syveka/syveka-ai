"use client";

import { useActionState, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Copy, Pencil, Plus } from "lucide-react";
import {
  saveBookingTypeAction,
  deleteBookingTypeAction,
  type BookingTypeActionState,
} from "@/actions/booking-types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type BookingTypeData = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  durationMinutes: number;
  durationOptions: number[];
  locationType: string;
  location: string | null;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
  maxWindowDays: number;
  brandColor: string | null;
  confirmationMessage: string | null;
  collectPhone: boolean;
  collectCompany: boolean;
  requiresConsent: boolean;
  isActive: boolean;
  scheduleId: string | null;
};

export function BookingTypesManager({
  types,
  schedules,
  baseUrl,
}: {
  types: BookingTypeData[];
  schedules: Array<{ id: string; name: string }>;
  baseUrl: string;
}) {
  const t = useTranslations("calendar");
  const [editing, setEditing] = useState<BookingTypeData | "new" | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button onClick={() => setEditing("new")}>
          <Plus className="me-1.5 size-4" />
          {t("bookingTypes.new")}
        </Button>
      </div>

      {types.length === 0 ? (
        <p className="rounded-lg border p-6 text-center text-sm text-muted-foreground">
          {t("bookingTypes.empty")}
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {types.map((bt) => (
            <Card key={bt.id}>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center justify-between text-base">
                  <span className="truncate">{bt.name}</span>
                  {!bt.isActive ? (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-normal text-muted-foreground">
                      {t("bookingTypes.inactive")}
                    </span>
                  ) : null}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                <p className="text-muted-foreground">
                  {bt.durationMinutes} min ·{" "}
                  {t(
                    `bookingTypes.locations.${bt.locationType}` as
                      | "bookingTypes.locations.VIDEO"
                      | "bookingTypes.locations.PHONE"
                      | "bookingTypes.locations.IN_PERSON"
                      | "bookingTypes.locations.CUSTOM",
                  )}
                </p>
                <p className="truncate font-mono text-xs text-muted-foreground">
                  {baseUrl}/{bt.slug}
                </p>
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      void navigator.clipboard.writeText(`${baseUrl}/${bt.slug}`);
                      setCopied(bt.id);
                      setTimeout(() => setCopied(null), 1500);
                    }}
                  >
                    <Copy className="me-1.5 size-3.5" />
                    {copied === bt.id ? t("bookingTypes.copied") : t("bookingTypes.copyLink")}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setEditing(bt)}>
                    <Pencil className="me-1.5 size-3.5" />
                    {t("bookingTypes.edit")}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {editing ? (
        <BookingTypeDialog
          bookingType={editing === "new" ? undefined : editing}
          schedules={schedules}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function BookingTypeDialog({
  bookingType,
  schedules,
  onClose,
}: {
  bookingType?: BookingTypeData;
  schedules: Array<{ id: string; name: string }>;
  onClose: () => void;
}) {
  const t = useTranslations("calendar");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<BookingTypeActionState, FormData>(
    saveBookingTypeAction.bind(null, bookingType?.id),
    {},
  );

  useEffect(() => {
    if (state.message === "saved") onClose();
  }, [state.message, onClose]);

  const selectClass =
    "w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && onClose()}
      role="dialog"
      aria-modal="true"
    >
      <Card className="max-h-[90vh] w-full max-w-lg overflow-y-auto">
        <CardHeader>
          <CardTitle>{bookingType ? bookingType.name : t("bookingTypes.new")}</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={action} className="space-y-3">
            <input
              type="hidden"
              name="durationOptions"
              value={JSON.stringify(bookingType?.durationOptions ?? [])}
            />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="bt-name">{t("bookingTypes.name")}</Label>
                <Input id="bt-name" name="name" defaultValue={bookingType?.name} required />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bt-slug">{t("bookingTypes.slug")}</Label>
                <Input
                  id="bt-slug"
                  name="slug"
                  defaultValue={bookingType?.slug}
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  required
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bt-description">{t("fields.description")}</Label>
              <textarea
                id="bt-description"
                name="description"
                rows={2}
                defaultValue={bookingType?.description ?? ""}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="bt-duration">{t("bookingTypes.duration")}</Label>
                <Input
                  id="bt-duration"
                  name="durationMinutes"
                  type="number"
                  min={5}
                  max={480}
                  defaultValue={bookingType?.durationMinutes ?? 30}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bt-schedule">{t("bookingTypes.schedule")}</Label>
                <select
                  id="bt-schedule"
                  name="scheduleId"
                  defaultValue={bookingType?.scheduleId ?? ""}
                  className={selectClass}
                >
                  <option value="">{t("bookingTypes.defaultSchedule")}</option>
                  {schedules.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="bt-locationType">{t("bookingTypes.locationType")}</Label>
                <select
                  id="bt-locationType"
                  name="locationType"
                  defaultValue={bookingType?.locationType ?? "VIDEO"}
                  className={selectClass}
                >
                  {(["VIDEO", "PHONE", "IN_PERSON", "CUSTOM"] as const).map((lt) => (
                    <option key={lt} value={lt}>
                      {t(`bookingTypes.locations.${lt}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bt-location">{t("fields.location")}</Label>
                <Input
                  id="bt-location"
                  name="location"
                  defaultValue={bookingType?.location ?? ""}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="space-y-1.5">
                <Label htmlFor="bt-bufBefore">{t("bookingTypes.bufferBefore")}</Label>
                <Input
                  id="bt-bufBefore"
                  name="bufferBeforeMinutes"
                  type="number"
                  min={0}
                  max={240}
                  defaultValue={bookingType?.bufferBeforeMinutes ?? 0}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bt-bufAfter">{t("bookingTypes.bufferAfter")}</Label>
                <Input
                  id="bt-bufAfter"
                  name="bufferAfterMinutes"
                  type="number"
                  min={0}
                  max={240}
                  defaultValue={bookingType?.bufferAfterMinutes ?? 0}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bt-notice">{t("bookingTypes.minNotice")}</Label>
                <Input
                  id="bt-notice"
                  name="minNoticeMinutes"
                  type="number"
                  min={0}
                  defaultValue={bookingType?.minNoticeMinutes ?? 120}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="bt-window">{t("bookingTypes.maxWindow")}</Label>
                <Input
                  id="bt-window"
                  name="maxWindowDays"
                  type="number"
                  min={1}
                  max={365}
                  defaultValue={bookingType?.maxWindowDays ?? 60}
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="bt-color">{t("bookingTypes.brandColor")}</Label>
                <Input
                  id="bt-color"
                  name="brandColor"
                  type="color"
                  defaultValue={bookingType?.brandColor ?? "#6366f1"}
                  className="h-9 w-20 p-1"
                />
              </div>
              <div className="flex flex-col justify-center gap-1.5 text-sm">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="isActive"
                    value="true"
                    defaultChecked={bookingType?.isActive ?? true}
                    className="size-4"
                  />
                  {t("bookingTypes.active")}
                </label>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="requiresConsent"
                    value="true"
                    defaultChecked={bookingType?.requiresConsent ?? true}
                    className="size-4"
                  />
                  {t("bookingTypes.requireConsent")}
                </label>
              </div>
            </div>

            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="collectPhone"
                  value="true"
                  defaultChecked={bookingType?.collectPhone}
                  className="size-4"
                />
                {t("bookingTypes.collectPhone")}
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="collectCompany"
                  value="true"
                  defaultChecked={bookingType?.collectCompany}
                  className="size-4"
                />
                {t("bookingTypes.collectCompany")}
              </label>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="bt-confirmation">{t("bookingTypes.confirmationMessage")}</Label>
              <textarea
                id="bt-confirmation"
                name="confirmationMessage"
                rows={2}
                defaultValue={bookingType?.confirmationMessage ?? ""}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
              />
            </div>

            {state.error ? (
              <p role="alert" className="text-sm text-destructive">
                {state.error === "slug_taken" ? t("bookingTypes.slugTaken") : tc("error")}
              </p>
            ) : null}

            <div className="flex justify-between pt-2">
              {bookingType ? (
                <Button
                  type="button"
                  variant="ghost"
                  className="text-destructive"
                  onClick={() => void deleteBookingTypeAction(bookingType.id).then(onClose)}
                >
                  {tc("delete")}
                </Button>
              ) : (
                <span />
              )}
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={onClose}>
                  {tc("cancel")}
                </Button>
                <Button type="submit" disabled={pending}>
                  {pending ? tc("loading") : tc("save")}
                </Button>
              </div>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
