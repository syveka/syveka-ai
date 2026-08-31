# Syveka Conversations / AI Sales-DM Agent — Architecture Specification

Status: **specification only**. NEXT-classified per `docs/skills/AI-FOUNDATION.md`'s roadmap — no
channel integration (Instagram/WhatsApp/Messenger/website chat) is built in this pass. This
document exists so that when one of those channels is greenlit, it plugs into an already-designed
architecture instead of inventing its own contact model, knowledge source, or escalation path.

Inspired by patterns visible in tools like SendRad (comment→DM, AI qualification, human takeover)
— no proprietary implementation or UI is referenced or copied; only the conceptual flow shape.

## The one architectural principle that must hold from day one

**The same approved Business DNA that already powers Voice and Chat must power every future DM
channel too.** Concretely: any future channel handler calls
`getBusinessDnaContext(orgId)` (`src/server/business-dna/context.ts`) — the existing canonical
boundary — exactly the way `voice.ts`, `inbox-ai.ts`, and the chat route already do. **A DM agent
must never read `BusinessDNA`/`BusinessDnaService` directly, cache its own copy, or maintain a
parallel prompt-formatting path.** This is not a new rule invented for this document — it is the
existing rule (`docs/business-dna-mvp.md`: "Consumers must use it instead of re-querying or
hand-formatting Business DNA") extended to a channel that doesn't exist yet.

## Target flow

```
CUSTOMER MESSAGE (Instagram DM / WhatsApp / Messenger / website chat)
        │
        ▼
IDENTIFY / CREATE CONTACT ── reuses existing CRM Contact model + tenant-scoped creation,
        │                     not a new "DM contact" table (src/server/services/contacts.ts equivalent)
        ▼
APPROVED BUSINESS DNA ── getBusinessDnaContext(orgId), unchanged
        │
        ▼
AI RESPONSE ── routeModel("chat") or a new "conversational" task class (see below),
        │       same streamClaude()-style provider wrapper already used by /api/v1/ai/chat
        ▼
LEAD QUALIFICATION ── structured output against a fixed schema (qualified / needs-info / not-fit),
        │              not a free-text judgment call buried in the reply itself
        ▼
CRM ── existing Deal/Contact/Activity models, existing tenantDb scoping — no new pipeline concept
        ▼
BOOKING / ACTION ── existing calendar/booking services (src/server/services/calendar-*),
        │            existing booking-assistant.ts pattern, not a new booking path per channel
        ▼
HUMAN TAKEOVER ── a channel-agnostic "handoff" state on the conversation/thread record,
        │          reusing the existing Inbox thread-status concept (src/server/services/... inbox)
        │          rather than inventing a second thread model for DMs specifically
        ▼
FOLLOW-UP ── reuses the existing notification/reminder job pattern
             (src/app/api/v1/jobs/send-reminder) rather than a new scheduler
```

## Comment-to-DM (future feature within this architecture, not built)

```
COMMENT → AUTO DM → AI CONVERSATION → QUALIFY → BOOK / SELL
```

Slots into the same flow above starting at "CUSTOMER MESSAGE" — a comment-triggered DM is just
another message-origination event feeding the identical pipeline, not a parallel one. The only new
piece a real implementation would need is a channel-specific webhook receiver (Instagram Graph
API's comment webhook) that produces a normalized "customer message" event and hands off to the
same flow — that receiver is channel-specific plumbing, everything after it is shared.

## Model routing implications

A new `conversational` (or reuse `chat`) task class in `src/server/ai/router.ts` fits the existing
`AiTask` union without restructuring it — DM replies have the same latency/quality tradeoff as the
existing web chat, so reusing `"chat"` directly (Sonnet 4.5) is the simplest correct choice unless
a future volume/cost analysis says otherwise. Lead qualification's structured-output step is closer
to the existing `"utility"` class (Haiku, cheap, deterministic-shaped output) — two task classes,
not one, for two different jobs in the same flow, matching Phase 4's own "high-volume simple tasks
→ economical model" principle.

## Security / tenant-isolation implications (must hold, not new)

- Every inbound DM must resolve to exactly one `organizationId` before any Business DNA or CRM
  read/write happens — same `tenantDb(ctx.orgId)` discipline as every other Syveka surface. A
  channel webhook authenticating a message to the _wrong_ org is a tenant-isolation bug of the
  worst kind (cross-tenant data exposure via chat), so channel-account-to-org mapping needs the
  same rigor as Supabase session resolution gets today (`src/server/auth/session.ts`).
- Untrusted external content: a customer's DM text is user input like any inbound Server Action
  payload — validate with the same `zod` discipline as every other Syveka form, not a special DM
  exemption.
- Rate limiting: a new limiter (following `src/server/integrations/redis.ts`'s existing pattern —
  e.g. `dmInbound`, per-org and per-external-contact) before any channel goes live, matching the
  existing `inboxEmailWebhook` limiter's precedent for inbound-webhook-driven AI work.

## What this pass actually shipped for AI Sales/DM

- This specification document only. No channel integration, no new database model, no new API
  route, no new dependency. Explicitly NEXT/LATER per the roadmap classification in
  `docs/skills/AI-FOUNDATION.md` — not started per the mission's own instruction not to build every
  social integration without substantial existing infrastructure.
