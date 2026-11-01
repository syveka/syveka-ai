import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTranslator } from "next-intl";
import { DEFAULT_PIPELINE_STAGES } from "@/lib/constants";
import {
  displayActivity as isolatedDisplayActivity,
  type ActivityDisplayContext,
  type ActivityStage,
  type DisplayableActivity,
} from "@/lib/crm/activity-display";

/** Inserted values are wrapped in Unicode isolates (asserted below); compare the visible text. */
const unisolate = (s: string) => s.replace(/[\u2068\u2069]/g, "");
const displayActivity = (activity: DisplayableActivity, ctx: ActivityDisplayContext) => {
  const shown = isolatedDisplayActivity(activity, ctx);
  return { subject: unisolate(shown.subject), body: shown.body && unisolate(shown.body) };
};
import { DEFAULT_PIPELINE_NAME, pipelineLabel } from "@/lib/crm/stage-labels";

/**
 * System-written timeline entries (stage changes, bookings) are shown in the
 * interface language only when they provably match their system pattern;
 * stored text is never changed and anything else is shown as stored.
 */
const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));

function contextFor(locale: "en" | "fi" | "ar", stages: ActivityStage[] = STAGES) {
  const t = createTranslator({ locale, messages: load(locale), namespace: "crm" } as never) as (
    key: string,
    values?: Record<string, string>,
  ) => string;
  return {
    translate: (key, values) => t(`systemActivity.${key}`, values),
    stageName: (key) => t(`defaultStages.${key}`),
    stagesById: new Map(stages.map((s) => [s.id, s])),
  } satisfies ActivityDisplayContext;
}

const STAGES: ActivityStage[] = [
  ...DEFAULT_PIPELINE_STAGES.map((s, i) => ({
    id: `stage-${i}`,
    name: s.name,
    order: s.order,
    isWon: "isWon" in s && s.isWon === true,
    isLost: "isLost" in s && s.isLost === true,
  })),
  { id: "custom", name: "Demo booked", order: 6, isWon: false, isLost: false },
];

const stageChange = (from: string, to: string, subject: string) => ({
  type: "STAGE_CHANGE",
  subject,
  body: null,
  metadata: { fromStageId: from, toStageId: to },
});

describe("stage change entries", () => {
  it("translates untouched seeded default stages in EN and AR, keeps FI as stored", () => {
    const entry = stageChange("stage-0", "stage-2", "Uusi liidi → Tarjous");
    expect(displayActivity(entry, contextFor("en")).subject).toBe("New lead → Proposal");
    expect(displayActivity(entry, contextFor("fi")).subject).toBe("Uusi liidi → Tarjous");
    expect(displayActivity(entry, contextFor("ar")).subject).toBe("عميل محتمل جديد ← عرض سعر");
  });

  it("keeps custom stage names verbatim next to a translated default", () => {
    const entry = stageChange("stage-1", "custom", "Yhteydenotto → Demo booked");
    expect(displayActivity(entry, contextFor("en")).subject).toBe("Contacted → Demo booked");
  });

  it("shows the stored text when the stage was renamed after the change", () => {
    const renamed = STAGES.map((s) => (s.id === "stage-2" ? { ...s, name: "Offer sent" } : s));
    const entry = stageChange("stage-0", "stage-2", "Uusi liidi → Tarjous");
    expect(displayActivity(entry, contextFor("en", renamed)).subject).toBe("Uusi liidi → Tarjous");
  });

  it("shows the stored text for deleted stages, missing metadata or a non-matching subject", () => {
    const en = contextFor("en");
    expect(
      displayActivity(stageChange("gone", "stage-2", "Uusi liidi → Tarjous"), en).subject,
    ).toBe("Uusi liidi → Tarjous");
    expect(
      displayActivity({ type: "STAGE_CHANGE", subject: "Uusi liidi → Tarjous", metadata: null }, en)
        .subject,
    ).toBe("Uusi liidi → Tarjous");
    expect(displayActivity(stageChange("stage-0", "stage-2", "edited by hand"), en).subject).toBe(
      "edited by hand",
    );
    // Without stage data nothing can be matched safely.
    expect(
      displayActivity(stageChange("stage-0", "stage-2", "Uusi liidi → Tarjous"), {
        ...en,
        stagesById: undefined,
      }).subject,
    ).toBe("Uusi liidi → Tarjous");
  });

  it("never translates a seeded name at another position or with other flags", () => {
    const moved = STAGES.map((s) => (s.id === "custom" ? { ...s, name: "Tarjous" } : s));
    const entry = stageChange("stage-0", "custom", "Uusi liidi → Tarjous");
    expect(displayActivity(entry, contextFor("en", moved)).subject).toBe("New lead → Tarjous");
  });
});

const booking = (kind: string, subject: string, body: string | null) => ({
  type: "MEETING",
  subject,
  body,
  metadata: { bookingId: "b-1", kind },
});

describe("system booking entries", () => {
  it("isolates every inserted value so a Latin name can't flip an Arabic line (and vice versa)", () => {
    const shown = isolatedDisplayActivity(
      booking("booked", "Booking: Intro call", "Ann Lee (ann@example.test) booked Intro call."),
      contextFor("ar"),
    );
    expect(shown.subject).toBe("حجز جديد: \u2068Intro call\u2069");
    expect(shown.body).toContain("\u2068Ann Lee\u2069");
    expect(shown.body).toContain("(\u2068ann@example.test\u2069)");
    // A user-written entry is untouched: no isolates are added to stored text.
    const note = { type: "NOTE", subject: "Called Ann", body: "Left a message", metadata: null };
    expect(isolatedDisplayActivity(note, contextFor("ar"))).toEqual({
      subject: "Called Ann",
      body: "Left a message",
    });
  });

  it("localizes the booked subject and body, keeping names and e-mail verbatim", () => {
    const entry = booking(
      "booked",
      "Booking: Intro call",
      "Matti Meikäläinen (matti@example.test) booked Intro call.",
    );
    expect(displayActivity(entry, contextFor("fi"))).toEqual({
      subject: "Uusi ajanvaraus: Intro call",
      body: "Matti Meikäläinen (matti@example.test) varasi ajan: Intro call.",
    });
    expect(displayActivity(entry, contextFor("ar")).subject).toBe("حجز جديد: Intro call");
    expect(displayActivity(entry, contextFor("en"))).toEqual({
      subject: "New booking: Intro call",
      body: "Matti Meikäläinen (matti@example.test) booked Intro call.",
    });
  });

  it("localizes the current timed patterns (New booking, meeting times verbatim)", () => {
    const time = "2026-11-02 09:00 (Europe/Helsinki)";
    const booked = booking(
      "booked",
      "New booking: Intro call",
      `Matti Meikäläinen (matti@example.test) booked Intro call for ${time}.`,
    );
    expect(displayActivity(booked, contextFor("fi"))).toEqual({
      subject: "Uusi ajanvaraus: Intro call",
      body: `Matti Meikäläinen (matti@example.test) varasi ajan: Intro call, ${time}.`,
    });
    expect(displayActivity(booked, contextFor("en")).subject).toBe("New booking: Intro call");

    expect(
      displayActivity(
        booking("canceled", "Booking canceled: Demo", `Ann canceled the meeting on ${time}.`),
        contextFor("fi"),
      ).body,
    ).toBe(`Ann perui tapaamisen ${time}.`);
    expect(
      displayActivity(
        booking(
          "canceled",
          "Booking canceled: Demo",
          `Ann canceled the meeting on ${time}. Reason: Sick today`,
        ),
        contextFor("ar"),
      ).body,
    ).toBe(`ألغى Ann الاجتماع المحدد في ${time}. السبب: Sick today`);

    const later = "2026-11-03 14:30 (Europe/Helsinki)";
    expect(
      displayActivity(
        booking(
          "rescheduled",
          "Booking rescheduled: Demo",
          `Ann moved the meeting from ${time} to ${later}.`,
        ),
        contextFor("fi"),
      ).body,
    ).toBe(`Ann siirsi tapaamisen ajasta ${time} aikaan ${later}.`);
  });

  it("keeps a timed body that does not match exactly", () => {
    const entry = booking(
      "canceled",
      "Booking canceled: Demo",
      "Ann canceled the meeting on Monday. Reason:",
    );
    expect(displayActivity(entry, contextFor("fi")).body).toBe(
      "Ann canceled the meeting on Monday. Reason:",
    );
  });

  it("matches what the booking service writes today", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("src/server/services/booking.ts", "utf8"),
    );
    expect(source).toContain("subject: `New booking: ${bookingType.name}`");
    expect(source).toContain("booked ${bookingType.name} for ${activityTime(");
    expect(source).toContain("canceled the meeting on ${activityTime(");
    expect(source).toContain("moved the meeting from ${activityTime(");
  });

  it("localizes cancellations with and without a reason (reason text verbatim)", () => {
    expect(
      displayActivity(
        booking("canceled", "Booking canceled: Demo", "Ann canceled."),
        contextFor("fi"),
      ),
    ).toEqual({ subject: "Ajanvaraus peruttu: Demo", body: "Ann perui varauksen." });
    expect(
      displayActivity(
        booking("canceled", "Booking canceled: Demo", "Ann canceled. Reason: Sick today"),
        contextFor("fi"),
      ).body,
    ).toBe("Ann perui varauksen. Syy: Sick today");
  });

  it("localizes reschedules", () => {
    expect(
      displayActivity(
        booking("rescheduled", "Booking rescheduled: Demo", "Ann moved the meeting."),
        contextFor("ar"),
      ),
    ).toEqual({ subject: "تم تغيير موعد الحجز: Demo", body: "غيّر Ann موعد الاجتماع." });
  });

  it("keeps a body that does not match its exact system pattern", () => {
    const entry = booking("booked", "Booking: Demo", "Edited note about the booking");
    expect(displayActivity(entry, contextFor("fi"))).toEqual({
      subject: "Uusi ajanvaraus: Demo",
      body: "Edited note about the booking",
    });
  });

  it("never touches user-written meetings that merely look like a booking", () => {
    const fi = contextFor("fi");
    const userMeeting = { type: "MEETING", subject: "Booking: lunch", body: null, metadata: null };
    expect(displayActivity(userMeeting, fi).subject).toBe("Booking: lunch");
    // Wrong prefix for the recorded kind, unknown kind, or another type.
    expect(displayActivity(booking("canceled", "Booking: Demo", null), fi).subject).toBe(
      "Booking: Demo",
    );
    expect(displayActivity(booking("other", "Booking: Demo", null), fi).subject).toBe(
      "Booking: Demo",
    );
    expect(
      displayActivity({ ...booking("booked", "Booking: Demo", null), type: "NOTE" }, fi).subject,
    ).toBe("Booking: Demo");
  });

  it("does not mutate the stored entry", () => {
    const entry = booking("booked", "Booking: Demo", "A (a@example.test) booked Demo.");
    const before = JSON.stringify(entry);
    displayActivity(entry, contextFor("fi"));
    expect(JSON.stringify(entry)).toBe(before);
  });
});

describe("default pipeline name", () => {
  it("matches the name organizations are seeded with", () => {
    const seed = fs.readFileSync(
      path.resolve(__dirname, "../../src/server/services/organizations.ts"),
      "utf8",
    );
    expect(seed).toContain(`name: "${DEFAULT_PIPELINE_NAME}"`);
  });

  it("is translated only while untouched on the default pipeline", () => {
    expect(pipelineLabel({ name: "Myyntiputki", isDefault: true }, "Sales pipeline")).toBe(
      "Sales pipeline",
    );
    expect(pipelineLabel({ name: "Myyntiputki", isDefault: false }, "Sales pipeline")).toBe(
      "Myyntiputki",
    );
    expect(pipelineLabel({ name: "Enterprise", isDefault: true }, "Sales pipeline")).toBe(
      "Enterprise",
    );
  });
});
