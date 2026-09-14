"use client";

import { useActionState } from "react";
import { revokeEntitlementGrantAction } from "@/actions/admin-entitlement-grants";
import { Button } from "@/components/ui/button";

export function RevokeGrantButton({
  grantId,
  organizationId,
}: {
  grantId: string;
  organizationId: string;
}) {
  const [state, action, pending] = useActionState(revokeEntitlementGrantAction, {});

  return (
    <form action={action}>
      <input type="hidden" name="grantId" value={grantId} />
      <input type="hidden" name="organizationId" value={organizationId} />
      <Button type="submit" variant="outline" size="sm" disabled={pending}>
        {pending ? "Revoking…" : "Revoke"}
      </Button>
      {state.error ? <p className="mt-1 text-xs text-destructive">{state.error}</p> : null}
    </form>
  );
}
