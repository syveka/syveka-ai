import type { ProposedActionView } from "@/lib/validators/chat";

/**
 * One tool call as saved with the assistant's reply (Message.toolCalls).
 *
 * `details` holds just enough to diagnose a read-only call afterwards,
 * never its full result: no calendar event contents, CRM records, search
 * queries or conversation text. Only tools listed in `toolCallDetails` get
 * any; the others keep name and outcome only, since their inputs (contact
 * or knowledge-base searches) can contain personal data.
 */
export type ToolCallLogEntry = {
  name: string;
  ok: boolean;
  action?: ProposedActionView;
  details?: ToolCallDetails;
};

export type ToolCallDetails = {
  date?: string;
  freeSlotCount?: number;
  usingOrgConfiguredHours?: boolean;
};

/** The diagnostic details of a finished read-only call, from its input and result. */
export function toolCallDetails(
  name: string,
  input: unknown,
  result: string,
): ToolCallDetails | undefined {
  if (name !== "getCalendarAvailability") return undefined;
  const details: ToolCallDetails = {};
  const date = (input as { date?: unknown } | null)?.date;
  if (typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date)) details.date = date;
  try {
    const parsed = JSON.parse(result) as {
      freeSlotCount?: unknown;
      usingOrgConfiguredHours?: unknown;
    };
    if (typeof parsed.freeSlotCount === "number") details.freeSlotCount = parsed.freeSlotCount;
    if (typeof parsed.usingOrgConfiguredHours === "boolean") {
      details.usingOrgConfiguredHours = parsed.usingOrgConfiguredHours;
    }
  } catch {
    // Not JSON: name and outcome are still recorded.
  }
  return details;
}

/** The tools a saved reply used, in order, as its chips show them live. */
export function savedToolNames(toolCalls: unknown): string[] {
  if (!Array.isArray(toolCalls)) return [];
  const names: string[] = [];
  for (const entry of toolCalls) {
    const name = (entry as { name?: unknown } | null)?.name;
    if (typeof name === "string") names.push(name);
  }
  return names;
}
