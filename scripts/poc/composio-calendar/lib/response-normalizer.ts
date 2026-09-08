/**
 * Normalizes Composio's per-tool Google Calendar response shapes into one
 * consistent structure, so callers never need tool-specific ad hoc parsing.
 *
 * Discovered live in this PoC (not assumed): the four approved tools do not
 * share one response shape.
 *   - GOOGLECALENDAR_CREATE_EVENT nests the created event under
 *     data.response_data.
 *   - GOOGLECALENDAR_EVENTS_GET returns the event flat, directly under data.
 *   - GOOGLECALENDAR_EVENTS_LIST returns { items: [...] } directly under
 *     data.
 *   - GOOGLECALENDAR_DELETE_EVENT returns { response_data: { status } }
 *     under data, with no event body.
 *
 * This module never logs a raw provider payload - callers get only the
 * normalized fields, plus a raw/error surface explicitly intended for
 * diagnostics that is itself never printed by this module.
 */

export interface CalendarEventSummary {
  id: string;
  summary: string | undefined;
  status: string | undefined;
  start: unknown;
  end: unknown;
  htmlLink: string | undefined;
}

export type NormalizedResult =
  | { kind: "event"; success: true; event: CalendarEventSummary }
  | { kind: "eventList"; success: true; events: CalendarEventSummary[] }
  | { kind: "deleted"; success: true }
  | { kind: "error"; success: false; errorClass: string; message: string };

interface RawToolResponse {
  status: number;
  successful?: boolean;
  data?: unknown;
  error?: unknown;
}

function classifyError(status: number, error: unknown): string {
  if (status === 403) return "PERMISSION_OR_SCOPE_ERROR";
  if (status === 404) return "NOT_FOUND";
  if (status >= 500) return "PROVIDER_ERROR";
  if (status >= 400) return "REQUEST_ERROR";
  if (error) return "TOOL_REPORTED_ERROR";
  return "UNKNOWN_ERROR";
}

function toErrorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const maybeMessage = (error as Record<string, unknown>).message;
    if (typeof maybeMessage === "string") return maybeMessage;
  }
  return "unspecified error";
}

function extractEventSummary(raw: Record<string, unknown>): CalendarEventSummary {
  return {
    id: String(raw.id ?? ""),
    summary: typeof raw.summary === "string" ? raw.summary : undefined,
    status: typeof raw.status === "string" ? raw.status : undefined,
    start: raw.start,
    end: raw.end,
    htmlLink: typeof raw.htmlLink === "string" ? raw.htmlLink : undefined,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/**
 * Deterministic: never throws. A malformed/unexpected shape always resolves
 * to a `{ kind: "error" }` result rather than a thrown exception or a
 * partially-populated success result - callers can rely on `success` alone
 * to branch safely.
 */
export function normalizeCreateEventResponse(res: RawToolResponse): NormalizedResult {
  if (res.status < 200 || res.status >= 300 || res.successful !== true) {
    return {
      kind: "error",
      success: false,
      errorClass: classifyError(res.status, res.error),
      message: toErrorMessage(res.error),
    };
  }
  const data = isRecord(res.data) ? res.data : undefined;
  const nested = data && isRecord(data.response_data) ? data.response_data : undefined;
  const eventRaw = nested ?? data;
  if (!eventRaw || typeof eventRaw.id !== "string" || eventRaw.id.length === 0) {
    return {
      kind: "error",
      success: false,
      errorClass: "MALFORMED_RESPONSE",
      message: "CREATE response reported success but contained no usable event id",
    };
  }
  return { kind: "event", success: true, event: extractEventSummary(eventRaw) };
}

export function normalizeGetEventResponse(res: RawToolResponse): NormalizedResult {
  if (res.status < 200 || res.status >= 300 || res.successful !== true) {
    return {
      kind: "error",
      success: false,
      errorClass: classifyError(res.status, res.error),
      message: toErrorMessage(res.error),
    };
  }
  const data = isRecord(res.data) ? res.data : undefined;
  // Defensive: prefer a nested response_data if present (matches CREATE's
  // shape), otherwise fall back to the flat shape observed live for GET.
  const nested = data && isRecord(data.response_data) ? data.response_data : undefined;
  const eventRaw = nested ?? data;
  if (!eventRaw || typeof eventRaw.id !== "string" || eventRaw.id.length === 0) {
    return {
      kind: "error",
      success: false,
      errorClass: "MALFORMED_RESPONSE",
      message: "GET response reported success but contained no usable event id",
    };
  }
  return { kind: "event", success: true, event: extractEventSummary(eventRaw) };
}

export function normalizeListEventsResponse(res: RawToolResponse): NormalizedResult {
  if (res.status < 200 || res.status >= 300 || res.successful !== true) {
    return {
      kind: "error",
      success: false,
      errorClass: classifyError(res.status, res.error),
      message: toErrorMessage(res.error),
    };
  }
  const data = isRecord(res.data) ? res.data : undefined;
  const items = data && Array.isArray(data.items) ? data.items : undefined;
  if (!items) {
    return {
      kind: "error",
      success: false,
      errorClass: "MALFORMED_RESPONSE",
      message: "LIST response reported success but contained no items array",
    };
  }
  const events = items.filter(isRecord).map(extractEventSummary);
  return { kind: "eventList", success: true, events };
}

export function normalizeDeleteEventResponse(res: RawToolResponse): NormalizedResult {
  if (res.status < 200 || res.status >= 300 || res.successful !== true) {
    return {
      kind: "error",
      success: false,
      errorClass: classifyError(res.status, res.error),
      message: toErrorMessage(res.error),
    };
  }
  const data = isRecord(res.data) ? res.data : undefined;
  const nested = data && isRecord(data.response_data) ? data.response_data : undefined;
  const statusField = nested?.status;
  if (statusField !== "success" && data?.status !== "success" && nested === undefined) {
    // Some tool responses may simply omit an explicit status field on
    // success; only treat this as malformed if we got neither a nested
    // response_data.status nor any data at all to reason about.
    if (!data) {
      return {
        kind: "error",
        success: false,
        errorClass: "MALFORMED_RESPONSE",
        message: "DELETE response reported success but contained no data to confirm deletion",
      };
    }
  }
  return { kind: "deleted", success: true };
}
