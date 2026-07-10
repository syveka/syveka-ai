"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { updateProfileAction, type SettingsActionState } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent } from "@/components/ui/card";

const TIMEZONES = ["Europe/Helsinki", "Europe/Stockholm", "Europe/Tallinn", "Europe/London", "UTC"];

export function ProfileForm({
  initial,
}: {
  initial: { fullName: string; email: string; locale: string; timezone: string };
}) {
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<SettingsActionState, FormData>(
    updateProfileAction,
    {},
  );

  return (
    <Card>
      <CardContent className="pt-6">
        <form action={action} className="space-y-4">
          <div className="space-y-1.5">
            <Label>Email</Label>
            <Input value={initial.email} disabled />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="fullName">Name</Label>
            <Input id="fullName" name="fullName" defaultValue={initial.fullName} required />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="locale">Language</Label>
              <select
                id="locale"
                name="locale"
                defaultValue={initial.locale}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              >
                <option value="FI">Suomi</option>
                <option value="EN">English</option>
                <option value="AR">العربية</option>
              </select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timezone">Timezone</Label>
              <select
                id="timezone"
                name="timezone"
                defaultValue={initial.timezone}
                className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              >
                {TIMEZONES.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {state.message ? <p className="text-sm text-success">✓</p> : null}
          {state.error ? <p className="text-sm text-destructive">{tc("error")}</p> : null}
          <Button type="submit" disabled={pending}>
            {pending ? tc("loading") : tc("save")}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
