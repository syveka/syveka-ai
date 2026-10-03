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

Read-only tools run as before. Live voice still refuses write tools.

**Reopening a conversation.** The proposed action view is saved with the assistant reply, in the
message's tool-call log. When the conversation is opened again, each saved action shows its
**recorded** outcome:

- the outcome comes from the audit trail (`ai_action.confirm` / `ai_action.cancel`, this
  organization only): done, canceled, slot taken or failed;
- consumed failures are audited as `failed`;
- with no record, the action is either still pending (the card can still be decided, and the server
  enforces everything) or shown as "no result recorded" once it has expired.

Nothing is inferred from the reply's wording or from matching records. Messages saved before this
change have no action view and show none. A reply whose stream was aborted or blocked by output
moderation is not saved, so its card can't come back.

## Staging acceptance evidence

### Android Chrome, staging release #121 (`dd1e2c1`, includes #224 and #225), QA organization

**Date:** 2026-10-03, after release #121 completed at about 16:18 UTC.

**Evidence types:**

- **Screenshot:** an image the user shared. These were reviewed in the user's QA session; the
  release coordinator didn't have them in context.
- **User report:** the user's statement, with no image.
- **Logs:** staging runtime logs with paths, status codes and content-free events only.
- **Automated:** tests in #224 and #225, which used mocked providers and desktop Chromium.

| Check                                                                 | Result          | Evidence                                                                                                                                                                                                  | Limits                                                                                                                                         |
| --------------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Pipeline stage labels follow FI/EN/AR                                 | Pass            | User report                                                                                                                                                                                               | Custom-name preservation is covered by automated tests only                                                                                    |
| Cancel, then reopen ("QA Reopen Test 7")                              | Pass            | Screenshot after reopening: "Canceled. Nothing was changed.", no Confirm/Cancel. Logs: `proposed` 16:24:13, `canceled` (200) 16:24:40, no record-write error, conversation reloaded 16:24:41 and 16:27:49 | The Contacts screenshot is a visual check, not a database query                                                                                |
| Confirm, then reopen ("QA Reopen Test 8")                             | Partly verified | User report: completed. A later screenshot shows a preceding "Done." card, but the contact name is cropped                                                                                                | Persistence for this exact card, and exactly one contact, are not independently established                                                    |
| Pending, expired, then reopen ("QA Reopen Test 9")                    | Pass            | Screenshot after about 30 minutes and a refresh: "This request is no longer available. No result was recorded for it.", no buttons                                                                        | None for the expired display                                                                                                                   |
| Pending, then reopen within the validity window ("QA Reopen Test 10") | Partly verified | Screenshot: Confirm/Cancel still shown. User report: then canceled                                                                                                                                        | The refresh itself isn't visible in the screenshot. Showing the card again after a reload is covered by automated tests (live-store `pending`) |

**Still unverified on a phone:**

- Exactly one contact after a Confirm that is then reopened.
- The "unknown" outcome display (automated tests only, by design: it needs a failed record write).
- Confirm as the first message of a genuinely new chat.

### Android Chrome, staging release #120 (`e9a61b4`), QA organization

**Date:** 2026-10-03, about 13:34–13:45 Helsinki (10:34–10:45 UTC).

**Observed by the user:**

1. "Create a contact named QA Cancel Test 2". One screenshot first showed only the reply text
   ("When you confirm…"). A later screenshot showed the `createContact` badge and the card with
   Confirm and Cancel.
2. Cancel was tapped. "QA Cancel Test 2" was not found in Contacts. The older contact "QA Cancel
   Test" (without "2") is a separate, earlier record.
3. "Create a contact named QA Confirm Test 3", then Confirm. Contacts showed "QA Confirm Test 3"
   once.
4. Returning to Chat showed the empty new-chat screen. Going back showed the earlier conversation,
   with both requests in one conversation. It had the "When you confirm…" text, but no card or
   outcome.

**Staging runtime logs** (paths, status codes and content-free events only; ids shortened to hashes):

| UTC         | Request                           | Result                                                   |
| ----------- | --------------------------------- | -------------------------------------------------------- |
| 10:37:25    | `GET /en/chat`                    | new chat page                                            |
| 10:37:32    | `POST /api/v1/ai/chat`            | `createContact` **proposed** (`#cff69a`)                 |
| 10:37:47    | `POST /api/v1/ai/actions/#cff69a` | 200, **canceled**                                        |
| 10:37:48–49 | `GET /en/chat/<1ea8a2>` ×2        | the new chat's held redirect, right **after** the Cancel |
| 10:39:06    | `POST /api/v1/ai/chat`            | `createContact` **proposed** (`#0a16ce`)                 |
| 10:39:19    | `POST /api/v1/ai/actions/#0a16ce` | 200, **confirmed, done**                                 |
| 10:40:21    | `GET /en/chat`                    | the new-chat page (the "empty chat" screen)              |
| 10:45:29    | `GET /en/chat/<1ea8a2>`           | the conversation reopened                                |

**Supported by the evidence:**

- The first request proposed the action, on the first call.
- Cancel created nothing, and Confirm created exactly one contact.
- The new chat's redirect happened only after the Cancel was decided, which is #223's behavior.
- Earlier conversation text could be reopened.
- The reopened conversation showed no card or outcome, because the action wasn't saved with the
  message. The reopen change above addresses this.

**Not proven:**

- Exactly-once navigation on the phone. There are two page requests, consistent with the redirect
  plus refresh.
- Why the first screenshot had no card. Within one live reply the card can't arrive after the text:
  a test locks this order, and text is held until output moderation. But the card is drawn **below**
  the text in the bubble, and a reopened conversation had no card. Either could explain the
  screenshot.
- A Confirm as the first message of a genuinely new conversation (the Confirm test ran in an
  existing conversation).
- The remaining #223 edge cases on a phone.
