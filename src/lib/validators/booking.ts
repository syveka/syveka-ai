import { z } from "zod";

const optionalTrimmed = (max: number) =>
  z
    .string()
    .max(max)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined));

const MINUTE_MAX = 24 * 60;

export const weeklyRuleSchema = z
  .object({
    weekday: z.coerce.number().int().min(0).max(6),
    startMinute: z.coerce
      .number()
      .int()
      .min(0)
      .max(MINUTE_MAX - 1),
    endMinute: z.coerce.number().int().min(1).max(MINUTE_MAX),
  })
  .refine((r) => r.endMinute > r.startMinute, { message: "End before start", path: ["endMinute"] });

export const dateOverrideSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    startMinute: z.coerce
      .number()
      .int()
      .min(0)
      .max(MINUTE_MAX - 1)
      .nullable()
      .default(null),
    endMinute: z.coerce.number().int().min(1).max(MINUTE_MAX).nullable().default(null),
    isUnavailable: z.coerce.boolean().default(false),
  })
  .refine(
    (o) =>
      o.isUnavailable ||
      (o.startMinute !== null && o.endMinute !== null && o.endMinute > o.startMinute),
    { message: "Provide a valid window or mark unavailable", path: ["endMinute"] },
  );

export const availabilityScheduleSchema = z.object({
  name: z.string().min(1).max(100),
  timezone: z.string().min(1).max(64),
  isDefault: z.coerce.boolean().default(false),
  rules: z.string().transform((v, ctx) => {
    try {
      return z
        .array(weeklyRuleSchema)
        .max(50)
        .parse(JSON.parse(v || "[]"));
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid rules" });
      return z.NEVER;
    }
  }),
  overrides: z
    .string()
    .optional()
    .or(z.literal(""))
    .transform((v, ctx) => {
      try {
        return z
          .array(dateOverrideSchema)
          .max(100)
          .parse(JSON.parse(v || "[]"));
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid overrides" });
        return z.NEVER;
      }
    }),
});

export type AvailabilityScheduleInput = z.infer<typeof availabilityScheduleSchema>;

export const SLUG_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const bookingTypeSchema = z.object({
  slug: z.string().min(2).max(60).regex(SLUG_REGEX, "Lowercase letters, numbers and dashes"),
  name: z.string().min(1).max(120),
  description: optionalTrimmed(1000),
  durationMinutes: z.coerce.number().int().min(5).max(480).default(30),
  durationOptions: z
    .string()
    .optional()
    .or(z.literal(""))
    .transform((v, ctx) => {
      if (!v) return [] as number[];
      try {
        return z.array(z.coerce.number().int().min(5).max(480)).max(6).parse(JSON.parse(v));
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid duration options" });
        return z.NEVER;
      }
    }),
  locationType: z.enum(["VIDEO", "PHONE", "IN_PERSON", "CUSTOM"]).default("VIDEO"),
  location: optionalTrimmed(300),
  bufferBeforeMinutes: z.coerce.number().int().min(0).max(240).default(0),
  bufferAfterMinutes: z.coerce.number().int().min(0).max(240).default(0),
  minNoticeMinutes: z.coerce
    .number()
    .int()
    .min(0)
    .max(30 * 24 * 60)
    .default(120),
  maxWindowDays: z.coerce.number().int().min(1).max(365).default(60),
  brandColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined)),
  confirmationMessage: optionalTrimmed(1000),
  collectPhone: z.coerce.boolean().default(false),
  collectCompany: z.coerce.boolean().default(false),
  requiresConsent: z.coerce.boolean().default(true),
  isActive: z.coerce.boolean().default(true),
  scheduleId: z
    .string()
    .optional()
    .or(z.literal(""))
    .transform((v) => (v ? v : undefined))
    .pipe(z.string().uuid().optional()),
});

export type BookingTypeInput = z.infer<typeof bookingTypeSchema>;

/** Public guest booking payload — strictly validated, rate-limited upstream. */
export const publicBookingSchema = z.object({
  startsAt: z.string().datetime(),
  durationMinutes: z.coerce.number().int().min(5).max(480).optional(),
  timezone: z.string().min(1).max(64),
  name: z.string().min(1).max(200),
  email: z.string().email().max(320),
  phone: optionalTrimmed(40),
  company: optionalTrimmed(200),
  notes: optionalTrimmed(2000),
  consent: z.coerce.boolean().default(false),
  locale: z.enum(["en", "fi", "ar"]).optional(),
  /** Honeypot — must stay empty; bots fill it. */
  website: z.literal("").optional().or(z.undefined()),
});

export type PublicBookingInput = z.infer<typeof publicBookingSchema>;

export const publicRescheduleSchema = z.object({
  startsAt: z.string().datetime(),
  timezone: z.string().min(1).max(64).optional(),
});

export const publicCancelSchema = z.object({
  reason: optionalTrimmed(500),
});
