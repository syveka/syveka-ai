"use client";

import { useState, useTransition } from "react";
import { toggleWorkflowAction } from "@/actions/workflows";
import { cn } from "@/lib/utils";

export function WorkflowToggle({
  workflowId,
  isActive,
}: {
  workflowId: string;
  isActive: boolean;
}) {
  const [active, setActive] = useState(isActive);
  const [pending, startTransition] = useTransition();

  return (
    <button
      role="switch"
      aria-checked={active}
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const next = !active;
          setActive(next);
          const res = await toggleWorkflowAction(workflowId, next);
          if (res.error) setActive(!next);
        })
      }
      className={cn(
        "relative h-5 w-9 rounded-full transition-colors",
        active ? "bg-success" : "bg-muted-foreground/30",
        pending && "opacity-60",
      )}
    >
      <span
        className={cn(
          "absolute top-0.5 size-4 rounded-full bg-white shadow transition-all",
          active ? "start-4" : "start-0.5",
        )}
      />
    </button>
  );
}
