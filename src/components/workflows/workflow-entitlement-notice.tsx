import { Info } from "lucide-react";
import { Link } from "@/i18n/routing";

/**
 * Explains, before anyone builds or toggles anything, why workflows cannot be
 * activated on the current plan. Pure markup (works in server and client
 * trees); callers pass already-translated text. `id` lets the activation
 * switch reference this explanation with aria-describedby.
 */
export function WorkflowEntitlementNotice({
  id,
  message,
  plansLabel,
}: {
  id: string;
  message: string;
  /** Shown only to roles that can open billing. */
  plansLabel?: string;
}) {
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 p-3 text-start text-sm"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p id={id}>{message}</p>
        {plansLabel ? (
          <Link href="/settings/billing" className="font-medium underline underline-offset-2">
            {plansLabel}
          </Link>
        ) : null}
      </div>
    </div>
  );
}
