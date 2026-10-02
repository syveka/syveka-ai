import "server-only";

import { createHash } from "node:crypto";
import {
  describeWriteToolCall,
  executeTool,
  type ToolIdentity,
  type WriteActionDetails,
} from "@/server/ai/tools";

/**
 * Server-enforced confirmation for AI write tools in typed chat.
 *
 * A write tool call from the model never runs directly. It is validated
 * (tool, role permission, input, tenancy of referenced records) and stored
 * as a pending action bound to the organization, user and conversation,
 * with a digest of the exact tool and input. The user sees what would
 * happen and confirms or cancels it with a button; only then does
 * POST /api/v1/ai/actions/{id} run exactly the stored input (never new model
 * output), once:
 * - the decision is atomic and single-use (a replay or double submit finds
 *   the action already decided);
 * - it expires after ACTION_TTL_SECONDS;
 * - another organization, user or conversation can't use it, and can't
 *   tell that it exists;
 * - the confirmation names the digest the user saw, so it authorizes only
 *   that tool with those arguments: changed arguments are a new action;
 * - the role permission is checked again when it runs.
 * Nothing the model says or calls can confirm an action.
 */

export type EvalClient = {
  eval: (script: string, keys: string[], args: string[]) => Promise<unknown>;
  /** Key namespace; tests against a real Redis use their own. */
  keyPrefix?: string;
};

export const ACTION_TTL_SECONDS = 600;
const DEFAULT_NAMESPACE = "ai:action";
const actionKey = (redis: EvalClient, id: string) =>
  `${redis.keyPrefix ?? DEFAULT_NAMESPACE}:${id}`;

/**
 * Store a pending action. KEYS: action. ARGV: org, user, conversation, tool,
 * input (JSON), digest, expiresAtMs, ttlSeconds. Returns 1 (0 if the id exists).
 */
export const PROPOSE_ACTION_SCRIPT = `
if redis.call("EXISTS", KEYS[1]) == 1 then return 0 end
redis.call("HSET", KEYS[1], "org", ARGV[1], "user", ARGV[2], "conversation", ARGV[3],
  "tool", ARGV[4], "input", ARGV[5], "digest", ARGV[6], "status", "pending", "expiresAt", ARGV[7])
redis.call("EXPIRE", KEYS[1], tonumber(ARGV[8]))
return 1
`;

/**
 * Decide a pending action, exactly once. KEYS: action. ARGV: org, user,
 * conversation, digest, decision ("confirmed"/"canceled"), nowMs.
 * Returns {1, tool, input}, or {-1} (no such action for this user, or
 * expired -- indistinguishable on purpose), {-3} (already decided),
 * {-4} (digest differs: not the action the user saw).
 */
export const DECIDE_ACTION_SCRIPT = `
local org = redis.call("HGET", KEYS[1], "org")
if not org or org ~= ARGV[1] or redis.call("HGET", KEYS[1], "user") ~= ARGV[2]
  or redis.call("HGET", KEYS[1], "conversation") ~= ARGV[3] then return {-1} end
if tonumber(redis.call("HGET", KEYS[1], "expiresAt")) <= tonumber(ARGV[6]) then return {-1} end
if redis.call("HGET", KEYS[1], "status") ~= "pending" then return {-3} end
if redis.call("HGET", KEYS[1], "digest") ~= ARGV[4] then return {-4} end
redis.call("HSET", KEYS[1], "status", ARGV[5])
return {1, redis.call("HGET", KEYS[1], "tool"), redis.call("HGET", KEYS[1], "input")}
`;

/** Stable JSON (sorted keys) of a flat tool input, so equal inputs give equal digests. */
function canonical(input: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.keys(input)
        .filter((k) => input[k] !== undefined)
        .sort()
        .map((k) => [k, input[k]]),
    ),
  );
}

export function actionDigest(tool: string, input: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${tool}\n${canonical(input)}`)
    .digest("hex");
}

/** Sent to the client (SSE "action" event): what the user is asked to confirm. */
export type ProposedAction = {
  id: string;
  tool: string;
  digest: string;
  conversationId: string;
  expiresAt: number;
  details: WriteActionDetails;
};

/** One structured line per action event: ids and outcomes only, never arguments. */
function logAction(fields: Record<string, unknown>) {
  console.info(JSON.stringify({ event: "ai_tool_action", ...fields }));
}

/** What the model is told: nothing has happened yet; the user decides. */
const AWAITING = JSON.stringify({
  status: "awaiting_user_confirmation",
  note: "Nothing has been done yet. The user sees this action with Confirm and Cancel buttons under your reply. Say briefly what will happen if they confirm. Never say it is done.",
});

/**
 * Turns a model's write tool call into a pending action. Returns the
 * result for the model and, when stored, the action for the client. Any
 * failure leaves nothing pending and nothing written.
 */
export async function proposeToolAction(
  redis: EvalClient,
  identity: ToolIdentity,
  conversationId: string,
  name: string,
  rawInput: unknown,
  now: Date = new Date(),
): Promise<{ modelResult: string; action: ProposedAction | null }> {
  let described: Awaited<ReturnType<typeof describeWriteToolCall>>;
  try {
    described = await describeWriteToolCall(identity, name, rawInput);
  } catch (e) {
    logAction({
      phase: "proposal_unavailable",
      tool: name,
      orgId: identity.orgId,
      name: e instanceof Error ? e.name : "unknown",
    });
    return { modelResult: JSON.stringify({ error: "confirmation_unavailable" }), action: null };
  }
  if (!described.ok) {
    logAction({ phase: "proposal_rejected", tool: name, orgId: identity.orgId });
    return { modelResult: described.error, action: null };
  }
  const id = crypto.randomUUID();
  const digest = actionDigest(described.tool, described.input);
  const expiresAt = now.getTime() + ACTION_TTL_SECONDS * 1000;
  try {
    const stored = await redis.eval(
      PROPOSE_ACTION_SCRIPT,
      [actionKey(redis, id)],
      [
        identity.orgId,
        identity.userId,
        conversationId,
        described.tool,
        JSON.stringify(described.input),
        digest,
        String(expiresAt),
        String(ACTION_TTL_SECONDS),
      ],
    );
    if (Number(stored) !== 1) throw new Error("Action id collision");
  } catch (e) {
    logAction({
      phase: "proposal_unavailable",
      tool: name,
      orgId: identity.orgId,
      name: e instanceof Error ? e.name : "unknown",
    });
    return {
      modelResult: JSON.stringify({ error: "confirmation_unavailable" }),
      action: null,
    };
  }
  logAction({ phase: "proposed", tool: described.tool, actionId: id, orgId: identity.orgId });
  return {
    modelResult: AWAITING,
    action: {
      id,
      tool: described.tool,
      digest,
      conversationId,
      expiresAt,
      details: described.details,
    },
  };
}

export type ActionOutcome =
  | { ok: true; tool: string; status: "canceled" }
  | { ok: true; tool: string; status: "done"; result: Record<string, unknown> }
  | { ok: true; tool: string; status: "not_done"; reason: "slot_taken" }
  | {
      ok: false;
      reason:
        | "not_found"
        | "already_decided"
        | "mismatch"
        | "permission_denied"
        | "invalid_action"
        | "action_failed";
    };

const DECIDE_ERRORS = {
  [-1]: "not_found",
  [-3]: "already_decided",
  [-4]: "mismatch",
} as const;

/** Only these result fields go back to the client (never error messages). */
const SAFE_RESULT_KEYS = ["id", "eventId", "created", "booked", "startsAt"];

/**
 * Confirms or cancels a pending action for the signed-in user. A confirmed
 * action runs exactly its stored input through executeTool (permission and
 * input checked again); it is marked decided first, so it can never run
 * twice, even if running it fails.
 */
export async function decideToolAction(
  redis: EvalClient,
  identity: ToolIdentity,
  request: { id: string; conversationId: string; digest: string; decision: "confirm" | "cancel" },
  now: Date = new Date(),
): Promise<ActionOutcome> {
  const raw = await redis.eval(
    DECIDE_ACTION_SCRIPT,
    [actionKey(redis, request.id)],
    [
      identity.orgId,
      identity.userId,
      request.conversationId,
      request.digest,
      request.decision === "confirm" ? "confirmed" : "canceled",
      String(now.getTime()),
    ],
  );
  const reply = Array.isArray(raw) ? raw : [raw];
  const code = Number(reply[0]);
  if (code !== 1) {
    const reason = DECIDE_ERRORS[code as keyof typeof DECIDE_ERRORS];
    if (!reason) throw new Error("Unexpected action store response");
    logAction({ phase: "decision_refused", reason, actionId: request.id, orgId: identity.orgId });
    return { ok: false, reason };
  }
  const tool = String(reply[1]);
  if (request.decision === "cancel") {
    logAction({ phase: "canceled", tool, actionId: request.id, orgId: identity.orgId });
    return { ok: true, tool, status: "canceled" };
  }
  let input: unknown;
  try {
    input = JSON.parse(String(reply[2]));
  } catch {
    return { ok: false, reason: "invalid_action" };
  }
  const resultText = await executeTool(identity, tool, input);
  const result = JSON.parse(resultText) as Record<string, unknown>;
  let outcome: ActionOutcome;
  if (typeof result.error === "string") {
    outcome = {
      ok: false,
      reason:
        result.error === "permission_denied"
          ? "permission_denied"
          : result.error === "invalid_input" || result.error === "unknown_tool"
            ? "invalid_action"
            : "action_failed",
    };
  } else if (result.booked === false) {
    outcome = { ok: true, tool, status: "not_done", reason: "slot_taken" };
  } else {
    outcome = {
      ok: true,
      tool,
      status: "done",
      result: Object.fromEntries(
        Object.entries(result).filter(([k]) => SAFE_RESULT_KEYS.includes(k)),
      ),
    };
  }
  logAction({
    phase: "confirmed",
    tool,
    actionId: request.id,
    orgId: identity.orgId,
    outcome: outcome.ok ? outcome.status : outcome.reason,
  });
  return outcome;
}
