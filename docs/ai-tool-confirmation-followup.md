# Follow-up: server-enforced confirmation for AI write tools

Status:

- **Typed AI Chat: implemented** (server-enforced; see "Implemented for typed chat" below).
- **Phone assistant (Vapi): open**. It still runs write tools on the model's call; this needs the
  product decision below.

Found during the review of PR #215 (live voice conversation). Live voice offers only read-only tools.

## Problem

AI Chat (typed) and the phone assistant (Vapi webhook) let the model call tools that write data.
For these tools, the "confirm first" requirement exists **only as prompt text**. Nothing on the
server checks that the user actually confirmed before a tool runs.

| Tool            | Permission       | Effect                                       | Where the confirmation rule lives                                                    |
| --------------- | ---------------- | -------------------------------------------- | ------------------------------------------------------------------------------------ |
| `createContact` | `crm:write`      | Creates a CRM contact                        | Tool description ("Only use after confirming…") and system prompt                    |
| `logActivity`   | `crm:write`      | Creates a note or task on a contact          | System prompt only ("Confirm before any tool call that creates or modifies data")    |
| `bookMeeting`   | `calendar:write` | Creates a calendar event (and external sync) | Tool description ("Only after the user/caller confirmed the slot") and system prompt |

Code paths:

- `src/app/api/v1/ai/chat/route.ts`: `onToolUse` → `executeTool(identity, name, input)`
- `src/app/api/v1/voice/webhook/route.ts`: `executeTool(identity, tc.name, tc.arguments)`
- `src/server/ai/tools/index.ts`: the tool registry and `executeTool`

What is enforced today:

- tenant isolation;
- RBAC per tool (`can(role, permission)`);
- input validation (zod).

**Whether the user agreed is not enforced.** A model mistake, an ambiguous message, or a prompt
injection (for example through knowledge-base content, org instructions or a contact's data) can
make the model call a write tool in the same round, without asking.

Live voice (#215) avoids this by offering only read-only tools and refusing write tools in
`executeTool(..., { readOnly: true })`. The voice prompt tells the user to use typed chat for
changes. It does **not** claim that typed chat has a secure confirmation step. Treat typed-chat
confirmation as best-effort model behaviour until this follow-up ships.

## Proposed design (server-enforced two-step)

1. **Propose, don't execute.** For a write tool call, the server doesn't execute. It validates the
   input and stores a _pending action_:
   - fields: `id`, `orgId`, `userId`, `conversationId`, tool name, normalized input, input hash,
     `expiresAt` (for example 10 minutes), `status`;
   - storage: Redis with a TTL, or a table with RLS.

   The tool result sent back to the model is `{ status: "pending_confirmation", summary }`, so it
   tells the user what would happen.

2. **Show a confirmation control.** The client receives a new SSE event, `action_proposed`, with a
   localized, human-readable summary (for example "Book 'Demo' on 1 Oct 09:00–09:30 with Maija"),
   and shows **Confirm / Cancel** buttons. The model's text is not the confirmation.
3. **Confirm through a dedicated endpoint.** `POST /api/v1/ai/actions/{id}/confirm` does the
   following:
   - requires session, same-origin, tenant and RBAC (re-checked at confirm time);
   - atomically marks the action as consumed (single use, not expired, same org and user);
   - executes the stored input, never new model output;
   - records an audit entry;
   - is rate-limited with the shared limiter.
4. **Cancel or expire.** An unconfirmed action expires and nothing happens. Replays are refused.
5. **Phone assistant (Vapi).** There is no UI click on a phone call. The options are:
   - (a) keep the current behaviour, documented as caller-confirmed-by-voice, with an audit trail
     and a post-call review;
   - (b) require an explicit spoken read-back step, enforced by a server-side state machine
     (propose → caller says yes in the _next_ turn → execute).

   This is a product decision.

Tests to add with the implementation:

- a write tool call never writes without a confirm;
- a confirm executes exactly once;
- replay and expiry are refused;
- a user or org other than the proposer is refused;
- an RBAC downgrade between proposal and confirm is refused;
- prompt-injected tool calls produce only a pending action;
- read-only tools are unchanged.

## Decisions needed

- Whether typed chat should always require a click to confirm writes. Recommended.
- The phone-assistant option, (a) or (b).
- The pending-action storage (Redis TTL or database table with an audit link).

## Implemented for typed chat

Code: `src/server/ai/tool-actions.ts`, `src/app/api/v1/ai/actions/[id]/route.ts`,
`src/components/chat/action-confirmation.tsx`.

1. **Proposal.** In typed chat, a write tool call (`createContact`, `logActivity`, `bookMeeting`) never
   runs on the model's call. `describeWriteToolCall` validates it with the same checks as
   `executeTool`: role permission and input schema. It also checks that any referenced contact
   belongs to the organization, and resolves what would happen, such as a booking's duration and the
   calendar timezone.
2. **Pending action.** The action is stored in Redis with a TTL of 10 minutes. It is bound to the
   organization, user and conversation, and carries a SHA-256 digest of the exact tool and
   canonical input.
3. **Client and model.** The client receives an SSE `action` event and shows a localized
   Confirm/Cancel card (EN/FI/AR). The model is told that nothing has happened yet.
4. **Decision endpoint.** `POST /api/v1/ai/actions/{id}` (same-origin, session, `chat:use`, chat
   rate limit) takes `{decision, conversationId, digest}`. One atomic Lua script checks owner,
   conversation, expiry, status and digest, and marks the action decided, so it can run only once.
5. **Execution.** A confirmation runs exactly the stored input through `executeTool`, which checks
   the permission and input again. Unknown, expired and other users' actions all return the same 404. A digest for another action, or for changed arguments, is refused. The decision is audited
   as `ai_action.confirm` or `ai_action.cancel`, with the tool name and outcome but no arguments.
6. **Diagnostics.** Structured `ai_tool_action` logs carry phase, tool, action id, organization id
   and outcome, never the arguments.

Read-only tools run as before. Live voice still refuses write tools. Pending actions are not
persisted with the chat history: after a reload an unconfirmed card is gone and the action expires
unused.
