/**
 * Provider-facing Google Calendar service abstraction for the Syveka
 * Calendar PoC foundation. The public contract (CalendarService,
 * TenantContext, CreateEventInput, ...) is intentionally NOT
 * Composio-specific - a future provider swap only needs a new
 * ToolExecutor implementation, not a caller-facing rewrite. Today's only
 * implementation (composioToolExecutor) talks to Composio.
 *
 * Every operation:
 *   1. Resolves connected_account_id ONLY from a server-verified
 *      TenantContext, via tenant-binding.ts's real enforcement functions -
 *      never from caller input. This is the same choke point used
 *      throughout this PoC's live-verified scripts.
 *   2. Rejects any tool identifier outside the four approved tools before
 *      ever building a request (security-contract.ts, fail-closed).
 *   3. Normalizes the provider's response (response-normalizer.ts) so
 *      callers see one consistent shape regardless of which tool ran.
 *
 * This module never logs a raw provider payload, an OAuth token, or a
 * connected_account_id sourced from anywhere but the resolved tenant
 * context.
 */
import {
  buildToolExecuteRequest,
  type TenantComposioConnectionRegistry,
  type ServerVerifiedContext,
  type TenantComposioConnection,
} from "../tenant-binding.js";
import { assertToolApproved, type ApprovedTool } from "./security-contract.js";
import {
  normalizeCreateEventResponse,
  normalizeGetEventResponse,
  normalizeListEventsResponse,
  normalizeDeleteEventResponse,
  type NormalizedResult,
} from "./response-normalizer.js";

export type TenantContext = ServerVerifiedContext;

/** The one resolved connection a CalendarService instance operates against. */
export interface ResolvedConnection {
  connectedAccountId: string;
  composioUserId: string;
}

export interface ToolExecutorRequest {
  toolSlug: ApprovedTool;
  connectedAccountId: string;
  entityId: string;
  arguments: Record<string, unknown>;
}

export interface ToolExecutorResponse {
  status: number;
  successful?: boolean;
  data?: unknown;
  error?: unknown;
}

/** Injectable so the service is unit-testable without any live network call. */
export type ToolExecutor = (req: ToolExecutorRequest) => Promise<ToolExecutorResponse>;

const DEFAULT_CALENDAR_ID = "primary";
const DEFAULT_LIST_LOOKBACK_MS = 24 * 60 * 60 * 1000; // 1 day
const DEFAULT_LIST_LOOKAHEAD_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const MAX_LIST_WINDOW_MS = 366 * 24 * 60 * 60 * 1000; // ~1 year hard cap

export class CalendarServiceError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "CalendarServiceError";
  }
}

export interface ListEventsInput {
  calendarId?: string;
  /** RFC3339 timestamp. Defaults to now-1day if omitted. */
  timeMin?: string;
  /** RFC3339 timestamp. Defaults to now+30days if omitted. */
  timeMax?: string;
}

export interface CreateEventInput {
  calendarId?: string;
  summary: string;
  description?: string;
  /** ISO 8601, e.g. "2026-09-08T15:44:38". */
  startDateTime: string;
  durationMinutes: number;
  timezone?: string;
}

export interface GetEventInput {
  calendarId?: string;
  eventId: string;
}

export interface DeleteEventInput {
  calendarId?: string;
  eventId: string;
}

export class CalendarService {
  constructor(
    private readonly registry: TenantComposioConnectionRegistry,
    private readonly executor: ToolExecutor,
  ) {}

  /** Resolves the connection for a tenant context without executing any tool. */
  resolveConnection(ctx: TenantContext): ResolvedConnection {
    const req = buildToolExecuteRequest(this.registry, ctx, {});
    return {
      connectedAccountId: req.connected_account_id,
      composioUserId: this.composioUserIdFor(ctx),
    };
  }

  private composioUserIdFor(ctx: TenantContext): string {
    // Mirrors buildToolExecuteRequest's own resolution path so the entity_id
    // sent to Composio always matches the connection actually resolved -
    // never a value independently reconstructed from caller input.
    const conn = this.findConnection(ctx);
    return conn.composioUserId;
  }

  private findConnection(ctx: TenantContext): TenantComposioConnection {
    // findForTenant is the registry's ONLY lookup path (see tenant-binding.ts's
    // own design note: keyed solely by server-verified tenant context, never
    // by a caller-supplied id) - this is the same trust boundary
    // buildToolExecuteRequest itself relies on, not a second one.
    const found = this.registry.findForTenant(ctx.orgId, ctx.userId);
    if (!found) {
      throw new CalendarServiceError(
        `No connection bound to org=${ctx.orgId} user=${ctx.userId} - failing closed.`,
        "NO_CONNECTION",
      );
    }
    return found;
  }

  private async execute(
    ctx: TenantContext,
    toolSlug: ApprovedTool,
    callerArguments: Record<string, unknown>,
  ): Promise<ToolExecutorResponse> {
    assertToolApproved(toolSlug); // fail-closed even though the type already constrains this
    const conn = this.findConnection(ctx);
    const req = buildToolExecuteRequest(this.registry, ctx, callerArguments);
    if (req.connected_account_id !== conn.composioConnectedAccountId) {
      throw new CalendarServiceError(
        "Tool-execute request resolved to a different connection than the tenant binding expected.",
        "INCONSISTENT_BINDING",
      );
    }
    return this.executor({
      toolSlug,
      connectedAccountId: req.connected_account_id,
      entityId: conn.composioUserId,
      arguments: req.arguments,
    });
  }

  async listEvents(ctx: TenantContext, input: ListEventsInput = {}): Promise<NormalizedResult> {
    const timeMin = input.timeMin ?? new Date(Date.now() - DEFAULT_LIST_LOOKBACK_MS).toISOString();
    const timeMax = input.timeMax ?? new Date(Date.now() + DEFAULT_LIST_LOOKAHEAD_MS).toISOString();

    const span = new Date(timeMax).getTime() - new Date(timeMin).getTime();
    if (!Number.isFinite(span) || span <= 0) {
      throw new CalendarServiceError("timeMax must be after timeMin.", "INVALID_TIME_WINDOW");
    }
    if (span > MAX_LIST_WINDOW_MS) {
      throw new CalendarServiceError(
        `Requested LIST window (${Math.round(span / 86_400_000)} days) exceeds the maximum allowed ` +
          `(${Math.round(MAX_LIST_WINDOW_MS / 86_400_000)} days) - no unbounded retrieval.`,
        "WINDOW_TOO_LARGE",
      );
    }

    const res = await this.execute(ctx, "GOOGLECALENDAR_EVENTS_LIST", {
      calendarId: input.calendarId ?? DEFAULT_CALENDAR_ID,
      timeMin,
      timeMax,
    });
    return normalizeListEventsResponse(res);
  }

  async createEvent(ctx: TenantContext, input: CreateEventInput): Promise<NormalizedResult> {
    if (!input.summary || input.summary.trim().length === 0) {
      throw new CalendarServiceError("summary is required.", "INVALID_INPUT");
    }
    if (!input.startDateTime) {
      throw new CalendarServiceError("startDateTime is required.", "INVALID_INPUT");
    }
    if (!Number.isFinite(input.durationMinutes) || input.durationMinutes <= 0) {
      throw new CalendarServiceError("durationMinutes must be a positive number.", "INVALID_INPUT");
    }

    // Deliberately minimal, fixed argument set - attendees, recurrence, and
    // conferencing are never accepted by CreateEventInput's type, and
    // create_meeting_room is always forced false. This is the PoC's own
    // no-attendees/no-recurrence/no-conferencing boundary enforced in code,
    // not just by caller discipline.
    const res = await this.execute(ctx, "GOOGLECALENDAR_CREATE_EVENT", {
      calendar_id: input.calendarId ?? DEFAULT_CALENDAR_ID,
      summary: input.summary,
      description: input.description,
      start_datetime: input.startDateTime,
      event_duration_minutes: input.durationMinutes,
      timezone: input.timezone ?? "UTC",
      create_meeting_room: false,
    });
    return normalizeCreateEventResponse(res);
  }

  async getEvent(ctx: TenantContext, input: GetEventInput): Promise<NormalizedResult> {
    if (!input.eventId) {
      throw new CalendarServiceError("eventId is required.", "INVALID_INPUT");
    }
    const res = await this.execute(ctx, "GOOGLECALENDAR_EVENTS_GET", {
      calendar_id: input.calendarId ?? DEFAULT_CALENDAR_ID,
      event_id: input.eventId,
    });
    return normalizeGetEventResponse(res);
  }

  async deleteEvent(ctx: TenantContext, input: DeleteEventInput): Promise<NormalizedResult> {
    if (!input.eventId) {
      throw new CalendarServiceError("eventId is required.", "INVALID_INPUT");
    }
    const res = await this.execute(ctx, "GOOGLECALENDAR_DELETE_EVENT", {
      calendar_id: input.calendarId ?? DEFAULT_CALENDAR_ID,
      event_id: input.eventId,
    });
    return normalizeDeleteEventResponse(res);
  }
}

/** Live Composio-backed ToolExecutor - the only place this module talks to the network. */
export function createComposioToolExecutor(
  apiKey: string,
  baseUrl = process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev",
): ToolExecutor {
  return async (req) => {
    const res = await fetch(new URL(`/api/v3.1/tools/execute/${req.toolSlug}`, baseUrl), {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        connected_account_id: req.connectedAccountId,
        entity_id: req.entityId,
        arguments: req.arguments,
      }),
    });
    const body = (await res.json().catch(() => null)) as {
      data?: unknown;
      successful?: boolean;
      error?: unknown;
    } | null;
    return {
      status: res.status,
      successful: body?.successful,
      data: body?.data,
      error: body?.error,
    };
  };
}
