import { NextResponse } from "next/server";
import { publicAssistantRequestSchema } from "@/lib/validators/public-assistant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

// The largest valid request is a 600-code-unit message plus 8 history entries of 600: about
// 16.5 KB as UTF-8 in CJK, and about 32.9 KB when a client escapes every non-ASCII character as
// \uXXXX (e.g. Python's json.dumps default). 64 KiB keeps every valid request with about 2x
// headroom while bounding what zod 3 has to walk: a body this size full of failing array elements
// yields at most ~44k issues (~75 ms, ~20 MB), versus ~2.8M issues and ~660 MB at Vercel's 4.5 MB
// body cap (GHSA-mrhx-c7xc-m3w5: zod 3 records one issue per element even past .max(8)).
const MAX_REQUEST_BODY_BYTES = 64 * 1024;

type BodyReadResult = { kind: "ok"; text: string } | { kind: "too_large" } | { kind: "unreadable" };

/**
 * Reads the body as UTF-8 text, refusing anything over `maxBytes` without buffering it: a
 * declared Content-Length over the limit is refused before reading, and the stream is cancelled
 * as soon as the running byte count passes the limit (covers chunked bodies and lying headers).
 * Decoding matches `request.json()` (UTF-8, BOM stripped, invalid sequences replaced).
 */
async function readBodyWithinLimit(request: Request, maxBytes: number): Promise<BodyReadResult> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared.trim()) && Number(declared.trim()) > maxBytes) {
    return { kind: "too_large" };
  }
  if (!request.body) return { kind: "ok", text: "" };

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return { kind: "too_large" };
      }
      chunks.push(value);
    }
  } catch {
    return { kind: "unreadable" };
  }

  const buffer = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: "ok", text: new TextDecoder().decode(buffer) };
}

/**
 * Public, unauthenticated marketing-site assistant. No session, no tenant
 * context, no tools passed to the model -- this route cannot read or write
 * any customer/tenant data by construction, not merely by prompt
 * instruction (see src/server/ai/prompts/public-assistant.ts for the rest
 * of the boundary). Non-streaming: a single short JSON reply, capped output
 * tokens (src/server/ai/router.ts's "publicAssistant" route), IP rate
 * limited. Nothing here is persisted -- history is held client-side only.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const [{ rateLimiters }, { streamClaude }, { routeModel }, { buildPublicAssistantSystemPrompt }] =
    await Promise.all([
      import("@/server/integrations/redis"),
      import("@/server/integrations/anthropic"),
      import("@/server/ai/router"),
      import("@/server/ai/prompts/public-assistant"),
    ]);

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "anon";
  const rateLimit = await rateLimiters.publicAssistant.limit(`public-assistant:${ip}`);
  if (!rateLimit.success) {
    return NextResponse.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.max(1, Math.ceil((rateLimit.reset - Date.now()) / 1000))),
        },
      },
    );
  }

  // Size is enforced before JSON.parse and zod so an anonymous caller can't make zod 3 walk a
  // huge array (see MAX_REQUEST_BODY_BYTES).
  const read = await readBodyWithinLimit(request, MAX_REQUEST_BODY_BYTES);
  if (read.kind === "too_large") {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  let body: unknown = null;
  if (read.kind === "ok") {
    try {
      body = JSON.parse(read.text);
    } catch {
      body = null;
    }
  }
  const parsed = publicAssistantRequestSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const { message, locale, history } = parsed.data;

  try {
    const { isFlaggedByModeration } = await import("@/server/integrations/openai");
    if (await isFlaggedByModeration(message, request.signal)) {
      return NextResponse.json({ error: "content_flagged" }, { status: 422 });
    }

    const { model, maxTokens } = routeModel("publicAssistant");
    const system = buildPublicAssistantSystemPrompt(locale);

    let reply = "";
    // No `tools` passed -- intentionally leaves the model with no callable
    // capability at all, so onToolUse is never invoked and there is no
    // tool-use branch here to guard against a prompt-injected tool call.
    await streamClaude({
      model,
      system,
      maxTokens,
      messages: [
        ...history.map((h) => ({ role: h.role, content: h.content })),
        { role: "user" as const, content: message },
      ],
      callbacks: {
        onText: (delta) => {
          reply += delta;
        },
      },
      signal: request.signal,
    });

    if (await isFlaggedByModeration(reply, request.signal)) {
      return NextResponse.json({ error: "content_flagged" }, { status: 422 });
    }

    return NextResponse.json({ reply });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "public_assistant_failed",
        message: error instanceof Error ? error.message : "unknown error",
      }),
    );
    return NextResponse.json({ error: "generic" }, { status: 500 });
  }
}
