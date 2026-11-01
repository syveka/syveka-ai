import { workflowRunFailure, type WorkflowRunFailure } from "@/lib/workflows/run-failure";

export const BOOKING_NOTIFICATION_KINDS = [
  "confirmation",
  "reschedule",
  "cancellation",
  "reminder",
] as const;
export type BookingNotificationKind = (typeof BOOKING_NOTIFICATION_KINDS)[number];

/**
 * The action that starts a booking notification's stored title ("New booking:
 * Intro call — Anna"), in the owner's profile language when the row was
 * written. Readers use the same words to recognise rows of any language.
 */
export const BOOKING_NOTIFICATION_ACTIONS: Record<
  "en" | "fi" | "ar",
  Record<BookingNotificationKind, string>
> = {
  en: {
    confirmation: "New booking",
    reschedule: "Booking rescheduled",
    cancellation: "Booking canceled",
    reminder: "Upcoming meeting",
  },
  fi: {
    confirmation: "Uusi varaus",
    reschedule: "Varaus siirretty",
    cancellation: "Varaus peruttu",
    reminder: "Tuleva tapaaminen",
  },
  ar: {
    confirmation: "حجز جديد",
    reschedule: "تمت إعادة جدولة الحجز",
    cancellation: "تم إلغاء الحجز",
    reminder: "اجتماع قادم",
  },
};

/**
 * How a stored notification is shown. Rows keep their stored text; this only
 * decides what the viewer's language can safely replace at display time:
 *
 * - `workflow_failed`: the title is the workflow's name, the body the job's
 *   failure text, shown as the same translated reason as Run history.
 * - `booking`: the action word is shown in the viewer's language and the
 *   booking type and guest name as isolated user data. The body (the
 *   meeting time) was formatted when the row was written and stays as it is.
 * - `plain`: anything else, exactly as stored.
 */
export type NotificationDisplay =
  | { kind: "workflow_failed"; workflowName: string; failure: WorkflowRunFailure }
  | {
      kind: "booking";
      action: BookingNotificationKind;
      bookingType: string;
      guest: string;
      body: string | null;
    }
  | { kind: "plain"; title: string; body: string | null };

export function displayNotification(n: {
  type: string;
  title: string;
  body: string | null;
}): NotificationDisplay {
  if (n.type === "workflow.failed") {
    return {
      kind: "workflow_failed",
      workflowName: n.title,
      failure: workflowRunFailure(n.body) ?? "internal",
    };
  }
  const action = n.type.startsWith("booking.") ? n.type.slice("booking.".length) : null;
  if (action && (BOOKING_NOTIFICATION_KINDS as readonly string[]).includes(action)) {
    const kind = action as BookingNotificationKind;
    for (const words of Object.values(BOOKING_NOTIFICATION_ACTIONS)) {
      const prefix = `${words[kind]}: `;
      if (!n.title.startsWith(prefix)) continue;
      const rest = n.title.slice(prefix.length);
      const split = rest.lastIndexOf(" — ");
      if (split < 0) break;
      return {
        kind: "booking",
        action: kind,
        bookingType: rest.slice(0, split),
        guest: rest.slice(split + " — ".length),
        body: n.body,
      };
    }
  }
  return { kind: "plain", title: n.title, body: n.body };
}
