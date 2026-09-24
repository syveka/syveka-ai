/**
 * Privacy-safe description of a failed AI chat generation, for server logs.
 *
 * The chat stream's catch receives provider errors (Anthropic APIError:
 * status, headers, error body) and database errors from persisting the turn.
 * Prisma validation messages quote the query input -- i.e. the user's chat
 * text -- so the error message (and the raw error object) must never be
 * logged. Only non-content identifiers are kept.
 */
export function describeAiChatStreamError(err: unknown): {
  event: "ai_chat_stream_failed";
  name: string;
  status: number | null;
  code: string | null;
  requestId: string | null;
} {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    name?: unknown;
    status?: unknown;
    code?: unknown;
    request_id?: unknown;
  };
  return {
    event: "ai_chat_stream_failed",
    name: typeof e.name === "string" ? e.name : typeof err,
    status: typeof e.status === "number" ? e.status : null,
    code: typeof e.code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(e.code) ? e.code : null,
    requestId:
      typeof e.request_id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(e.request_id)
        ? e.request_id
        : null,
  };
}
