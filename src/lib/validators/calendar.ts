import { z } from "zod";

export const eventSchema = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string().max(2000).optional().or(z.literal("")),
    location: z.string().max(200).optional().or(z.literal("")),
    startsAt: z.string().min(1),
    endsAt: z.string().min(1),
    allDay: z.coerce.boolean().default(false),
    contactId: z.string().uuid().optional(),
  })
  .refine((v) => new Date(v.endsAt) > new Date(v.startsAt), {
    message: "End must be after start",
    path: ["endsAt"],
  });

export type EventInput = z.infer<typeof eventSchema>;
