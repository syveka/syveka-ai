"use client";

import { useActionState } from "react";
import { setOrganizationFeatureAction } from "@/actions/admin-entitlement-grants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Superadmin on/off switch for one organization feature flag, with a required reason. */
export function FeatureToggleForm({
  organizationId,
  featureKey,
  label,
  enabled,
}: {
  organizationId: string;
  featureKey: string;
  label: string;
  enabled: boolean;
}) {
  const [state, action, pending] = useActionState(setOrganizationFeatureAction, {});

  return (
    <form action={action} className="space-y-2 rounded-md border p-3 text-sm">
      <input type="hidden" name="organizationId" value={organizationId} />
      <input type="hidden" name="key" value={featureKey} />
      <input type="hidden" name="enabled" value={enabled ? "false" : "true"} />
      <p>
        <span className="font-medium">{label}</span>:{" "}
        <span className={enabled ? "text-success" : "text-muted-foreground"}>
          {enabled ? "on" : "off"}
        </span>
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          name="reason"
          required
          maxLength={500}
          aria-label={`Reason for turning ${label} ${enabled ? "off" : "on"}`}
          placeholder="Reason (pilot name and date)"
          className="max-w-xs"
        />
        <Button type="submit" variant="outline" size="sm" disabled={pending}>
          {pending ? "Saving…" : enabled ? "Turn off" : "Turn on"}
        </Button>
      </div>
      {state.error ? <p className="text-xs text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-xs text-muted-foreground">{state.message}</p> : null}
    </form>
  );
}
