"use client";

import { useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Check, ShieldCheck, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ProposedActionView } from "@/lib/validators/chat";

type State =
  | "pending"
  | "submitting"
  | "done"
  | "canceled"
  | "slotTaken"
  | "expired"
  | "alreadyDecided"
  | "permission"
  | "failed";

const REFUSAL_STATE: Record<string, State> = {
  not_found: "expired",
  already_decided: "alreadyDecided",
  mismatch: "failed",
  permission_denied: "permission",
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
 * A write the assistant proposed. Nothing happens until the user confirms
 * here; the server then runs exactly this action, once.
 */
export function ActionConfirmation({ action }: { action: ProposedActionView }) {
  const t = useTranslations("chat.actions");
  const locale = useLocale();
  const [state, setState] = useState<State>(() =>
    action.expiresAt <= Date.now() ? "expired" : "pending",
  );
  const d = action.details;
  // One decision per card: a fast double click must not send a second request.
  const sentRef = useRef(false);

  const summary =
    d.tool === "createContact"
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

  const decide = async (decision: "confirm" | "cancel") => {
    if (state !== "pending" || sentRef.current) return;
    sentRef.current = true;
    setState("submitting");
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
        data?: { status?: string };
        error?: { code?: string };
      } | null;
      if (res.ok && body?.data?.status) {
        setState(
          body.data.status === "canceled"
            ? "canceled"
            : body.data.status === "not_done"
              ? "slotTaken"
              : "done",
        );
        return;
      }
      setState(REFUSAL_STATE[body?.error?.code ?? ""] ?? "failed");
    } catch {
      setState("failed");
    }
  };

  const busy = state === "submitting";
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
        <p
          role="status"
          className={cn(
            "mt-2 text-xs",
            state === "done" ? "text-success" : "text-muted-foreground",
            (state === "failed" || state === "permission") && "text-destructive",
          )}
        >
          {t(`result.${state}`)}
        </p>
      )}
    </section>
  );
}
