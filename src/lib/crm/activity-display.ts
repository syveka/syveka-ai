import { stageLabel, type DefaultStageKey } from "@/lib/crm/stage-labels";

/**
 * Display-time localization of system-generated CRM timeline entries.
 *
 * Some activities are written by the system with a fixed text pattern (stage
 * changes: "Uusi liidi → Tarjous"; bookings: "Booking: Intro call"). That text
 * is stored data and is never rewritten. It is shown in the interface language
 * only when the entry is provably one of those system patterns:
 *
 * - STAGE_CHANGE: the metadata names both stages, both still exist, and the
 *   stored subject is exactly "<from name> → <to name>" with their CURRENT
 *   names. Each side is then labelled with stageLabel(), so only untouched
 *   seeded default stages are translated; renamed and custom stage names, and
 *   entries written under an earlier name, are shown as stored.
 * - MEETING with booking metadata (`kind` booked/canceled/rescheduled and a
 *   `bookingId`): the subject has the exact system prefix; the booking type
 *   name, guest name, e-mail, meeting time and cancellation reason are
 *   inserted verbatim. Both the current patterns (with the meeting time,
 *   "New booking: …") and the earlier ones are recognized, so older entries
 *   keep localizing. A body that does not match an exact system pattern is
 *   shown as stored.
 *
 * Anything else (notes, user-written subjects, AI summaries) is returned
 * unchanged.
 */
export type SystemActivityMessageKey =
  | "stageChange"
  | "bookingBookedSubject"
  | "bookingBookedBody"
  | "bookingCanceledSubject"
  | "bookingCanceledBody"
  | "bookingCanceledBodyWithReason"
  | "bookingRescheduledSubject"
  | "bookingRescheduledBody"
  | "bookingBookedBodyAt"
  | "bookingCanceledBodyAt"
  | "bookingCanceledBodyAtWithReason"
  | "bookingRescheduledBodyFromTo";

export type ActivityStage = {
  id: string;
  name: string;
  order: number;
  isWon: boolean;
  isLost: boolean;
};

export type DisplayableActivity = {
  type: string;
  subject: string;
  body?: string | null;
  metadata?: unknown;
};

export type ActivityDisplayContext = {
  translate: (key: SystemActivityMessageKey, values: Record<string, string>) => string;
  stageName: (key: DefaultStageKey) => string;
  stagesById?: ReadonlyMap<string, ActivityStage>;
};

/** Stored subject prefixes per kind, current first ("Booking: " is the earlier form). */
const BOOKING_SUBJECT_PREFIXES = {
  booked: ["New booking: ", "Booking: "],
  canceled: ["Booking canceled: "],
  rescheduled: ["Booking rescheduled: "],
} as const;

type BookingKind = keyof typeof BOOKING_SUBJECT_PREFIXES;

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  return metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function isBookingKind(value: unknown): value is BookingKind {
  return value === "booked" || value === "canceled" || value === "rescheduled";
}

function localizedStageChange(
  activity: DisplayableActivity,
  ctx: ActivityDisplayContext,
): string | null {
  const meta = metadataRecord(activity.metadata);
  if (!meta || !ctx.stagesById) return null;
  const from =
    typeof meta.fromStageId === "string" ? ctx.stagesById.get(meta.fromStageId) : undefined;
  const to = typeof meta.toStageId === "string" ? ctx.stagesById.get(meta.toStageId) : undefined;
  if (!from || !to || activity.subject !== `${from.name} → ${to.name}`) return null;
  const fromLabel = stageLabel(from, ctx.stageName);
  const toLabel = stageLabel(to, ctx.stageName);
  if (fromLabel === from.name && toLabel === to.name) return null;
  return ctx.translate("stageChange", { from: fromLabel, to: toLabel });
}

function localizedBookingBody(
  kind: BookingKind,
  body: string,
  typeName: string,
  ctx: ActivityDisplayContext,
): string | null {
  if (kind === "booked") {
    // "<guest> (<email>) booked <type> for <time>." or the earlier "... booked <type>."
    const guestAndEmail = (head: string) => /^([\s\S]+) \(([^()\s]+)\)$/.exec(head);
    const timed = ` booked ${typeName} for `;
    const at = body.indexOf(timed);
    if (at > 0 && body.endsWith(".")) {
      const match = guestAndEmail(body.slice(0, at));
      const time = body.slice(at + timed.length, -1);
      if (match && time) {
        return ctx.translate("bookingBookedBodyAt", {
          guest: match[1]!,
          email: match[2]!,
          type: typeName,
          time,
        });
      }
      return null;
    }
    const suffix = ` booked ${typeName}.`;
    if (!body.endsWith(suffix)) return null;
    const match = guestAndEmail(body.slice(0, -suffix.length));
    if (!match) return null;
    return ctx.translate("bookingBookedBody", {
      guest: match[1]!,
      email: match[2]!,
      type: typeName,
    });
  }
  if (kind === "rescheduled") {
    // "<guest> moved the meeting from <old> to <new>." or the earlier "... moved the meeting."
    const fromTo = /^([\s\S]+) moved the meeting from ([\s\S]+?) to ([\s\S]+)\.$/.exec(body);
    if (fromTo) {
      return ctx.translate("bookingRescheduledBodyFromTo", {
        guest: fromTo[1]!,
        from: fromTo[2]!,
        to: fromTo[3]!,
      });
    }
    const suffix = " moved the meeting.";
    if (!body.endsWith(suffix) || body.length === suffix.length) return null;
    return ctx.translate("bookingRescheduledBody", { guest: body.slice(0, -suffix.length) });
  }
  // "<guest> canceled the meeting on <time>.[ Reason: <reason>]" or the earlier
  // "<guest> canceled.[ Reason: <reason>]".
  const reasonPrefix = " Reason: ";
  const timedMarker = " canceled the meeting on ";
  const timedAt = body.indexOf(timedMarker);
  if (timedAt > 0) {
    const guest = body.slice(0, timedAt);
    const rest = body.slice(timedAt + timedMarker.length);
    const end = rest.indexOf(".");
    // Times are written as "YYYY-MM-DD HH:MM (Zone/Name)" and contain no ".".
    if (end <= 0) return null;
    const time = rest.slice(0, end);
    const after = rest.slice(end + 1);
    if (after === "") return ctx.translate("bookingCanceledBodyAt", { guest, time });
    if (!after.startsWith(reasonPrefix) || after.length === reasonPrefix.length) return null;
    return ctx.translate("bookingCanceledBodyAtWithReason", {
      guest,
      time,
      reason: after.slice(reasonPrefix.length),
    });
  }
  const marker = " canceled.";
  const at = body.indexOf(marker);
  if (at <= 0) return null;
  const guest = body.slice(0, at);
  const rest = body.slice(at + marker.length);
  if (rest === "") return ctx.translate("bookingCanceledBody", { guest });
  if (!rest.startsWith(reasonPrefix) || rest.length === reasonPrefix.length) return null;
  return ctx.translate("bookingCanceledBodyWithReason", {
    guest,
    reason: rest.slice(reasonPrefix.length),
  });
}

function localizedBooking(
  activity: DisplayableActivity,
  ctx: ActivityDisplayContext,
): { subject: string; body: string | null } | null {
  if (activity.type !== "MEETING") return null;
  const meta = metadataRecord(activity.metadata);
  if (!meta || !isBookingKind(meta.kind) || typeof meta.bookingId !== "string") return null;
  const kind = meta.kind;
  const prefix = BOOKING_SUBJECT_PREFIXES[kind].find((p) => activity.subject.startsWith(p));
  if (!prefix || activity.subject.length === prefix.length) return null;
  const typeName = activity.subject.slice(prefix.length);
  const subjectKey = (
    {
      booked: "bookingBookedSubject",
      canceled: "bookingCanceledSubject",
      rescheduled: "bookingRescheduledSubject",
    } as const
  )[kind];
  const body = activity.body ?? null;
  return {
    subject: ctx.translate(subjectKey, { type: typeName }),
    body: body ? (localizedBookingBody(kind, body, typeName, ctx) ?? body) : null,
  };
}

/**
 * Every inserted value (stage names, booking type, guest, e-mail, times,
 * reasons) is wrapped in a Unicode first-strong isolate, so it keeps its own
 * direction: a Latin "Lead → Won" inside the Arabic sentence, or an Arabic
 * name in a Finnish one, can't flip the arrow or move the brackets.
 */
const FSI = "\u2068";
const PDI = "\u2069";

function isolatingValues(ctx: ActivityDisplayContext): ActivityDisplayContext {
  return {
    ...ctx,
    translate: (key, values) =>
      ctx.translate(
        key,
        Object.fromEntries(Object.entries(values).map(([k, v]) => [k, `${FSI}${v}${PDI}`])),
      ),
  };
}

/** Subject and body to show for a timeline entry (stored values unless a known system pattern). */
export function displayActivity(
  activity: DisplayableActivity,
  ctx: ActivityDisplayContext,
): { subject: string; body: string | null } {
  const stored = { subject: activity.subject, body: activity.body ?? null };
  const isolated = isolatingValues(ctx);
  if (activity.type === "STAGE_CHANGE") {
    const subject = localizedStageChange(activity, isolated);
    return subject ? { ...stored, subject } : stored;
  }
  return localizedBooking(activity, isolated) ?? stored;
}
