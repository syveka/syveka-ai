"use client";

import { useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Plus, Trash2, ArrowDown } from "lucide-react";
import { saveWorkflowAction, testWorkflowAction } from "@/actions/workflows";
import type { WorkflowStep, WorkflowTrigger } from "@/lib/validators/workflows";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Link } from "@/i18n/routing";
import { cn } from "@/lib/utils";
import { formatDateTimeInTimeZone } from "@/lib/date-time";
import {
  TRIGGER_TYPES,
  blocksTestRun,
  type WorkflowActivationBlock,
} from "@/lib/workflows/activation";
import { WorkflowEntitlementNotice } from "@/components/workflows/workflow-entitlement-notice";
import type { WorkflowRunFailure } from "@/lib/workflows/run-failure";
import { INTERNAL_STEP_TYPES } from "@/lib/workflows/internal-scope";

const NOTICE_ID = "workflow-builder-entitlement-notice";
const TEST_CONTACT_HINT_ID = "workflow-builder-test-contact-hint";
const SAVE_ERROR_CODES = [
  "invalid_input",
  "duplicate_step_id",
  "recipient_not_member",
  "step_not_allowed",
] as const;
const RUN_STATUSES = ["RUNNING", "SUCCEEDED", "FAILED", "CANCELED", "WAITING"] as const;

const STEP_TYPES = [
  "condition",
  "ai.generate",
  "email.send",
  "crm.create_activity",
  "notify.member",
  "wait.duration",
] as const;

type Initial = {
  id?: string;
  name: string;
  description: string;
  trigger: WorkflowTrigger;
  steps: WorkflowStep[];
  isActive?: boolean;
  runs?: Array<{
    id: string;
    status: string;
    startedAt: string;
    failure: WorkflowRunFailure | null;
  }>;
};

function newStep(type: (typeof STEP_TYPES)[number], id: string): WorkflowStep {
  switch (type) {
    case "condition":
      return { id, type, field: "trigger.valueCents", comparator: "gt", value: 0 };
    case "ai.generate":
      return { id, type, prompt: "", outputVar: `text${id}` };
    case "email.send":
      return { id, type, to: "", subject: "", body: "" };
    case "crm.create_activity":
      return { id, type, contactIdVar: "trigger.contactId", activityType: "TASK", subject: "" };
    case "notify.member":
      return { id, type, title: "" };
    case "wait.duration":
      return { id, type, seconds: 3600 };
  }
}

export function WorkflowBuilder({
  initial,
  activation = { block: null, limit: 0 },
  timeZone,
  canViewPlans = false,
  internalOnly = false,
}: {
  initial?: Initial;
  /** Why the plan does not allow activation (display only; the server enforces). */
  activation?: { block: WorkflowActivationBlock | null; limit: number };
  /** The viewer's zone for run times (server render and hydration agree). */
  timeZone: string;
  canViewPlans?: boolean;
  /**
   * The org's workflows are limited to internal steps (display only: save,
   * activation, test runs and the job each enforce it on the server).
   */
  internalOnly?: boolean;
}) {
  const t = useTranslations("workflows");
  const tc = useTranslations("common");
  const locale = useLocale();
  const testRunBlocked = blocksTestRun(activation.block);
  // A test run carries no trigger record (testWorkflowAction), so a saved CRM
  // step has no contact if the run reaches it: say so before the run rather
  // than only in its failure reason.
  const testRunHasNoContact =
    !testRunBlocked && (initial?.steps ?? []).some((s) => s.type === "crm.create_activity");
  const saveErrorMessage = (code: string) =>
    (SAVE_ERROR_CODES as readonly string[]).includes(code)
      ? t(`saveErrors.${code as (typeof SAVE_ERROR_CODES)[number]}`)
      : tc("error");
  const [name, setName] = useState(initial?.name ?? "");
  const [trigger, setTrigger] = useState<WorkflowTrigger>(
    initial?.trigger ?? { type: "contact.created" },
  );
  const [steps, setSteps] = useState<WorkflowStep[]>(initial?.steps ?? []);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const updateStep = (index: number, patch: Partial<WorkflowStep>) =>
    setSteps((prev) =>
      prev.map((s, i) => (i === index ? ({ ...s, ...patch } as WorkflowStep) : s)),
    );

  const save = () =>
    startTransition(async () => {
      setError(null);
      setSaved(false);
      const res = await saveWorkflowAction(initial?.id, {
        name,
        description: initial?.description || undefined,
        trigger,
        steps,
      });
      if (res?.error) setError(saveErrorMessage(res.error));
      else setSaved(true);
    });

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <Link href="/workflows" className="text-sm text-muted-foreground hover:underline">
          ← {t("title")}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{initial?.id ? name : t("newWorkflow")}</h1>
      </div>

      {activation.block ? (
        <WorkflowEntitlementNotice
          id={NOTICE_ID}
          message={
            activation.block === "limit_reached"
              ? t("entitlement.limitReached", { limit: activation.limit })
              : activation.block === "read_only"
                ? t("entitlement.readOnly")
                : t("entitlement.notIncluded")
          }
          plansLabel={canViewPlans ? t("entitlement.viewPlans") : undefined}
        />
      ) : null}

      <Card>
        <CardContent className="space-y-4 pt-6">
          <div className="space-y-1.5">
            <Label htmlFor="wf-name">{t("fields.name")}</Label>
            <Input id="wf-name" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="wf-trigger">{t("fields.trigger")}</Label>
            <select
              id="wf-trigger"
              value={trigger.type}
              onChange={(e) => setTrigger({ type: e.target.value } as WorkflowTrigger)}
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
            >
              {TRIGGER_TYPES.map((tt) => (
                <option key={tt} value={tt}>
                  {t(`triggers.${tt}` as never)}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      {steps.map((step, i) => (
        <div key={step.id}>
          <div className="flex justify-center py-1 text-muted-foreground">
            <ArrowDown className="size-4" />
          </div>
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm">
                {i + 1}. {t(`stepTypes.${step.type}` as never)}
              </CardTitle>
              <Button
                variant="ghost"
                size="icon"
                className="text-destructive"
                onClick={() => setSteps((prev) => prev.filter((_, j) => j !== i))}
              >
                <Trash2 className="size-4" />
              </Button>
            </CardHeader>
            <CardContent className="space-y-3">
              <StepFields step={step} onChange={(patch) => updateStep(i, patch)} />
            </CardContent>
          </Card>
        </div>
      ))}

      {/* Before the buttons, so it is read before the unavailable steps. */}
      {internalOnly ? (
        <p id="workflow-internal-only-hint" className="text-xs text-muted-foreground">
          {t("internalOnlyHint")}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {STEP_TYPES.map((st) => {
          const unavailable = internalOnly && !INTERNAL_STEP_TYPES.includes(st);
          return (
            <Button
              key={st}
              variant="outline"
              size="sm"
              className="gap-1"
              disabled={unavailable}
              aria-describedby={unavailable ? "workflow-internal-only-hint" : undefined}
              onClick={() => setSteps((prev) => [...prev, newStep(st, `s${Date.now()}`)])}
            >
              <Plus className="size-3" />
              {t(`stepTypes.${st}` as never)}
            </Button>
          );
        })}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {saved ? <p className="text-sm text-success">{t("saved")}</p> : null}

      <div className="flex gap-2">
        <Button onClick={save} disabled={pending || !name || steps.length === 0}>
          {pending ? tc("loading") : tc("save")}
        </Button>
        {initial?.id ? (
          <Button
            variant="outline"
            disabled={pending || testRunBlocked}
            aria-describedby={
              testRunBlocked ? NOTICE_ID : testRunHasNoContact ? TEST_CONTACT_HINT_ID : undefined
            }
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const res = await testWorkflowAction(initial.id!);
                if (res.error) {
                  setError(
                    res.error === "quota"
                      ? t("testErrors.quota")
                      : res.error === "step_not_allowed"
                        ? t("saveErrors.step_not_allowed")
                        : res.error === "service_unavailable"
                          ? t("testErrors.unavailable")
                          : t("testErrors.rateLimited"),
                  );
                }
              })
            }
          >
            {t("testRun")}
          </Button>
        ) : null}
      </div>
      {initial?.id && testRunHasNoContact ? (
        <p id={TEST_CONTACT_HINT_ID} className="text-xs text-muted-foreground">
          {t("testRunNoContact", { step: t("stepTypes.crm.create_activity") })}
        </p>
      ) : null}

      {initial?.runs && initial.runs.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t("runHistory")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {initial.runs.map((r) => (
              <div key={r.id} className="text-sm">
                <div className="flex items-center justify-between">
                  <time className="text-muted-foreground" dateTime={r.startedAt}>
                    {formatDateTimeInTimeZone(r.startedAt, locale, timeZone, {
                      dateStyle: "short",
                      timeStyle: "medium",
                    })}
                  </time>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-xs",
                      r.status === "SUCCEEDED" && "bg-success/15 text-success",
                      r.status === "FAILED" && "bg-destructive/15 text-destructive",
                    )}
                  >
                    {(RUN_STATUSES as readonly string[]).includes(r.status)
                      ? t(`runStatus.${r.status as (typeof RUN_STATUSES)[number]}`)
                      : r.status}
                  </span>
                </div>
                {r.failure && (r.status === "FAILED" || r.status === "CANCELED") ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(`runFailure.${r.failure}`)}
                  </p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

function StepFields({
  step,
  onChange,
}: {
  step: WorkflowStep;
  onChange: (patch: Partial<WorkflowStep>) => void;
}) {
  const t = useTranslations("workflows");
  const input = (props: React.ComponentProps<typeof Input>) => <Input {...props} />;

  switch (step.type) {
    case "condition":
      return (
        <div className="grid grid-cols-3 gap-2">
          {input({
            value: step.field,
            placeholder: "trigger.valueCents",
            onChange: (e) => onChange({ field: e.target.value }),
          })}
          <select
            value={step.comparator}
            onChange={(e) => onChange({ comparator: e.target.value as never })}
            className="h-9 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            {["eq", "neq", "gt", "lt", "contains", "exists"].map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          {input({
            value: String(step.value ?? ""),
            onChange: (e) => onChange({ value: e.target.value }),
          })}
        </div>
      );
    case "ai.generate":
      return (
        <>
          <textarea
            value={step.prompt}
            onChange={(e) => onChange({ prompt: e.target.value })}
            placeholder={t("promptPlaceholder")}
            rows={3}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
          {input({
            value: step.outputVar,
            placeholder: "outputVar",
            onChange: (e) => onChange({ outputVar: e.target.value }),
          })}
        </>
      );
    case "email.send":
      return (
        <>
          {input({
            value: step.to,
            placeholder: "someone@company.fi or {{trigger.email}}",
            onChange: (e) => onChange({ to: e.target.value }),
          })}
          {input({
            value: step.subject,
            placeholder: t("subjectPlaceholder"),
            onChange: (e) => onChange({ subject: e.target.value }),
          })}
          <textarea
            value={step.body}
            onChange={(e) => onChange({ body: e.target.value })}
            placeholder={"{{vars.textX}}"}
            rows={3}
            className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm"
          />
        </>
      );
    case "crm.create_activity":
      return (
        <>
          {input({
            value: step.contactIdVar,
            placeholder: "trigger.contactId",
            onChange: (e) => onChange({ contactIdVar: e.target.value }),
          })}
          {input({
            value: step.subject,
            placeholder: t("subjectPlaceholder"),
            onChange: (e) => onChange({ subject: e.target.value }),
          })}
        </>
      );
    case "notify.member":
      return input({
        value: step.title,
        placeholder: t("subjectPlaceholder"),
        onChange: (e) => onChange({ title: e.target.value }),
      });
    case "wait.duration":
      return (
        <div className="flex items-center gap-2 text-sm">
          {input({
            type: "number",
            value: step.seconds,
            min: 60,
            className: "max-w-32",
            onChange: (e) => onChange({ seconds: Number(e.target.value) }),
          })}
          <span className="text-muted-foreground">{t("seconds")}</span>
        </div>
      );
  }
}
