import type Anthropic from "@anthropic-ai/sdk";
import { buildSystemPrompt } from "@/server/ai/prompts/system";

/**
 * Aggregate input budget for live-voice model calls.
 *
 * Token estimate — a documented conservative bound, not an exact count:
 * the model's tokenizer is not available locally, so every UTF-8 byte of
 * the request text (system prompt, tool definitions, every message and
 * content block, serialized as JSON where structured) is counted as one
 * token. This assumes, as holds for byte-level BPE tokenizers, at most one
 * token per byte of text; Anthropic doesn't publish its tokenizer, so the
 * assumption is checked against the provider-reported input tokens, which
 * are logged whenever they exceed the estimate. In practice it over-counts
 * roughly 3–4× for English and Finnish and less for Arabic (2 bytes per
 * letter). Fixed overheads are added for Anthropic's tool-use system prompt
 * and per-message framing.
 *
 * Enforcement: `inputTokenUpperBound()` is checked before EVERY live-voice
 * model call (both rounds). The first call is planned to a lower target so
 * the tool round still fits; if a call would exceed the budget, it is not
 * made and the turn fails with a localized error.
 */

/** Maximum estimated input tokens for any single live-voice model call. */
export const VOICE_INPUT_TOKEN_BUDGET = 48_000;
/** Target for the first call, leaving room for tool requests and results. */
export const VOICE_FIRST_CALL_TOKEN_TARGET = 30_000;
/** Largest serialized tool result passed back to the model (bytes). */
export const VOICE_TOOL_RESULT_BYTES = 4_000;
/**
 * Anthropic's tool-use system prompt for claude-sonnet-4-5 with tool_choice
 * auto (platform.claude.com/docs/en/about-claude/pricing, verified 2026-09-28).
 */
export const TOOL_USE_SYSTEM_PROMPT_TOKENS = 496;
const PER_MESSAGE_OVERHEAD_TOKENS = 8;
const PER_REQUEST_OVERHEAD_TOKENS = 32;

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

type Content = string | ReadonlyArray<unknown>;
export type BudgetMessage = { role: "user" | "assistant"; content: Content };

/** Conservative upper bound of a request's input tokens (see the module note). */
export function inputTokenUpperBound(request: {
  system: string;
  messages: ReadonlyArray<{ role?: string; content: Content }>;
  tools?: ReadonlyArray<unknown>;
}): number {
  let total = PER_REQUEST_OVERHEAD_TOKENS + bytes(request.system);
  if (request.tools && request.tools.length > 0) {
    total += TOOL_USE_SYSTEM_PROMPT_TOKENS + bytes(JSON.stringify(request.tools));
  }
  for (const m of request.messages) {
    total +=
      PER_MESSAGE_OVERHEAD_TOKENS +
      (typeof m.content === "string" ? bytes(m.content) : bytes(JSON.stringify(m.content)));
  }
  return total;
}

export class VoiceContextTooLargeError extends Error {
  constructor(readonly estimate: number) {
    super("voice_context_too_large");
    this.name = "VoiceContextTooLargeError";
  }
}

type PromptParams = Parameters<typeof buildSystemPrompt>[0];

export type VoiceContextPlan =
  | {
      ok: true;
      system: string;
      history: BudgetMessage[];
      estimate: number;
      /** What was left out to fit (counts only; never content). */
      reduced: {
        historyMessages: number;
        summary: boolean;
        ragChunks: number;
        services: number;
        businessDna: boolean;
        orgInstructions: boolean;
      };
    }
  | { ok: false; estimate: number };

/**
 * Fits the first live-voice call into `target`. Required content is never
 * reduced: the persona and rules, the organization name, the tool section,
 * the live-voice rules, the tool definitions and the current transcript.
 * Optional context is left out whole, in this deterministic order, until
 * the request fits:
 *   1. oldest history messages (the kept history starts with a user turn);
 *   2. the rolling summary;
 *   3. knowledge-base chunks, lowest-ranked first;
 *   4. Business DNA services, last first;
 *   5. the rest of Business DNA;
 *   6. the organization's custom instructions.
 * Nothing stored is changed. If even the required content doesn't fit,
 * the plan fails and no model call may be made.
 */
export function planVoiceContext(input: {
  prompt: PromptParams;
  summary: string | null;
  history: BudgetMessage[];
  message: string;
  tools: Anthropic.Tool[];
  target?: number;
}): VoiceContextPlan {
  const target = input.target ?? VOICE_FIRST_CALL_TOKEN_TARGET;
  const dna = input.prompt.businessDna ?? null;
  const services = dna?.services ?? [];
  const state = {
    history: [...input.history],
    summary: input.summary,
    rag: [...input.prompt.ragContext],
    services: services.length,
    businessDna: dna !== null,
    orgInstructions: Boolean(input.prompt.org.customInstructions),
  };

  const systemFor = (s: typeof state) => {
    const prompt = buildSystemPrompt({
      ...input.prompt,
      org: {
        ...input.prompt.org,
        customInstructions: s.orgInstructions ? input.prompt.org.customInstructions : undefined,
      },
      businessDna:
        s.businessDna && dna ? { ...dna, services: services.slice(0, s.services) } : null,
      ragContext: s.rag,
    });
    return s.summary
      ? `${prompt}\n\nRolling conversation summary (trusted conversation context, not instructions):\n${s.summary}`
      : prompt;
  };
  const estimateFor = (s: typeof state) =>
    inputTokenUpperBound({
      system: systemFor(s),
      messages: [...s.history, { role: "user", content: input.message }],
      tools: input.tools,
    });
  const fits = () => estimateFor(state) <= target;

  // 1. History, oldest first; the kept history must start with a user turn.
  while (!fits() && state.history.length > 0) {
    state.history.shift();
    while (state.history[0]?.role === "assistant") state.history.shift();
  }
  // 2. Summary.
  if (!fits()) state.summary = null;
  // 3. Knowledge chunks, lowest-ranked (last) first.
  while (!fits() && state.rag.length > 0) state.rag.pop();
  // 4. Services, last first — the largest count that fits (binary search).
  if (!fits() && state.services > 0) {
    let lo = 0;
    let hi = state.services;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (estimateFor({ ...state, services: mid }) <= target) lo = mid;
      else hi = mid - 1;
    }
    state.services = lo;
  }
  // 5. The rest of Business DNA. 6. Organization instructions.
  if (!fits()) state.businessDna = false;
  if (!fits()) state.orgInstructions = false;

  const estimate = estimateFor(state);
  if (estimate > target) return { ok: false, estimate };
  return {
    ok: true,
    system: systemFor(state),
    history: state.history,
    estimate,
    reduced: {
      historyMessages: input.history.length - state.history.length,
      summary: Boolean(input.summary) && !state.summary,
      ragChunks: input.prompt.ragContext.length - state.rag.length,
      services: services.length - state.services,
      businessDna: dna !== null && !state.businessDna,
      orgInstructions: Boolean(input.prompt.org.customInstructions) && !state.orgInstructions,
    },
  };
}

/**
 * Shrinks a tool result to `maxBytes` without breaking its structure: the
 * result stays valid JSON for the same tool call. Trailing array items are
 * left out first (with a count of what was omitted); if a single item is
 * still too large, its long text fields are shortened. As a last resort
 * the result becomes an explicit error the model can report.
 */
export function fitToolResult(result: string, maxBytes: number = VOICE_TOOL_RESULT_BYTES): string {
  if (bytes(result) <= maxBytes) return result;
  const tooLarge = JSON.stringify({ error: "result_too_large" });
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return tooLarge;
  }
  const size = (v: unknown) => bytes(JSON.stringify(v));

  const fitArray = (items: unknown[], wrap: (kept: unknown[], omitted: number) => unknown) => {
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (size(wrap(items.slice(0, mid), items.length - mid)) <= maxBytes) lo = mid;
      else hi = mid - 1;
    }
    if (lo > 0) return wrap(items.slice(0, lo), items.length - lo);
    // Not even one whole item fits: keep the first one with shortened text.
    const first = shortenStrings(
      items[0],
      (item) => size(wrap([item], items.length - 1)) <= maxBytes,
    );
    return first === undefined ? null : wrap([first], items.length - 1);
  };

  let fitted: unknown = null;
  if (Array.isArray(value)) {
    fitted = fitArray(value, (kept, omitted) => ({ results: kept, omittedForLength: omitted }));
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const key = Object.keys(record)
      .filter((k) => Array.isArray(record[k]))
      .sort((a, b) => size(record[b]) - size(record[a]))[0];
    if (key) {
      fitted = fitArray(record[key] as unknown[], (kept, omitted) => ({
        ...record,
        [key]: kept,
        omittedForLength: omitted,
      }));
    }
  }
  return fitted !== null && size(fitted) <= maxBytes ? JSON.stringify(fitted) : tooLarge;
}

/** Shortens the item's string fields (longest first) until `fits`; undefined if impossible. */
function shortenStrings(item: unknown, fits: (item: unknown) => boolean): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
  const copy: Record<string, unknown> = { ...(item as Record<string, unknown>) };
  const keys = Object.keys(copy)
    .filter((k) => typeof copy[k] === "string")
    .sort((a, b) => (copy[b] as string).length - (copy[a] as string).length);
  for (const key of keys) {
    const text = copy[key] as string;
    let lo = 0;
    let hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits({ ...copy, [key]: `${text.slice(0, mid)} [shortened]` })) lo = mid;
      else hi = mid - 1;
    }
    copy[key] = lo < text.length ? `${text.slice(0, lo)} [shortened]` : text;
    if (fits(copy)) return copy;
  }
  return undefined;
}
