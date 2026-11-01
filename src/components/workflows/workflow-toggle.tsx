"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { toggleWorkflowAction } from "@/actions/workflows";
import { cn } from "@/lib/utils";

/**
 * Activation switch. When the plan does not allow activating (see
 * src/lib/workflows/activation.ts) an inactive workflow's switch is disabled
 * and points at the visible explanation via aria-describedby; deactivating is
 * always possible. If the server still refuses (its checks are the source of
 * truth), the switch reverts and says why instead of failing silently.
 */
export function WorkflowToggle({
  workflowId,
  isActive,
  label,
  activationBlocked = false,
  describedById,
}: {
  workflowId: string;
  isActive: boolean;
  /** Accessible name, e.g. "<workflow name>: active". */
  label: string;
  activationBlocked?: boolean;
  /** Id of the element explaining why activation is unavailable. */
  describedById?: string;
}) {
  const t = useTranslations("workflows");
  const tc = useTranslations("common");
  const [active, setActive] = useState(isActive);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const blocked = activationBlocked && !active;

  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        role="switch"
        aria-checked={active}
        aria-label={label}
        aria-describedby={blocked ? describedById : undefined}
        title={blocked ? t("entitlement.activationUnavailable") : undefined}
        disabled={pending || blocked}
        onClick={() =>
          startTransition(async () => {
            const next = !active;
            setError(null);
            setActive(next);
            try {
              const res = await toggleWorkflowAction(workflowId, next);
              if (res.error) {
                setActive(!next);
                setError(
                  res.error === "quota"
                    ? t("entitlement.activationUnavailable")
                    : res.error === "step_not_allowed"
                      ? t("saveErrors.step_not_allowed")
                      : tc("error"),
                );
              }
            } catch {
              setActive(!next);
              setError(tc("error"));
            }
          })
        }
        className={cn(
          "relative h-5 w-9 rounded-full transition-colors disabled:cursor-not-allowed",
          active ? "bg-success" : "bg-muted-foreground/30",
          (pending || blocked) && "opacity-60",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-white shadow transition-all",
            active ? "start-4" : "start-0.5",
          )}
        />
      </button>
      {error ? (
        <span role="alert" className="max-w-48 text-end text-xs text-destructive">
          {error}
        </span>
      ) : null}
    </span>
  );
}
