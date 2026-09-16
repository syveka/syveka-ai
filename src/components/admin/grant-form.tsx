"use client";

import { useActionState } from "react";
import { createEntitlementGrantAction } from "@/actions/admin-entitlement-grants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm";

export function GrantForm({
  organizationId,
  metricLabels,
}: {
  organizationId: string;
  metricLabels: Record<string, string>;
}) {
  const [state, action, pending] = useActionState(createEntitlementGrantAction, {});

  return (
    <form action={action} className="space-y-3 rounded-md border p-4">
      <input type="hidden" name="organizationId" value={organizationId} />
      <p className="text-sm font-medium">Add a grant</p>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="metric">Metric</Label>
          <select id="metric" name="metric" required className={SELECT_CLASS} defaultValue="">
            <option value="" disabled>
              Select a metric…
            </option>
            {Object.entries(metricLabels).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1">
          <Label htmlFor="amount">Amount (added on top of the plan)</Label>
          <Input id="amount" name="amount" type="number" min={1} step={1} required />
        </div>

        <div className="space-y-1 sm:col-span-2">
          <Label htmlFor="reason">Reason</Label>
          <Input
            id="reason"
            name="reason"
            placeholder="e.g. Syveka Test — Voice smoke test pilot"
            required
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="expiresAt">Expires (optional)</Label>
          <Input id="expiresAt" name="expiresAt" type="date" />
        </div>
      </div>

      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      {state.message ? <p className="text-sm text-success">{state.message}</p> : null}

      <Button type="submit" disabled={pending} size="sm">
        {pending ? "Granting…" : "Add grant"}
      </Button>
    </form>
  );
}
