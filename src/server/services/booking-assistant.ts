import "server-only";

import { routeModel } from "@/server/ai/router";
import { anthropic } from "@/server/integrations/anthropic";
import { tenantDb } from "@/server/db/tenant";
import { computeAvailableSlots, type WeeklyRule } from "@/server/calendar/slots";
import { DEFAULT_WEEKLY_RULES } from "./booking";
import type { TenantContext } from "@/server/auth/session";

/**
 * Booking Assistant AI (§15 reuse): natural-language scheduling on top of the
 * deterministic availability engine. The model NEVER decides availability —
 * it interprets intent and formats; free slots always come from
 * `computeAvailableSlots`. Every AI call degrades to a deterministic fallback
 * when the provider is unavailable.
 */

export type SuggestedSlot = { startsAt: string; endsAt: string };

async function getOwnerScheduleParts(ctx: TenantContext): Promise<{
  timezone: string;
  rules: WeeklyRule[];
}> {
  const db = tenantDb(ctx.orgId);
  const schedule = await db.availabilitySchedule.findFirst({
    where: { userId: ctx.userId, isDefault: true },
    include: { rules: true },
  });
  if (!schedule) return { timezone: "Europe/Helsinki", rules: DEFAULT_WEEKLY_RULES };
  return {
    timezone: schedule.timezone,
    rules: schedule.rules.map((r) => ({
      weekday: r.weekday,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
    })),
  };
}

/** Deterministic: next free slots for the current user. */
export async function suggestAvailableTimes(
  ctx: TenantContext,
  params: { durationMinutes?: number; daysAhead?: number; limit?: number } = {},
): Promise<{ slots: SuggestedSlot[]; timezone: string }> {
  const duration = params.durationMinutes ?? 30;
  const db = tenantDb(ctx.orgId);
  const now = new Date();
  const to = new Date(now.getTime() + (params.daysAhead ?? 10) * 86_400_000);

  const [parts, events] = await Promise.all([
    getOwnerScheduleParts(ctx),
    db.calendarEvent.findMany({
      where: {
        deletedAt: null,
        status: { not: "CANCELED" },
        OR: [{ ownerId: ctx.userId }, { ownerId: null, createdById: ctx.userId }],
        startsAt: { lt: to },
        endsAt: { gt: now },
      },
      select: { startsAt: true, endsAt: true },
      take: 500,
    }),
  ]);

  const slots = computeAvailableSlots({
    timezone: parts.timezone,
    rules: parts.rules,
    overrides: [],
    busy: events,
    from: now,
    to,
    now,
    durationMinutes: duration,
    minNoticeMinutes: 30,
    maxSlots: params.limit ?? 8,
  });
  return {
    slots: slots.map((s) => ({
      startsAt: s.toISOString(),
      endsAt: new Date(s.getTime() + duration * 60_000).toISOString(),
    })),
    timezone: parts.timezone,
  };
}

/** CRM context block injected into assistant prompts (permission-trimmed upstream). */
async function buildCrmContext(
  ctx: TenantContext,
  entity?: { contactId?: string; dealId?: string },
): Promise<string> {
  if (!entity?.contactId && !entity?.dealId) return "";
  const db = tenantDb(ctx.orgId);
  const lines: string[] = [];
  if (entity.contactId) {
    const contact = await db.contact.findFirst({
      where: { id: entity.contactId, deletedAt: null },
      select: { firstName: true, lastName: true, email: true, title: true, status: true },
    });
    if (contact) {
      lines.push(
        `Contact: ${contact.firstName} ${contact.lastName ?? ""} (${contact.email ?? "no email"}), ${contact.title ?? ""} — status ${contact.status}`,
      );
    }
  }
  if (entity.dealId) {
    const deal = await db.deal.findFirst({
      where: { id: entity.dealId, deletedAt: null },
      select: {
        title: true,
        valueCents: true,
        currency: true,
        expectedCloseAt: true,
        stage: { select: { name: true } },
      },
    });
    if (deal) {
      lines.push(
        `Deal: "${deal.title}" — stage ${deal.stage.name}, value ${(deal.valueCents / 100).toFixed(0)} ${deal.currency}${deal.expectedCloseAt ? `, expected close ${deal.expectedCloseAt.toISOString().slice(0, 10)}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

export type AssistantResult = {
  reply: string;
  suggestedSlots: SuggestedSlot[];
  timezone: string;
  aiUsed: boolean;
};

/**
 * Natural-language scheduling: "book 45 min with Anna next week".
 * The model reads the request + real free slots and answers; if the model is
 * unreachable the caller still gets the slot list with a plain reply.
 */
export async function assistScheduling(
  ctx: TenantContext,
  request: string,
  entity?: { contactId?: string; dealId?: string },
): Promise<AssistantResult> {
  const durationMatch = /(\d{2,3})\s*(?:min|minute|minuutti|دقيقة)/i.exec(request);
  const duration = durationMatch ? Math.min(Number(durationMatch[1]), 240) : 30;

  const { slots, timezone } = await suggestAvailableTimes(ctx, {
    durationMinutes: duration,
    daysAhead: 14,
    limit: 8,
  });

  const fallback: AssistantResult = {
    reply: "",
    suggestedSlots: slots,
    timezone,
    aiUsed: false,
  };
  if (slots.length === 0) return fallback;

  try {
    const crmContext = await buildCrmContext(ctx, entity);
    const route = routeModel("utility");
    const response = await anthropic.messages.create({
      model: route.model,
      max_tokens: route.maxTokens,
      system:
        "You are Syveka's scheduling assistant. You are given a user's scheduling request, " +
        "their real free slots (authoritative — never invent times), and optional CRM context. " +
        "Reply briefly in the user's language: recommend 2-3 of the given slots that best match " +
        "the request. Refer to slots by their ISO start time. Do not fabricate availability.",
      messages: [
        {
          role: "user",
          content: `Request: ${request}\n\nFree slots (${timezone}):\n${slots
            .map((s) => s.startsAt)
            .join("\n")}${crmContext ? `\n\nCRM context:\n${crmContext}` : ""}`,
        },
      ],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    return { reply: text, suggestedSlots: slots, timezone, aiUsed: true };
  } catch {
    return fallback; // provider down → deterministic slots, empty reply
  }
}

/** AI meeting summary with deterministic fallback. */
export async function generateMeetingSummary(
  ctx: TenantContext,
  eventId: string,
): Promise<{ summary: string; followUps: string[]; aiUsed: boolean }> {
  const db = tenantDb(ctx.orgId);
  const event = await db.calendarEvent.findFirst({
    where: { id: eventId, deletedAt: null },
    include: {
      attendeeRecords: { select: { name: true, email: true } },
      booking: { select: { guestName: true, guestCompany: true, guestNotes: true } },
    },
  });
  if (!event) return { summary: "", followUps: [], aiUsed: false };

  const crmContext = await buildCrmContext(ctx, {
    contactId: event.contactId ?? undefined,
    dealId: event.dealId ?? undefined,
  });

  const attendees = event.attendeeRecords
    .map((a) => a.name ?? a.email)
    .filter(Boolean)
    .join(", ");
  const fallbackSummary =
    `${event.title} — ${event.startsAt.toISOString()}` +
    (attendees ? ` with ${attendees}` : "") +
    (event.description ? `. Notes: ${event.description}` : "");
  const fallbackFollowUps = ["Send a recap email", "Log outcomes in the CRM"];

  try {
    const route = routeModel("summary");
    const response = await anthropic.messages.create({
      model: route.model,
      max_tokens: route.maxTokens,
      system:
        "Summarize this meeting for a CRM timeline in 2-3 sentences, then list up to 3 short " +
        "follow-up suggestions. Format: summary paragraph, blank line, then '- ' bullets.",
      messages: [
        {
          role: "user",
          content: `Title: ${event.title}\nWhen: ${event.startsAt.toISOString()} – ${event.endsAt.toISOString()}\nAttendees: ${attendees || "n/a"}\nDescription: ${event.description ?? "n/a"}\nGuest notes: ${event.booking?.guestNotes ?? "n/a"}${crmContext ? `\nCRM:\n${crmContext}` : ""}`,
        },
      ],
    });
    const text = response.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { text: string }).text)
      .join("\n")
      .trim();
    const [summaryPart, ...rest] = text.split("\n\n");
    const followUps = rest
      .join("\n")
      .split("\n")
      .filter((l) => l.trim().startsWith("-"))
      .map((l) => l.replace(/^-\s*/, "").trim())
      .filter(Boolean)
      .slice(0, 3);
    return {
      summary: summaryPart?.trim() || fallbackSummary,
      followUps: followUps.length > 0 ? followUps : fallbackFollowUps,
      aiUsed: true,
    };
  } catch {
    return { summary: fallbackSummary, followUps: fallbackFollowUps, aiUsed: false };
  }
}
