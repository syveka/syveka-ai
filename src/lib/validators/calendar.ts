import { z } from "zod";

const optionalTrimmed = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined));

const uuidOrEmpty = z
  .string()
  .optional()
  .or(z.literal(""))
  .transform((v) => (v ? v : undefined))
  .pipe(z.string().uuid().optional());

/** One attendee row submitted with the event form (JSON-encoded field). */
export const attendeeSchema = z.object({
  contactId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
  email: z.string().email().max(320).optional(),
  name: z.string().max(200).optional(),
});

export const eventSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: optionalTrimmed(2000),
    location: optionalTrimmed(200),
    timezone: z.string().min(1).max(64).default("Europe/Helsinki"),
    startsAt: z.string().min(1),
    endsAt: z.string().min(1),
    allDay: z.coerce.boolean().default(false),
    recurrenceRule: optionalTrimmed(200),
    contactId: uuidOrEmpty,
    companyId: uuidOrEmpty,
    dealId: uuidOrEmpty,
    ownerId: uuidOrEmpty,
    attendees: z
      .string()
      .optional()
      .or(z.literal(""))
      .transform((v, ctx) => {
        if (!v) return [] as z.infer<typeof attendeeSchema>[];
        try {
          const parsed: unknown = JSON.parse(v);
          return z.array(attendeeSchema).max(50).parse(parsed);
        } catch {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid attendees" });
          return z.NEVER;
        }
      }),
  })
  .refine((v) => !Number.isNaN(new Date(v.startsAt).getTime()), {
    message: "Invalid start",
    path: ["startsAt"],
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: "End must be after start",
    path: ["endsAt"],
  });

export type EventInput = z.infer<typeof eventSchema>;

export const eventFiltersSchema = z.object({
  view: z.enum(["day", "week", "month", "agenda"]).default("month"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  q: z.string().max(200).optional(),
  ownerId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  dealId: z.string().uuid().optional(),
  source: z.enum(["MANUAL", "VOICE_AI", "WORKFLOW", "BOOKING", "GOOGLE", "OUTLOOK"]).optional(),
});

export type EventFilters = z.infer<typeof eventFiltersSchema>;
