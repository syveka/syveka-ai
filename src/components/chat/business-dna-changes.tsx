"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type {
  BusinessDnaChange,
  BusinessDnaDisplayValue,
} from "@/lib/validators/business-dna-patch";

/**
 * The Business DNA changes an AI action would make, shown in full: every
 * field with its value before and after. Labels come from the Business DNA
 * settings page, so chat and the form name fields the same way. Values are
 * the user's own text, in whatever language they wrote it (`dir="auto"`).
 */
export function BusinessDnaChanges({ changes }: { changes: BusinessDnaChange[] }) {
  const t = useTranslations("chat.actions.businessDna");
  const field = useTranslations("businessDna");

  const label = (name: BusinessDnaChange["field"]) =>
    name === "openingHours" ? field("sections.openingHours") : field(`fields.${name}`);

  const value = (v: BusinessDnaDisplayValue) => {
    if (v.type === "text") return <span dir="auto">{v.value}</span>;
    if (v.type === "list") {
      return (
        <ul className="list-inside list-disc">
          {v.items.map((item, i) => (
            <li key={i} dir="auto">
              {item}
            </li>
          ))}
        </ul>
      );
    }
    return (
      <ul>
        {v.days.map((d) => (
          <li key={d.day}>
            {field(`weekdays.${d.day}`)}:{" "}
            {d.closed ? field("closed") : <bdi dir="ltr">{`${d.open}–${d.close}`}</bdi>}
          </li>
        ))}
      </ul>
    );
  };

  return (
    <ul data-testid="business-dna-changes" className="mt-1 space-y-1.5">
      {changes.map((c) => (
        <li key={c.field} className="rounded border border-border/50 bg-muted/40 p-1.5 text-xs">
          <p className="flex flex-wrap items-center gap-1.5 font-medium">
            {label(c.field)}
            <span
              className={cn(
                "rounded px-1 text-[0.7rem] font-normal",
                c.kind === "removed"
                  ? "bg-destructive/10 text-destructive"
                  : "bg-primary/10 text-primary",
              )}
            >
              {t(`kind.${c.kind}`)}
            </span>
          </p>
          {c.before ? (
            <div className="mt-0.5 text-muted-foreground">
              <span className="me-1">{t("before")}</span>
              <div
                className={cn(
                  "whitespace-pre-wrap break-words",
                  c.kind === "removed" && "line-through",
                )}
              >
                {value(c.before)}
              </div>
            </div>
          ) : null}
          {c.after ? (
            <div className="mt-0.5">
              <span className="me-1 text-muted-foreground">{t("after")}</span>
              <div className="whitespace-pre-wrap break-words">{value(c.after)}</div>
            </div>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
