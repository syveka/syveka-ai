import "server-only";

import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { tenantDb } from "@/server/db/tenant";
import { retrieveChunks } from "@/server/ai/rag";
import { can, type Permission } from "@/server/auth/permissions";
import type { Role } from "@prisma/client";
import { audit } from "@/server/services/audit";

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

type ToolDef<S extends z.ZodTypeAny> = {
  name: string;
  description: string;
  schema: S;
  permission: Permission;
  execute: (identity: ToolIdentity, input: z.infer<S>) => Promise<unknown>;
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
        id: true, firstName: true, lastName: true, email: true,
        phone: true, status: true, title: true,
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

const getCalendarAvailability = defineTool({
  name: "getCalendarAvailability",
  description:
    "Get free 30-minute booking slots for a given date (ISO yyyy-mm-dd) during business hours (09–17 Europe/Helsinki).",
  schema: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  permission: "calendar:read",
  execute: async (id, input) => {
    const db = tenantDb(id.orgId);
    const dayStart = new Date(`${input.date}T06:00:00.000Z`); // 09:00 EEST
    const dayEnd = new Date(`${input.date}T14:00:00.000Z`); // 17:00 EEST

    const events = await db.calendarEvent.findMany({
      where: { startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } },
      select: { startsAt: true, endsAt: true },
    });

    const slots: string[] = [];
    for (let t = dayStart.getTime(); t + 30 * 60_000 <= dayEnd.getTime(); t += 30 * 60_000) {
      const s = t;
      const e = t + 30 * 60_000;
      const busy = events.some((ev) => ev.startsAt.getTime() < e && ev.endsAt.getTime() > s);
      if (!busy) slots.push(new Date(s).toISOString());
    }
    return { date: input.date, freeSlots: slots.slice(0, 12) };
  },
});

const bookMeeting = defineTool({
  name: "bookMeeting",
  description:
    "Book a meeting into the company calendar. Only after the user/caller confirmed the slot.",
  schema: z.object({
    title: z.string().min(1).max(200),
    startsAt: z.string().datetime(),
    durationMinutes: z.number().int().min(15).max(240).default(30),
    contactId: z.string().uuid().optional(),
    notes: z.string().max(2000).optional(),
  }),
  permission: "calendar:write",
  execute: async (id, input) => {
    const db = tenantDb(id.orgId);
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(startsAt.getTime() + input.durationMinutes * 60_000);

    const conflict = await db.calendarEvent.findFirst({
      where: { startsAt: { lt: endsAt }, endsAt: { gt: startsAt } },
    });
    if (conflict) return { booked: false, reason: "slot_taken" };

    const event = await db.calendarEvent.create({
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
    await audit(
      { orgId: id.orgId, userId: id.userId },
      {
        action: "calendar.book",
        resourceType: "calendar_event",
        resourceId: event.id,
        actorType: id.actorType,
        after: { title: input.title, startsAt: input.startsAt },
      },
    );
    return { booked: true, eventId: event.id, startsAt: input.startsAt };
  },
});

export const TOOL_REGISTRY = [
  searchKnowledgeBase,
  searchContacts,
  createContact,
  logActivity,
  getCalendarAvailability,
  bookMeeting,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
] as Array<ToolDef<any>>;

/** Tools the acting identity may use, in Anthropic tool format. */
export function anthropicToolsFor(identity: ToolIdentity, enabledNames?: string[]): Anthropic.Tool[] {
  return TOOL_REGISTRY.filter(
    (t) =>
      can(identity.role, t.permission) && (!enabledNames || enabledNames.includes(t.name)),
  ).map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: zodToJsonSchema(t.schema) as Anthropic.Tool.InputSchema,
  }));
}

/** Validated, permission-checked execution. Returns JSON string for the model. */
export async function executeTool(
  identity: ToolIdentity,
  name: string,
  rawInput: unknown,
): Promise<string> {
  const tool = TOOL_REGISTRY.find((t) => t.name === name);
  if (!tool) return JSON.stringify({ error: "unknown_tool" });
  if (!can(identity.role, tool.permission)) {
    return JSON.stringify({ error: "permission_denied" });
  }
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    return JSON.stringify({ error: "invalid_input", details: parsed.error.issues.slice(0, 3) });
  }
  try {
    const result = await tool.execute(identity, parsed.data);
    return JSON.stringify(result);
  } catch (e) {
    return JSON.stringify({ error: "execution_failed", message: e instanceof Error ? e.message : "" });
  }
}

/** Minimal Zod→JSON-Schema for our flat tool schemas (no extra dependency). */
export function zodToJsonSchema(schema: z.ZodTypeAny): object {
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodTypeAny>;
    const properties: Record<string, object> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      let v = value;
      let optional = false;
      while (v instanceof z.ZodOptional || v instanceof z.ZodDefault) {
        if (v instanceof z.ZodOptional) optional = true;
        v = v._def.innerType as z.ZodTypeAny;
      }
      properties[key] = leafSchema(v);
      if (!optional && !(value instanceof z.ZodDefault)) required.push(key);
    }
    return { type: "object", properties, required };
  }
  return { type: "object", properties: {} };
}

function leafSchema(v: z.ZodTypeAny): object {
  if (v instanceof z.ZodString) return { type: "string" };
  if (v instanceof z.ZodNumber) return { type: "number" };
  if (v instanceof z.ZodBoolean) return { type: "boolean" };
  if (v instanceof z.ZodEnum) return { type: "string", enum: v.options };
  return { type: "string" };
}
