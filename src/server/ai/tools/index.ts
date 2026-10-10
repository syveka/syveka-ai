import "server-only";

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { tenantDb, unscopedPrisma } from "@/server/db/tenant";
import { retrieveChunks } from "@/server/ai/rag";
import { can, type Permission } from "@/server/auth/permissions";
import type { Role } from "@/generated/prisma/client/client";
import { audit } from "@/server/services/audit";
import { computeAvailableSlots, type DateOverride, type WeeklyRule } from "@/server/calendar/slots";
import {
  addDaysUtc,
  isValidTimezone,
  localIsoDate,
  zonedTimeToUtc,
} from "@/server/calendar/timezone";
import { lockOrgCalendar } from "@/server/calendar/locks";
import { busyIntervals, busyWindowWhere, recurringSeriesWhere } from "@/server/calendar/busy";
import type { ProposedActionView } from "@/lib/validators/chat";
import { DEFAULT_WEEKLY_RULES } from "@/server/services/booking";
import {
  businessDnaPatchSchema,
  confirmedBusinessDnaPatchSchema,
} from "@/lib/validators/business-dna-patch";
import {
  applyBusinessDnaPatch,
  previewBusinessDnaPatch,
} from "@/server/services/business-dna-patch";

/**
 * Function-calling tool registry (§15.4). Each tool declares:
 * - Zod input schema (validated before execution)
 * - required permission, checked against the ACTING identity's role
 *   (chat user, or the voice assistant's restricted service identity)
 * Mutating tools audit-log with actorType.
 */
export type ToolIdentity = {
  orgId: string;
  userId: string; // acting user, or assistant owner for voice
  role: Role;
  actorType: "user" | "voice_ai";
};

/** The confirmed chat action a write tool runs for, when it runs from one. */
export type ToolActionContext = { actionId?: string; conversationId?: string };

type ToolDef<S extends z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: S;
  /**
   * For a write tool whose confirmed input differs from what the model sends
   * (e.g. it also carries the values the user was shown): the schema of that
   * confirmed input. Only it is accepted when the tool runs; the model's
   * schema never is.
   */
  confirmedSchema?: z.ZodTypeAny;
  permission: Permission;
  execute: (
    identity: ToolIdentity,
    input: z.infer<S>,
    context?: ToolActionContext,
  ) => Promise<unknown>;
};

function defineTool<S extends z.ZodTypeAny>(def: ToolDef<S>): ToolDef<S> {
  return def;
}

const searchKnowledgeBase = defineTool({
  name: "searchKnowledgeBase",
  description:
    "Search the company's internal knowledge base. Use for any question about the company's products, prices, policies or documents.",
  schema: z.object({ query: z.string().min(2).max(500) }),
  permission: "kb:read",
  execute: async (id, input) => {
    const chunks = await retrieveChunks({ orgId: id.orgId, query: input.query, count: 5 });
    return chunks.map((c) => ({ documentId: c.documentId, title: c.title, content: c.content }));
  },
});

const searchContacts = defineTool({
  name: "searchContacts",
  description: "Search CRM contacts by name, email or phone number.",
  schema: z.object({ query: z.string().min(2).max(200) }),
  permission: "crm:read",
  execute: async (id, input) => {
    const db = tenantDb(id.orgId);
    const q = input.query.trim();
    const contacts = await db.contact.findMany({
      where: {
        deletedAt: null,
        OR: [
          { firstName: { contains: q, mode: "insensitive" } },
          { lastName: { contains: q, mode: "insensitive" } },
          { email: { contains: q, mode: "insensitive" } },
          { phone: { contains: q.replace(/\s/g, "") } },
        ],
      },
      take: 5,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        status: true,
        title: true,
      },
    });
    return contacts;
  },
});

const createContact = defineTool({
  name: "createContact",
  description:
    "Create a new CRM contact. Only use after confirming the details with the user/caller.",
  schema: z.object({
    firstName: z.string().min(1).max(100),
    lastName: z.string().max(100).optional(),
    email: z.string().email().optional(),
    phone: z.string().max(30).optional(),
    source: z.string().max(50).default("ai-assistant"),
  }),
  permission: "crm:write",
  execute: async (id, input) => {
    const db = tenantDb(id.orgId);
    const contact = await db.contact.create({
      data: {
        organizationId: id.orgId,
        ...input,
        source: id.actorType === "voice_ai" ? "voice-ai" : input.source,
      },
    });
    await audit(
      { orgId: id.orgId, userId: id.userId },
      {
        action: "contact.create",
        resourceType: "contact",
        resourceId: contact.id,
        actorType: id.actorType,
        after: input,
      },
    );
    return { id: contact.id, created: true };
  },
});

const logActivity = defineTool({
  name: "logActivity",
  description: "Log a note or task on a CRM contact.",
  schema: z.object({
    contactId: z.string().uuid(),
    type: z.enum(["NOTE", "TASK"]),
    subject: z.string().min(1).max(200),
    body: z.string().max(4000).optional(),
    dueAt: z.string().datetime().optional(),
  }),
  permission: "crm:write",
  execute: async (id, input) => {
    const db = tenantDb(id.orgId);
    await db.contact.findFirstOrThrow({ where: { id: input.contactId } }); // tenancy check
    const activity = await db.activity.create({
      data: {
        organizationId: id.orgId,
        contactId: input.contactId,
        type: input.type,
        subject: input.subject,
        body: input.body,
        dueAt: input.dueAt ? new Date(input.dueAt) : undefined,
        userId: id.actorType === "user" ? id.userId : null,
        metadata: { via: id.actorType },
      },
    });
    return { id: activity.id, created: true };
  },
});

/**
 * Reads the organization's actual default `AvailabilitySchedule` (same
 * source of truth the public booking flow uses via `computeAvailableSlots`)
 * rather than assuming fixed hours — a hardcoded "09-17 Europe/Helsinki"
 * window here would be exactly the kind of invented opening-hours fact the
 * platform's prompt rules elsewhere explicitly forbid. Falls back to
 * `DEFAULT_WEEKLY_RULES` (Mon-Fri 09:00-17:00, Europe/Helsinki) only when the
 * org hasn't configured a schedule yet, same fallback booking.ts already
 * uses for booking types with no schedule — and reports that fact back to
 * the caller so the model can caveat it instead of presenting it as real.
 */
async function resolveOrgDefaultSchedule(orgId: string): Promise<{
  timezone: string;
  rules: WeeklyRule[];
  overrides: DateOverride[];
  isOrgConfigured: boolean;
}> {
  const schedule = await tenantDb(orgId).availabilitySchedule.findFirst({
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    include: { rules: true, overrides: true },
  });
  if (!schedule) {
    return {
      timezone: "Europe/Helsinki",
      rules: DEFAULT_WEEKLY_RULES,
      overrides: [],
      isOrgConfigured: false,
    };
  }
  return {
    timezone: isValidTimezone(schedule.timezone) ? schedule.timezone : "Europe/Helsinki",
    rules: schedule.rules.map((r) => ({
      weekday: r.weekday,
      startMinute: r.startMinute,
      endMinute: r.endMinute,
    })),
    overrides: schedule.overrides.map((o) => ({
      date: o.date.toISOString().slice(0, 10),
      startMinute: o.startMinute,
      endMinute: o.endMinute,
      isUnavailable: o.isUnavailable,
    })),
    isOrgConfigured: true,
  };
}

/**
 * Resolves a named service's real duration from Business DNA - the same
 * source getBusinessDnaContext() already uses to tell the model prices, so
 * a service "entered once in settings" drives both what the AI SAYS about
 * it and what the AI actually books, instead of the model having to guess
 * or default to a fixed 30 minutes regardless of the real service. Case-
 * insensitive exact match on name; returns null (caller falls back to its
 * own default) when no service name is given or no active match exists -
 * never throws, since an unmatched name is a normal case (a custom/one-off
 * meeting with no corresponding catalog service), not an error.
 */
async function resolveServiceDurationMinutes(
  orgId: string,
  serviceName: string | undefined,
): Promise<number | null> {
  if (!serviceName) return null;
  // BusinessDnaService.name has no uniqueness constraint (DB or app-level -
  // see src/server/services/business-dna-services.ts, which never checks
  // for an existing name before creating one) - an org can genuinely have
  // two services sharing a name or differing only by case. Found during PR
  // #91 review: without an explicit orderBy, findFirst's result for a
  // duplicate name is whatever order Postgres happens to return, not
  // guaranteed stable across calls - the AI could resolve a *different*
  // duration for the "same" service name on two separate requests. Ordered
  // the same way listBusinessDnaServices() orders its listing (sortOrder,
  // then name) so at least the choice is deterministic given current data -
  // this does not (and cannot, without a broader product decision on
  // whether duplicate service names should be allowed at all) fully
  // resolve the ambiguity itself.
  const service = await tenantDb(orgId).businessDnaService.findFirst({
    where: { isActive: true, name: { equals: serviceName, mode: "insensitive" } },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }, { createdAt: "asc" }],
    select: { durationMinutes: true },
  });
  return service?.durationMinutes ?? null;
}

const getCalendarAvailability = defineTool({
  name: "getCalendarAvailability",
  description:
    "Get free booking slots for a given date (ISO yyyy-mm-dd). Pass serviceName (matching a name from the business's services) whenever the customer is asking about a specific service, so slots reflect its real duration - otherwise defaults to 30-minute slots. Computed from the organization's actual configured availability schedule (or a generic Mon-Fri 09:00-17:00 default if none is configured yet — the response flags which one was used).",
  schema: z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    serviceName: z.string().max(200).optional(),
  }),
  permission: "calendar:read",
  execute: async (id, input) => {
    const db = tenantDb(id.orgId);
    const [year, month, day] = input.date.split("-").map(Number) as [number, number, number];
    const { timezone, rules, overrides, isOrgConfigured } = await resolveOrgDefaultSchedule(
      id.orgId,
    );
    const dayStart = zonedTimeToUtc(year, month, day, 0, timezone);
    const dayEnd = addDaysUtc(dayStart, 1);
    const durationMinutes =
      (await resolveServiceDurationMinutes(id.orgId, input.serviceName)) ?? 30;

    const events = await db.calendarEvent.findMany({
      where: {
        deletedAt: null,
        status: { not: "CANCELED" },
        ...busyWindowWhere(dayStart, dayEnd),
      },
      select: { startsAt: true, endsAt: true, recurrenceRule: true },
      orderBy: { startsAt: "desc" }, // newest first if the cap is reached
      take: 1000,
    });

    const slots = computeAvailableSlots({
      timezone,
      rules,
      overrides,
      busy: busyIntervals(events, dayStart, dayEnd),
      from: dayStart,
      to: dayEnd,
      now: new Date(),
      durationMinutes,
    });

    return {
      date: input.date,
      timezone,
      durationMinutes,
      freeSlots: slots.slice(0, 12).map((s) => s.toISOString()),
      // When false, these are generic default hours, not the org's real
      // schedule — the system prompt instructs the model to caveat this.
      usingOrgConfiguredHours: isOrgConfigured,
    };
  },
});

type BookMeetingResult = { ok: true; eventId: string } | { ok: false; reason: "slot_taken" };

/**
 * Whether `startsAt` is one of the bookable slots of the org's availability schedule on that
 * day (future, inside working hours, aligned to the slot grid) for a meeting of this length.
 * Existing events are checked separately, under the calendar lock.
 */
async function isBookableSlot(orgId: string, startsAt: Date, durationMinutes: number) {
  const { timezone, rules, overrides } = await resolveOrgDefaultSchedule(orgId);
  const [year, month, day] = localIsoDate(startsAt, timezone).split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const dayStart = zonedTimeToUtc(year, month, day, 0, timezone);
  const slots = computeAvailableSlots({
    timezone,
    rules,
    overrides,
    busy: [],
    from: dayStart,
    to: addDaysUtc(dayStart, 1),
    now: new Date(),
    durationMinutes,
  });
  return slots.some((slot) => slot.getTime() === startsAt.getTime());
}

const bookMeeting = defineTool({
  name: "bookMeeting",
  description:
    "Book a meeting into the company calendar. Only after the user/caller confirmed the slot. Pass serviceName (matching a name from the business's services) whenever the booking is for a specific service, so the real service duration is used - only pass an explicit durationMinutes to override that (e.g. a custom/one-off meeting with no matching service); defaults to 30 minutes if neither resolves.",
  schema: z.object({
    title: z.string().min(1).max(200),
    startsAt: z.string().datetime(),
    serviceName: z.string().max(200).optional(),
    durationMinutes: z.number().int().min(15).max(240).optional(),
    contactId: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
  }),
  permission: "calendar:write",
  execute: async (id, input) => {
    // A phone caller is anonymous: they can book only an offered slot (see
    // getCalendarAvailability) and only for the service's own length, never a past, night-time
    // or hours-long hold of their choosing.
    const fromCaller = id.actorType === "voice_ai";
    const durationMinutes =
      (fromCaller ? undefined : input.durationMinutes) ??
      (await resolveServiceDurationMinutes(id.orgId, input.serviceName)) ??
      30;
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(startsAt.getTime() + durationMinutes * 60_000);
    if (fromCaller && !(await isBookableSlot(id.orgId, startsAt, durationMinutes))) {
      return { booked: false, reason: "outside_availability" };
    }

    // Books into the org's single shared calendar (see getCalendarAvailability's
    // matching org-wide busy check, and lockOrgCalendar's comment) - conflicts
    // are checked and serialized organization-wide, not per calendar owner.
    const result = await unscopedPrisma.$transaction(async (tx): Promise<BookMeetingResult> => {
      await lockOrgCalendar(tx, id.orgId);

      const conflict = await tx.calendarEvent.findFirst({
        where: {
          organizationId: id.orgId,
          deletedAt: null,
          status: { not: "CANCELED" },
          startsAt: { lt: endsAt },
          endsAt: { gt: startsAt },
        },
        select: { id: true },
      });
      if (conflict) return { ok: false, reason: "slot_taken" };
      // A recurring series is stored once: check its occurrences too.
      const series = await tx.calendarEvent.findMany({
        where: {
          organizationId: id.orgId,
          deletedAt: null,
          status: { not: "CANCELED" },
          ...recurringSeriesWhere(endsAt),
        },
        select: { startsAt: true, endsAt: true, recurrenceRule: true },
        orderBy: { startsAt: "desc" }, // newest first if the cap is reached
        take: 500,
      });
      if (busyIntervals(series, startsAt, endsAt).length > 0) {
        return { ok: false, reason: "slot_taken" };
      }

      if (input.contactId) {
        // Tenancy check (mirrors logActivity): a model-supplied contactId is
        // untrusted input and CalendarEvent.contactId has no DB-level FK, so
        // nothing else would catch a cross-tenant or nonexistent id here.
        await tx.contact.findFirstOrThrow({
          where: { id: input.contactId, organizationId: id.orgId },
        });
      }

      const event = await tx.calendarEvent.create({
        data: {
          organizationId: id.orgId,
          title: input.title,
          description: input.notes,
          startsAt,
          endsAt,
          contactId: input.contactId,
          createdById: id.userId,
          source: id.actorType === "voice_ai" ? "VOICE_AI" : "MANUAL",
        },
      });
      return { ok: true, eventId: event.id };
    });

    if (!result.ok) return { booked: false, reason: result.reason };

    await audit(
      { orgId: id.orgId, userId: id.userId },
      {
        action: "calendar.book",
        resourceType: "calendar_event",
        resourceId: result.eventId,
        actorType: id.actorType,
        after: { title: input.title, startsAt: input.startsAt },
      },
    );
    return { booked: true, eventId: result.eventId, startsAt: input.startsAt };
  },
});

/**
 * Changes the organization's Business DNA from what the user says in chat.
 * Like every write tool it never runs on the model's call: the user is shown
 * exactly which fields change (before and after) and confirms. What runs is
 * the confirmed patch, and only while those fields still have the values
 * the user was shown (see src/server/services/business-dna-patch.ts).
 */
const proposeBusinessDnaUpdate = defineTool({
  name: "proposeBusinessDnaUpdate",
  description:
    'Propose changes to the organization\'s Business DNA (its business profile) from facts the user has stated in this conversation. Put new or changed values in `set` and fields to remove in `clear`; leave out every field the user did not talk about. Lists (supportedLocales, keyFacts) are the complete new list, so include existing items that should stay. openingHours: only the days being changed, each either {"closed": true} or {"open": "HH:MM", "close": "HH:MM"} in 24-hour time. timezone is an IANA name (e.g. Europe/Helsinki), currency a 3-letter code (e.g. EUR), supportedLocales uses FI, EN and AR. Keep descriptive text in the user\'s own words and language. Never invent facts. Response instructions and communication style (how Syveka itself should reply) can\'t be changed here: tell the user to change them in the Business DNA settings.',
  schema: businessDnaPatchSchema,
  confirmedSchema: confirmedBusinessDnaPatchSchema,
  permission: "business-dna:write",
  execute: async (id, input, context) => {
    // Only a user's confirmed chat action runs this (decideToolAction passes
    // its id). Any other caller -- a direct model call, or voice, whose
    // service identity has the permission -- could supply a made-up basis.
    if (!context?.actionId || id.actorType !== "user") {
      return { error: "confirmation_required" };
    }
    const confirmed = confirmedBusinessDnaPatchSchema.parse(input);
    const result = await applyBusinessDnaPatch(
      { orgId: id.orgId, userId: id.userId, actorType: id.actorType, source: context },
      confirmed,
    );
    return result.applied
      ? { applied: true, id: result.id, changedFields: result.changedFields }
      : { applied: false, reason: result.reason };
  },
});

export const TOOL_REGISTRY = [
  searchKnowledgeBase,
  searchContacts,
  createContact,
  logActivity,
  getCalendarAvailability,
  bookMeeting,
  proposeBusinessDnaUpdate,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as Array<ToolDef<any>>;

/** Tools the acting identity may use, in Anthropic tool format. */
/**
 * Tools that only read (permission ending in ":read"). Live voice turns are
 * limited to these: an automatically submitted spoken turn — possibly
 * background speech or an ambiguous "yes" — must never create, change, book
 * or send anything.
 */
export const READ_ONLY_TOOL_NAMES: readonly string[] = TOOL_REGISTRY.filter((t) =>
  t.permission.endsWith(":read"),
).map((t) => t.name);

/**
 * Tools that create or change data. In typed chat they never run directly:
 * the call is stored as a pending action and runs only after the user
 * confirms it (see src/server/ai/tool-actions.ts).
 */
export const WRITE_TOOL_NAMES: readonly string[] = TOOL_REGISTRY.filter(
  (t) => !READ_ONLY_TOOL_NAMES.includes(t.name),
).map((t) => t.name);

export function anthropicToolsFor(
  identity: ToolIdentity,
  enabledNames?: string[],
): Anthropic.Tool[] {
  return TOOL_REGISTRY.filter(
    (t) => can(identity.role, t.permission) && (!enabledNames || enabledNames.includes(t.name)),
  ).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.schema) as Anthropic.Tool.InputSchema,
  }));
}

type PreparedTool =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  { ok: true; tool: ToolDef<any>; input: Record<string, unknown> } | { ok: false; error: string };

/**
 * The checks every tool call passes: known tool, role permission, valid
 * input. A model's call ("propose") is checked against the tool's schema;
 * running it ("execute") against its confirmed schema when it has one.
 */
function prepareToolCall(
  identity: ToolIdentity,
  name: string,
  rawInput: unknown,
  phase: "propose" | "execute" = "execute",
): PreparedTool {
  const tool = TOOL_REGISTRY.find((t) => t.name === name);
  if (!tool) return { ok: false, error: JSON.stringify({ error: "unknown_tool" }) };
  if (!can(identity.role, tool.permission)) {
    return { ok: false, error: JSON.stringify({ error: "permission_denied" }) };
  }
  const schema = phase === "execute" && tool.confirmedSchema ? tool.confirmedSchema : tool.schema;
  const parsed = schema.safeParse(rawInput);
  if (!parsed.success) {
    return {
      ok: false,
      error: JSON.stringify({ error: "invalid_input", details: parsed.error.issues.slice(0, 3) }),
    };
  }
  return { ok: true, tool, input: parsed.data as Record<string, unknown> };
}

/** What the user is asked to confirm (no free-form model text; rendered by the client). */
export type WriteActionDetails = ProposedActionView["details"];

const contactName = (c: { firstName: string; lastName: string | null }) =>
  [c.firstName, c.lastName].filter(Boolean).join(" ");

/**
 * Validates a write tool call and resolves exactly what would happen, for
 * the user to confirm: the final input (e.g. a booking's duration resolved
 * now, so what runs is what was shown) and display details. Same checks as
 * executeTool (permission, input) plus tenancy of any referenced contact.
 */
export async function describeWriteToolCall(
  identity: ToolIdentity,
  name: string,
  rawInput: unknown,
): Promise<
  | {
      ok: true;
      tool: string;
      input: Record<string, unknown>;
      details: WriteActionDetails;
      /** Extra facts for the model about the proposal (never the confirmation itself). */
      modelNote?: Record<string, unknown>;
    }
  | { ok: false; error: string }
> {
  if (!WRITE_TOOL_NAMES.includes(name)) {
    return { ok: false, error: JSON.stringify({ error: "unknown_tool" }) };
  }
  const prepared = prepareToolCall(identity, name, rawInput, "propose");
  if (!prepared.ok) return prepared;
  const db = tenantDb(identity.orgId);
  const findContact = async (id: unknown) =>
    typeof id === "string"
      ? db.contact.findFirst({
          where: { id, deletedAt: null },
          select: { firstName: true, lastName: true },
        })
      : null;

  if (name === "proposeBusinessDnaUpdate") {
    const patch = prepared.input as z.infer<typeof businessDnaPatchSchema>;
    const preview = await previewBusinessDnaPatch(identity.orgId, patch);
    if (!preview.ok) return { ok: false, error: JSON.stringify({ error: "no_changes" }) };
    return {
      ok: true,
      tool: name,
      // What runs on confirmation: exactly this patch, bound to the values
      // the user is shown now. The model can't supply them: its schema has
      // no basis, and the confirmed schema accepts nothing else.
      input: { ...patch, basis: preview.basis },
      details: { tool: name, changes: preview.changes, missingAfter: preview.missingAfter },
      modelNote: { missingAfterChange: preview.missingAfter.slice(0, 3) },
    };
  }
  if (name === "createContact") {
    const input = prepared.input as z.infer<typeof createContact.schema>;
    return {
      ok: true,
      tool: name,
      input,
      details: {
        tool: name,
        firstName: input.firstName,
        lastName: input.lastName,
        email: input.email,
        phone: input.phone,
      },
    };
  }
  if (name === "logActivity") {
    const input = prepared.input as z.infer<typeof logActivity.schema>;
    const contact = await findContact(input.contactId);
    if (!contact) return { ok: false, error: JSON.stringify({ error: "contact_not_found" }) };
    return {
      ok: true,
      tool: name,
      input,
      details: {
        tool: name,
        type: input.type,
        subject: input.subject,
        contactName: contactName(contact),
        dueAt: input.dueAt,
        body: input.body,
      },
    };
  }
  const input = prepared.input as z.infer<typeof bookMeeting.schema>;
  const durationMinutes =
    input.durationMinutes ??
    (await resolveServiceDurationMinutes(identity.orgId, input.serviceName)) ??
    30;
  const contact = input.contactId ? await findContact(input.contactId) : null;
  if (input.contactId && !contact) {
    return { ok: false, error: JSON.stringify({ error: "contact_not_found" }) };
  }
  const { timezone } = await resolveOrgDefaultSchedule(identity.orgId);
  return {
    ok: true,
    tool: name,
    // The resolved duration is part of what the user confirms.
    input: { ...input, durationMinutes },
    details: {
      tool: "bookMeeting",
      title: input.title,
      startsAt: input.startsAt,
      durationMinutes,
      timezone,
      contactName: contact ? contactName(contact) : undefined,
      notes: input.notes,
    },
  };
}

/** Validated, permission-checked execution. Returns JSON string for the model. */
export async function executeTool(
  identity: ToolIdentity,
  name: string,
  rawInput: unknown,
  options: { readOnly?: boolean; action?: ToolActionContext } = {},
): Promise<string> {
  if (options.readOnly && !READ_ONLY_TOOL_NAMES.includes(name)) {
    const known = TOOL_REGISTRY.some((t) => t.name === name);
    return JSON.stringify({
      error: known ? "not_available_in_voice_conversation" : "unknown_tool",
    });
  }
  const prepared = prepareToolCall(identity, name, rawInput);
  if (!prepared.ok) return prepared.error;
  const { tool } = prepared;
  try {
    const result = await tool.execute(identity, prepared.input, options.action ?? {});
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({
      error: "execution_failed",
      message: e instanceof Error ? e.message : "",
    });
  }
}

/**
 * Minimal Zod→JSON-Schema for our tool schemas (no extra dependency):
 * objects (also nested), arrays, strings, numbers, booleans and enums.
 * Refinements and transforms aren't described; Zod checks them when the call
 * arrives.
 */
export function zodToJsonSchema(schema: z.ZodTypeAny): object {
  const { type } = unwrap(schema);
  return type instanceof z.ZodObject ? objectSchema(type) : { type: "object", properties: {} };
}

/** The underlying type, and whether the key may be left out. */
function unwrap(schema: z.ZodTypeAny): { type: z.ZodTypeAny; optional: boolean } {
  let type = schema;
  let optional = false;
  for (;;) {
    if (type instanceof z.ZodOptional || type instanceof z.ZodDefault) {
      optional = true;
      type = type._def.innerType as z.ZodTypeAny;
    } else if (type instanceof z.ZodNullable) {
      type = type._def.innerType as z.ZodTypeAny;
    } else if (type instanceof z.ZodEffects) {
      type = type._def.schema as z.ZodTypeAny;
    } else {
      return { type, optional };
    }
  }
}

function objectSchema(schema: z.AnyZodObject): object {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(shape)) {
    const { type, optional } = unwrap(value);
    properties[key] = leafSchema(type);
    if (!optional) required.push(key);
  }
  return { type: "object", properties, required };
}

function leafSchema(v: z.ZodTypeAny): object {
  if (v instanceof z.ZodObject) return objectSchema(v);
  if (v instanceof z.ZodArray) {
    return { type: "array", items: leafSchema(unwrap(v.element as z.ZodTypeAny).type) };
  }
  if (v instanceof z.ZodString) return { type: "string" };
  if (v instanceof z.ZodNumber) return { type: "number" };
  if (v instanceof z.ZodBoolean) return { type: "boolean" };
  if (v instanceof z.ZodEnum) return { type: "string", enum: v.options };
  return { type: "string" };
}
