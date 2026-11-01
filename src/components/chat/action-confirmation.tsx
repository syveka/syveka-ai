"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check, RotateCcw, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "@/i18n/routing";
import type { ProposedActionView, RestoredActionState } from "@/lib/validators/chat";
import { BusinessDnaChanges } from "./business-dna-changes";

type State =
  | "pending"
  | "submitting"
  | "done"
  | "canceled"
  | "slotTaken"
  | "stale"
  | "expired"
  | "alreadyDecided"
  | "superseded"
  | "permission"
  | "rateLimited"
  | "failed"
  | "unknown"
  | "unavailable";

const REFUSAL_STATE: Record<string, State> = {
  not_found: "expired",
  already_decided: "alreadyDecided",
  mismatch: "failed",
  // The tool ran into an error after the action was consumed: its write may
  // or may not have happened -- never claim it failed.
  action_failed: "unknown",
  // The action store couldn't be reached: the tool only runs after it answers.
  service_unavailable: "failed",
  rate_limited: "rateLimited",
  permission_denied: "permission",
  // The plan's limit (or a read-only workspace) refused it before any write.
  plan_limit: "failed",
};

/**
 * Refusals that leave the action undecided on the server (nothing ran, the
 * request can simply be sent again), as opposed to those that consumed it.
 */
const RETRYABLE_REFUSALS = new Set(["service_unavailable", "rate_limited"]);

/** The outcome a repeated decision reports for the first one (see the decision endpoint). */
const RECORDED_STATE: Record<RestoredActionState, State> = {
  done: "done",
  canceled: "canceled",
  slotTaken: "slotTaken",
  stale: "stale",
  failed: "failed",
  unknown: "unknown",
  unavailable: "unavailable",
};

function formatWhen(iso: string, timeZone: string | undefined, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

/** Outcomes after which the action can't be decided again. */
const SETTLED = new Set<State>([
  "done",
  "canceled",
  "slotTaken",
  "stale",
  "expired",
  "alreadyDecided",
  "superseded",
]);

/**
 * A write the assistant proposed. Nothing happens until the user confirms
 * here; the server then runs exactly this action, once.
 *
 * A request that got no usable answer (the limit or the action store was
 * unavailable, the connection dropped) can be sent again: the server runs an
 * action at most once, so a repeat after a lost answer is refused with the
 * recorded outcome of the first decision, which is then shown.
 */
export function ActionConfirmation({
  action,
  superseded = false,
  onSettled,
}: {
  action: ProposedActionView & { restored?: RestoredActionState };
  /** A newer proposal in this conversation changes the same fields (see supersededActionIds). */
  superseded?: boolean;
  /** Called once the action is decided for good (not after a failed request). */
  onSettled?: (actionId: string) => void;
}) {
  const t = useTranslations("chat.actions");
  const locale = useLocale();
  // A reopened conversation shows the recorded outcome (never executable);
  // otherwise a pending card, or "expired" once it can't be decided any more.
  const [state, setState] = useState<State>(() =>
    action.restored
      ? action.restored
      : action.expiresAt <= Date.now()
        ? "expired"
        : superseded
          ? "superseded"
          : "pending",
  );
  // Whether the last request can be sent again, and what it decided.
  const [retryable, setRetryable] = useState(false);
  const lastDecisionRef = useRef<"confirm" | "cancel">("confirm");
  const d = action.details;
  // One decision per card: a fast double click must not send a second request.
  const sentRef = useRef(false);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const decidedRef = useRef(false);

  // A proposal replaced by a newer one (from the start, or while this card
  // was pending) is no longer this view's business: a held redirect may
  // proceed. Reported once.
  const releasedRef = useRef(false);
  useEffect(() => {
    if (!superseded || releasedRef.current) return;
    if (state === "pending") setState("superseded");
    if (state === "pending" || state === "superseded") {
      releasedRef.current = true;
      onSettled?.(action.id);
    }
    // onSettled is a stable callback from the chat hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [superseded, action.id, state]);

  // After the user's decision, the result is where their attention should go:
  // the buttons they used are gone, so focus moves to the outcome (and the
  // retry button, when there is one, follows it in tab order).
  useEffect(() => {
    if (decidedRef.current && state !== "submitting" && state !== "pending") {
      resultRef.current?.focus();
    }
  }, [state]);

  const summary =
    d.tool === "proposeBusinessDnaUpdate"
      ? t("businessDna.summary", { count: d.changes.length })
      : d.tool === "createContact"
        ? t("createContact", { name: [d.firstName, d.lastName].filter(Boolean).join(" ") })
        : d.tool === "logActivity"
          ? t(d.type === "TASK" ? "logTask" : "logNote", {
              contact: d.contactName,
              subject: d.subject,
            })
          : t("bookMeeting", {
              title: d.title,
              when: formatWhen(d.startsAt, d.timezone, locale),
              minutes: d.durationMinutes,
            });
  const extra = [
    d.tool === "createContact" && d.email ? t("email", { value: d.email }) : null,
    d.tool === "createContact" && d.phone ? t("phone", { value: d.phone }) : null,
    d.tool === "logActivity" && d.dueAt
      ? t("dueAt", { when: formatWhen(d.dueAt, undefined, locale) })
      : null,
    d.tool === "bookMeeting" && d.contactName ? t("withContact", { contact: d.contactName }) : null,
  ].filter((x): x is string => !!x);
  // Free-form text that will be saved is always shown in full (never only
  // in the fingerprint): the user confirms exactly what is stored.
  const content =
    d.tool === "logActivity" ? d.body : d.tool === "bookMeeting" ? d.notes : undefined;

  const decide = async (decision: "confirm" | "cancel") => {
    if (sentRef.current) return;
    sentRef.current = true;
    decidedRef.current = true;
    lastDecisionRef.current = decision;
    setRetryable(false);
    setState("submitting");
    let next: State;
    let canRetry = false;
    try {
      const res = await fetch(`/api/v1/ai/actions/${action.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decision,
          conversationId: action.conversationId,
          digest: action.digest,
        }),
      });
      const body = (await res.json().catch(() => null)) as {
        data?: { status?: string; reason?: string };
        error?: { code?: string; outcome?: RestoredActionState };
      } | null;
      const code = body?.error?.code ?? "";
      if (res.ok && body?.data?.status) {
        next =
          body.data.status === "canceled"
            ? "canceled"
            : body.data.status === "not_done"
              ? body.data.reason === "stale"
                ? "stale"
                : "slotTaken"
              : "done";
      } else if (code === "already_decided" && body?.error?.outcome) {
        // The first decision went through (its answer was lost): show its result.
        next = RECORDED_STATE[body.error.outcome];
      } else {
        next = REFUSAL_STATE[code] ?? (res.status >= 500 ? "unknown" : "failed");
        // Not decided on the server: sending again is safe. Without a known
        // refusal on a server error the action may have run; a repeat is still
        // safe (refused with the first decision's outcome).
        canRetry = RETRYABLE_REFUSALS.has(code) || (res.status >= 500 && !code);
      }
    } catch {
      // No answer: the server may or may not have run it. A repeat is safe.
      next = "unknown";
      canRetry = true;
    }
    setState(next);
    setRetryable(canRetry);
    if (canRetry) sentRef.current = false;
    if (SETTLED.has(next)) onSettled?.(action.id);
  };

  const busy = state === "submitting";
  const retry = () => void decide(lastDecisionRef.current);
  return (
    <section
      aria-label={t("title")}
      className="mt-2 rounded-md border border-border/60 bg-background/70 p-2.5 text-sm"
    >
      <p className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <ShieldCheck aria-hidden className="size-3.5" />
        {t("title")}
      </p>
      <p className="mt-1 font-medium">{summary}</p>
      {extra.map((line) => (
        <p key={line} className="text-xs text-muted-foreground">
          {line}
        </p>
      ))}
      {d.tool === "proposeBusinessDnaUpdate" ? <BusinessDnaChanges changes={d.changes} /> : null}
      {content ? (
        <div className="mt-1">
          <p className="text-xs text-muted-foreground">{t("content")}</p>
          <p
            data-testid="action-content"
            className="mt-0.5 max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded border border-border/50 bg-muted/40 p-1.5 text-xs"
          >
            {content}
          </p>
        </div>
      ) : null}
      {state === "pending" || busy ? (
        <>
          <p className="mt-1 text-xs text-muted-foreground">{t("nothingYet")}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("confirm")}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <Check aria-hidden className="size-4" />
              {busy ? t("confirming") : t("confirm")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide("cancel")}
              className="inline-flex min-h-10 items-center gap-1.5 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <X aria-hidden className="size-4" />
              {t("cancel")}
            </button>
          </div>
        </>
      ) : (
        <>
          <p
            ref={resultRef}
            tabIndex={-1}
            role="status"
            className={cn(
              "mt-2 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              state === "done" ? "text-success" : "text-muted-foreground",
              (state === "failed" || state === "permission") && "text-destructive",
            )}
          >
            {t(`result.${state}`)}
          </p>
          {retryable ? (
            <button
              type="button"
              onClick={retry}
              className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <RotateCcw aria-hidden className="size-4" />
              {t("tryAgain")}
            </button>
          ) : null}
        </>
      )}
      {d.tool === "proposeBusinessDnaUpdate" && state === "done" ? (
        <Link
          href="/settings/business-dna"
          className="mt-1 inline-block text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("businessDna.review")}
        </Link>
      ) : null}
    </section>
  );
}
