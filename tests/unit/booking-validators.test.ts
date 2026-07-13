import { describe, expect, it } from "vitest";
import {
  availabilityScheduleSchema,
  bookingTypeSchema,
  publicBookingSchema,
  weeklyRuleSchema,
} from "@/lib/validators/booking";
import { eventSchema } from "@/lib/validators/calendar";

describe("publicBookingSchema", () => {
  const valid = {
    startsAt: "2026-02-02T07:00:00.000Z",
    timezone: "Europe/Helsinki",
    name: "Guest",
    email: "guest@example.com",
    consent: "true",
  };

  it("accepts a minimal valid payload", () => {
    const parsed = publicBookingSchema.parse(valid);
    expect(parsed.consent).toBe(true);
    expect(parsed.phone).toBeUndefined();
  });

  it("rejects bad emails and missing names", () => {
    expect(publicBookingSchema.safeParse({ ...valid, email: "nope" }).success).toBe(false);
    expect(publicBookingSchema.safeParse({ ...valid, name: "" }).success).toBe(false);
  });

  it("honeypot: any value in `website` fails validation", () => {
    expect(publicBookingSchema.safeParse({ ...valid, website: "http://spam" }).success).toBe(false);
    expect(publicBookingSchema.safeParse({ ...valid, website: "" }).success).toBe(true);
  });

  it("rejects non-ISO start times", () => {
    expect(publicBookingSchema.safeParse({ ...valid, startsAt: "tomorrow" }).success).toBe(false);
  });
});

describe("weekly rules and schedules", () => {
  it("rejects inverted windows", () => {
    expect(
      weeklyRuleSchema.safeParse({ weekday: 1, startMinute: 600, endMinute: 540 }).success,
    ).toBe(false);
  });

  it("parses JSON-encoded rules from form data", () => {
    const parsed = availabilityScheduleSchema.parse({
      name: "Default",
      timezone: "Europe/Helsinki",
      rules: JSON.stringify([{ weekday: 1, startMinute: 540, endMinute: 1020 }]),
      overrides: "",
    });
    expect(parsed.rules).toHaveLength(1);
    expect(parsed.overrides).toHaveLength(0);
  });

  it("rejects malformed rule JSON", () => {
    expect(
      availabilityScheduleSchema.safeParse({
        name: "X",
        timezone: "UTC",
        rules: "not-json",
      }).success,
    ).toBe(false);
  });
});

describe("bookingTypeSchema", () => {
  it("enforces slug format", () => {
    const base = { slug: "intro-call", name: "Intro" };
    expect(bookingTypeSchema.safeParse(base).success).toBe(true);
    expect(bookingTypeSchema.safeParse({ ...base, slug: "Intro Call" }).success).toBe(false);
    expect(bookingTypeSchema.safeParse({ ...base, slug: "-bad-" }).success).toBe(false);
  });

  it("applies sane defaults", () => {
    const parsed = bookingTypeSchema.parse({ slug: "demo", name: "Demo" });
    expect(parsed.durationMinutes).toBe(30);
    expect(parsed.minNoticeMinutes).toBe(120);
    expect(parsed.maxWindowDays).toBe(60);
    expect(parsed.requiresConsent).toBe(true);
  });
});

describe("eventSchema attendees", () => {
  const base = {
    title: "Meeting",
    startsAt: "2026-02-02T09:00",
    endsAt: "2026-02-02T10:00",
  };

  it("parses JSON attendees with contact links and guest emails", () => {
    const parsed = eventSchema.parse({
      ...base,
      attendees: JSON.stringify([
        { contactId: "11111111-1111-4111-8111-111111111111" },
        { email: "guest@example.com", name: "Guest" },
      ]),
    });
    expect(parsed.attendees).toHaveLength(2);
  });

  it("rejects end before start", () => {
    expect(
      eventSchema.safeParse({ ...base, startsAt: "2026-02-02T10:00", endsAt: "2026-02-02T09:00" })
        .success,
    ).toBe(false);
  });

  it("rejects malformed attendee JSON", () => {
    expect(eventSchema.safeParse({ ...base, attendees: "{broken" }).success).toBe(false);
  });
});
