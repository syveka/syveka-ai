"use client";

import { useActionState, useEffect, useRef, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { addDealTaskAction, toggleDealTaskAction, type DealActionState } from "@/actions/deals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatDate, cn } from "@/lib/utils";

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
}: {
  dealId: string;
  task: DealTask;
  canWrite: boolean;
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
            {formatDate(task.dueAt, locale, { dateStyle: "medium", timeStyle: "short" })}
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
}: {
  dealId: string;
  tasks: DealTask[];
  canWrite: boolean;
}) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
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
        <form ref={formRef} action={action} className="flex flex-wrap items-center gap-2">
          <Input
            name="title"
            required
            maxLength={200}
            placeholder={t("taskPlaceholder")}
            className="w-40 flex-1"
          />
          <Input
            name="dueAt"
            type="datetime-local"
            className="w-52"
            aria-label={t("dealFields.dueDate")}
          />
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
            <TaskRow key={task.id} dealId={dealId} task={task} canWrite={canWrite} />
          ))}
        </div>
      )}
    </div>
  );
}
