import "server-only";

import { randomUUID } from "node:crypto";
import { allowedVoiceTools } from "@/lib/validators/voice";
import {
  PILOT_SCRIPT,
  type PilotScenario,
  type PilotTurnInput,
} from "@/lib/voice/fish-pilot-scenarios";
import { TOOL_REGISTRY } from "@/server/ai/tools";

/**
 * Scripted conversation engine for the pilot: no LLM, and every tool writes only to
 * the in-memory state below, never the CRM or calendar. Arguments are checked by the
 * real voice allowlist and the real tool schemas, so this exercises how the booking
 * and CRM tools' contract behaves behind a different voice stack.
 *
 * Identity comes only from the server-verified session the route passes in, and a call
 * belongs to that identity: there is no client-chosen call id to rotate around the caps.
 * This stands in for the phone webhook's signed call id and durable call row, but it
 * doesn't survive a restart or a dev hot reload, so replay protection and write caps here
 * hold only within one server process. No caller text is stored.
 */
export type PilotIdentity = { orgId: string; userId: string };

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 100;
const MAX_TURNS_PER_SESSION = 40;
/** As long as the webhook's tool-call claim, so a call expiring doesn't reopen a replay. */
const TURN_ID_RETENTION_MS = 24 * 60 * 60 * 1000;
const MAX_REMEMBERED_TURNS = 10_000;

/** Mirrors VOICE_CALL_WRITE_CAPS in the Vapi webhook, which a route can't export. */
const WRITE_CAPS: ReadonlyMap<string, number> = new Map([
  ["bookMeeting", 2],
  ["createContact", 2],
  ["logActivity", 5],
]);

/** The tools a pilot assistant has enabled. searchContacts is stored but must be refused. */
const STORED_ENABLED_TOOLS = [
  "createContact",
  "logActivity",
  "getCalendarAvailability",
  "bookMeeting",
  "searchContacts",
];

type Session = {
  expiresAt: number;
  turns: number;
  writes: Map<string, number>;
  contactId: string | null;
};

const sessions = new Map<string, Session>();
const seenTurns = new Map<string, number>();
const contactsByOrg = new Map<string, Set<string>>();
const bookingsByOrg = new Map<string, number>();

export function resetPilotStateForTests(): void {
  sessions.clear();
  seenTurns.clear();
  contactsByOrg.clear();
  bookingsByOrg.clear();
}

/** The contact ids in an organization's mock CRM. */
export function pilotContactsOf(orgId: string): ReadonlySet<string> {
  return contactsByOrg.get(orgId) ?? new Set();
}

export function pilotBookingCountOf(orgId: string): number {
  return bookingsByOrg.get(orgId) ?? 0;
}

function sessionFor(identity: PilotIdentity, now: number): Session | null {
  for (const [key, session] of sessions) {
    if (session.expiresAt <= now) sessions.delete(key);
  }
  const key = `${identity.orgId}:${identity.userId}`;
  const existing = sessions.get(key);
  if (existing) return existing;
  if (sessions.size >= MAX_SESSIONS) return null;
  const created: Session = {
    expiresAt: now + SESSION_TTL_MS,
    turns: 0,
    writes: new Map(),
    contactId: null,
  };
  sessions.set(key, created);
  return created;
}

/** The call as a provider would send it: arguments are an untrusted JSON string. */
type RawToolCall = { name: string; arguments: string };

function plannedToolCalls(
  scenario: PilotScenario,
  session: Session,
  foreignContactId: string,
): RawToolCall[] {
  const call = (name: string, args: unknown): RawToolCall => ({
    name,
    arguments: JSON.stringify(args),
  });
  const thursday = "2026-12-03";
  switch (scenario) {
    case "availability":
      return [call("getCalendarAvailability", { date: thursday })];
    case "contact":
      return [call("createContact", { firstName: "Test", phone: "+358401234567" })];
    case "booking":
      return [
        call("bookMeeting", {
          title: "Pilot booking",
          startsAt: `${thursday}T12:30:00.000Z`,
          ...(session.contactId ? { contactId: session.contactId } : {}),
        }),
      ];
    case "malicious_tool_args":
      return [
        // A tenant id in the arguments, trying to book into another organization.
        call("bookMeeting", {
          title: "x",
          startsAt: `${thursday}T12:30:00.000Z`,
          orgId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          organizationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        }),
        call("bookMeeting", { title: "x".repeat(5000), startsAt: "not-a-date" }),
        { name: "bookMeeting", arguments: "{not json" },
        { name: "bookMeeting", arguments: '["array"]' },
        { name: "createContact", arguments: '{"__proto__":{"role":"OWNER"},"firstName":""}' },
        call("searchContacts", { query: "%" }),
        call("deleteEverything", {}),
      ];
    case "foreign_contact":
      return [
        call("logActivity", {
          contactId: foreignContactId,
          type: "NOTE",
          subject: "Pilot note",
        }),
      ];
    default:
      return [];
  }
}

function parseArguments(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function runTool(identity: PilotIdentity, session: Session, call: RawToolCall): object {
  if (!allowedVoiceTools(STORED_ENABLED_TOOLS).includes(call.name)) {
    return { error: "tool_not_enabled" };
  }
  const args = parseArguments(call.arguments);
  if (args === null) return { error: "invalid_arguments" };
  const tool = TOOL_REGISTRY.find((t) => t.name === call.name);
  if (!tool) return { error: "unknown_tool" };
  const parsed = tool.schema.safeParse(args);
  // Field paths only, never messages or values: the model could read them to the caller.
  if (!parsed.success) {
    return {
      error: "invalid_input",
      fields: parsed.error.issues.map((issue: { path: PropertyKey[] }) => issue.path.join(".")),
    };
  }
  const input = parsed.data as Record<string, unknown>;

  const cap = WRITE_CAPS.get(call.name);
  if (cap !== undefined) {
    const used = session.writes.get(call.name) ?? 0;
    if (used >= cap) return { error: "call_write_limit" };
    session.writes.set(call.name, used + 1);
  }

  const contacts = contactsByOrg.get(identity.orgId) ?? new Set<string>();
  const contactId = typeof input.contactId === "string" ? input.contactId : null;
  switch (call.name) {
    case "getCalendarAvailability":
      return { slots: ["12:30"], mock: true };
    case "createContact": {
      const id = randomUUID();
      contactsByOrg.set(identity.orgId, contacts.add(id));
      session.contactId = id;
      return { id, mock: true };
    }
    case "logActivity":
      if (!contactId || !contacts.has(contactId)) return { error: "contact_not_found" };
      return { logged: true, mock: true };
    case "bookMeeting":
      if (contactId && !contacts.has(contactId)) return { booked: false };
      bookingsByOrg.set(identity.orgId, pilotBookingCountOf(identity.orgId) + 1);
      return { booked: true, mock: true };
    default:
      return { error: "unknown_tool" };
  }
}

export type PilotTurnOutcome =
  | { ok: false; code: "duplicate_turn" | "session_limit" | "turn_limit" }
  | {
      ok: true;
      caller: string;
      reply: string;
      toolResults: Array<{ tool: string; result: string }>;
    };

/**
 * One turn. A turn id runs at most once for an identity within this process, so a
 * replayed request can't repeat a booking.
 * `foreignContactId` is what a hostile model would ask for in the foreign_contact
 * scenario; it is only ever checked against the caller's own organization.
 */
export function runPilotTurn(
  identity: PilotIdentity,
  input: Pick<PilotTurnInput, "turnId" | "language" | "scenario">,
  options: { now?: number; foreignContactId?: string } = {},
): PilotTurnOutcome {
  const now = options.now ?? Date.now();
  for (const [key, expiresAt] of seenTurns) {
    if (expiresAt <= now) seenTurns.delete(key);
  }
  const turnKey = `${identity.orgId}:${identity.userId}:${input.turnId}`;
  if (seenTurns.has(turnKey)) return { ok: false, code: "duplicate_turn" };
  // Fails closed: a full store refuses new turns rather than forgetting old ones.
  if (seenTurns.size >= MAX_REMEMBERED_TURNS) return { ok: false, code: "session_limit" };
  const session = sessionFor(identity, now);
  if (!session) return { ok: false, code: "session_limit" };
  if (session.turns >= MAX_TURNS_PER_SESSION) return { ok: false, code: "turn_limit" };
  session.turns++;
  seenTurns.set(turnKey, now + TURN_ID_RETENTION_MS);

  const line = PILOT_SCRIPT[input.scenario][input.language];
  const foreignContactId = options.foreignContactId ?? randomUUID();
  const toolResults = plannedToolCalls(input.scenario, session, foreignContactId).map((call) => ({
    tool: call.name,
    result: JSON.stringify(runTool(identity, session, call)),
  }));
  return { ok: true, caller: line.caller, reply: line.reply, toolResults };
}
