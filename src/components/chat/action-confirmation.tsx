"use client";

import { useEffect, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check, RotateCcw, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Link } from "@/i18n/routing";
import type { ProposedActionView, RestoredActionState } from "@/lib/validators/chat";
import type { Supersession } from "@/lib/chat/superseded-actions";
import { BusinessDnaChanges, businessDnaFieldLabel } from "./business-dna-changes";

type State =
  | "pending"
  | "submitting"
  | "retrying"
  | "done"
  | "canceled"
  | "slotTaken"
  | "stale"
  | "expired"
  | "superseded"
  | "permission"
  | "planLimit"
  | "rateLimited"
  | "failed"
  | "noAnswer"
  | "unknown"
  | "unavailable";

const REFUSAL_STATE: Record<string, State> = {
  not_found: "expired",
  // Decided before, but the first decision's outcome isn't recorded (yet):
  // the result can't be confirmed from here. A reload shows the record.
  already_decided: "unknown",
  mismatch: "failed",
  // The tool ran into an error after the action was consumed: its write may
  // or may not have happened -- never claim it failed.
  action_failed: "unknown",
  // The calendar stayed locked, so nothing was booked.
  calendar_busy: "failed",
  // The action store couldn't be reached: the tool only runs after it answers.
  service_unavailable: "failed",
  rate_limited: "rateLimited",
  permission_denied: "permission",
  // The plan's limit (or a read-only workspace) refused it before any write.
  plan_limit: "planLimit",
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

/**
 * What the thread is told once a card is settled: a result it can restore,
 * or "superseded". Refusals that consumed the action count as failed.
 */
function settledOutcome(state: State): RestoredActionState | "superseded" {
  switch (state) {
    case "done":
    case "canceled":
    case "slotTaken":
    case "stale":
    case "unknown":
    case "unavailable":
    case "superseded":
      return state;
    case "expired":
      return "unavailable";
    default:
      return "failed";
  }
}

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
  superseded,
  onSettled,
}: {
  action: ProposedActionView & { restored?: RestoredActionState };
  /** Set while a newer proposal in this conversation replaces this one (see supersededActions). */
  superseded?: Supersession;
  /** Called once the action can't be decided here any more (not after a request that can be sent again), with the outcome. */
  onSettled?: (actionId: string, outcome: RestoredActionState | "superseded") => void;
}) {
  const t = useTranslations("chat.actions");
  const field = useTranslations("businessDna");
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
  const cardRef = useRef<HTMLElement>(null);
  const decidedRef = useRef(false);

  // A proposal replaced by a newer one (from the start, or while this card
  // was pending) is no longer this view's business: a held redirect may
  // proceed. Reported once per replacement. When the newer proposal is
  // canceled (or fails before any write), this one is offered again, as
  // long as it was never decided and hasn't expired meanwhile.
  // A card whose request can be sent again is open on the server too, so a
  // correction replaces it as well: its repeat is withheld (never sent with
  // a replaced value) and offered again once the newer proposal is withdrawn.
  const releasedRef = useRef(false);
  useEffect(() => {
    if (superseded) {
      if (releasedRef.current) return;
      if (state === "pending") setState("superseded");
      if (state === "pending" || state === "superseded" || retryable) {
        releasedRef.current = true;
        onSettled?.(action.id, "superseded");
      }
      return;
    }
    releasedRef.current = false;
    if (state === "superseded" && !decidedRef.current && !action.restored) {
      setState(action.expiresAt > Date.now() ? "pending" : "expired");
    }
    // onSettled is a stable callback from the chat hook.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [superseded, action.id, state, retryable]);

  // After the user's decision, the result is where their attention should go:
  // the buttons they used are gone, so focus moves to the card (its live
  // region reads the result once; the retry button, when there is one,
  // follows in tab order). Never on mount, and never for a change the user
  // didn't make (superseded).
  useEffect(() => {
    if (decidedRef.current && state !== "submitting" && state !== "retrying") {
      cardRef.current?.focus();
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

  const decide = async (decision: "confirm" | "cancel", repeat = false) => {
    if (sentRef.current) return;
    sentRef.current = true;
    decidedRef.current = true;
    lastDecisionRef.current = decision;
    setRetryable(false);
    setState(repeat ? "retrying" : "submitting");
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
        next = RECORDED_STATE[body.error.outcome] ?? "unknown";
      } else if (code in REFUSAL_STATE) {
        next = REFUSAL_STATE[code]!;
        // Not decided on the server: sending again is safe.
        canRetry = RETRYABLE_REFUSALS.has(code);
      } else {
        // No usable answer (a server error without a known refusal, or no
        // JSON at all): the action may have run. A repeat is still safe, as
        // it is refused with the first decision's outcome. Any other refusal
        // without a known code came before the decision (signed out, a
        // malformed request): nothing was consumed, so it can be sent again.
        next = res.status >= 500 ? "noAnswer" : "failed";
        canRetry = true;
      }
    } catch {
      // No answer: the server may or may not have run it. A repeat is safe.
      next = "noAnswer";
      canRetry = true;
    }
    setState(next);
    setRetryable(canRetry);
    if (canRetry) sentRef.current = false;
    // Whatever can't be sent again is settled for this view: a consumed
    // refusal (permission, plan limit, a failure while running) as much as
    // a result, so a held redirect never waits for a card that can't change.
    if (!canRetry) onSettled?.(action.id, settledOutcome(next));
  };

  const submitting = state === "submitting";
  const retrying = state === "retrying";
  const deciding = state === "pending" || submitting;
  // Replaced by a newer proposal: shown as such, whether this card was still
  // pending or awaiting a repeat.
  const replaced = !!superseded && (state === "superseded" || retryable);
  // One live region in every state, so a change the user didn't make
  // (replaced by a newer request) is announced, not only an inserted node.
  // A replacement that covers only some of this proposal's fields names the
  // rest, so no change is dropped silently.
  const notCarriedOver = replaced ? superseded!.notCarriedOver : [];
  const status =
    state === "pending"
      ? t("nothingYet")
      : submitting
        ? t("confirming")
        : retrying
          ? t("retrying")
          : replaced
            ? [
                t("result.superseded"),
                notCarriedOver.length > 0
                  ? t("notCarriedOver", {
                      count: notCarriedOver.length,
                      fields: new Intl.ListFormat(locale, { type: "conjunction" }).format(
                        notCarriedOver.map((f) => businessDnaFieldLabel(field, f)),
                      ),
                    })
                  : null,
              ]
                .filter(Boolean)
                .join(" ")
            : t(`result.${state}`);
  return (
    <section
      ref={cardRef}
      tabIndex={-1}
      aria-label={t("title")}
      className="mt-2 rounded-md border border-border/60 bg-background/70 p-2.5 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
      <p
        role="status"
        aria-live="polite"
        className={cn(
          "mt-1 text-xs",
          state === "done" ? "text-success" : "text-muted-foreground",
          (state === "failed" || state === "permission" || state === "planLimit") &&
            "text-destructive",
        )}
      >
        {status}
      </p>
      {deciding ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            aria-disabled={submitting || undefined}
            aria-busy={submitting || undefined}
            onClick={() => void decide("confirm")}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md bg-primary px-3 text-sm text-primary-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50"
          >
            <Check aria-hidden className="size-4" />
            {t("confirm")}
          </button>
          <button
            type="button"
            aria-disabled={submitting || undefined}
            onClick={() => void decide("cancel")}
            className="inline-flex min-h-10 items-center gap-1.5 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50"
          >
            <X aria-hidden className="size-4" />
            {t("cancel")}
          </button>
        </div>
      ) : (retryable || retrying) && !superseded ? (
        // The retry button stays in place while the repeat is in flight, so
        // keyboard focus never falls off the card.
        <button
          type="button"
          aria-disabled={retrying || undefined}
          aria-busy={retrying || undefined}
          onClick={() => void decide(lastDecisionRef.current, true)}
          className="mt-2 inline-flex min-h-10 items-center gap-1.5 rounded-md border bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-disabled:opacity-50"
        >
          <RotateCcw aria-hidden className="size-4" />
          {t("tryAgain")}
        </button>
      ) : null}
      {d.tool === "proposeBusinessDnaUpdate" && state === "done" ? (
        <Link
          href="/settings/business-dna"
          className="mt-1 inline-flex min-h-10 items-center text-xs text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("businessDna.review")}
        </Link>
      ) : null}
    </section>
  );
}
