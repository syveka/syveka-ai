"use client";

import { useActionState, useEffect, useId, useRef, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { addDealTaskAction, toggleDealTaskAction, type DealActionState } from "@/actions/deals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import { formatDateTimeInTimeZone } from "@/lib/date-time";

export type DealTask = {
  id: string;
  subject: string;
  dueAt: string | null;
  completedAt: string | null;
};

function TaskRow({
  dealId,
  task,
  canWrite,
  timeZone,
}: {
  dealId: string;
  task: DealTask;
  canWrite: boolean;
  timeZone: string;
}) {
  const t = useTranslations("crm");
  const locale = useLocale();
  const [pending, startTransition] = useTransition();
  const completed = task.completedAt !== null;
  const overdue = !completed && task.dueAt !== null && new Date(task.dueAt).getTime() < Date.now();

  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        className="mt-0.5 size-4"
        checked={completed}
        disabled={!canWrite || pending}
        onChange={(e) => {
          const next = e.target.checked;
          startTransition(async () => {
            await toggleDealTaskAction(dealId, task.id, next);
          });
        }}
      />
      <span className="flex-1">
        <span className={cn(completed && "text-muted-foreground line-through")}>
          {task.subject}
        </span>
        {task.dueAt ? (
          <span
            className={cn(
              "ms-2 text-xs",
              overdue ? "font-medium text-destructive" : "text-muted-foreground",
            )}
          >
            {overdue ? `${t("overdue")} · ` : ""}
            {formatDateTimeInTimeZone(task.dueAt, locale, timeZone, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </span>
        ) : null}
      </span>
    </label>
  );
}

export function DealTasks({
  dealId,
  tasks,
  canWrite,
  timeZone,
}: {
  dealId: string;
  tasks: DealTask[];
  canWrite: boolean;
  /** The viewer's zone, so server render and hydration show the same time. */
  timeZone: string;
}) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const fieldId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, pending] = useActionState<DealActionState, FormData>(
    addDealTaskAction.bind(null, dealId),
    {},
  );

  useEffect(() => {
    if (state.message === "taskAdded") formRef.current?.reset();
  }, [state.message]);

  return (
    <div className="space-y-3">
      {canWrite ? (
        <form
          ref={formRef}
          action={action}
          className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto] sm:items-end"
        >
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${fieldId}-title`}>{t("taskTitleLabel")}</Label>
            <Input
              id={`${fieldId}-title`}
              name="title"
              required
              maxLength={200}
              placeholder={t("taskPlaceholder")}
            />
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${fieldId}-due`}>{t("taskDueLabel")}</Label>
            <Input
              id={`${fieldId}-due`}
              name="dueAt"
              type="datetime-local"
              className="w-full sm:w-52"
            />
          </div>
          <Button type="submit" size="sm" disabled={pending}>
            {pending ? tc("loading") : t("addTask")}
          </Button>
        </form>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error === "invalid_input" ? t("invalidInput") : tc("error")}
        </p>
      ) : null}
      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("noTasks")}</p>
      ) : (
        <div className="space-y-2">
          {tasks.map((task) => (
            <TaskRow
              key={task.id}
              dealId={dealId}
              task={task}
              canWrite={canWrite}
              timeZone={timeZone}
            />
          ))}
        </div>
      )}
    </div>
  );
}
