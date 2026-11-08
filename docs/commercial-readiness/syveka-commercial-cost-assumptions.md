# Syveka — operating cost assumptions and required measurements (2026-11-08)

**Status: assumptions only.** No paid provider call was made for this document. No invoice,
dashboard or usage export was read.

The per-token prices below are the constants the application itself uses to estimate spend
(`src/server/ai/cost.ts`). They are **not verified** against current provider price lists and
may be out of date. This document deliberately recommends no selling price.

## 1. What drives cost, from the code

| Cost source                     | Where it's incurred                                             | Model or service (from code)                                                                                   | Controlled by                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI chat turn                    | `src/app/api/v1/ai/chat/route.ts`                               | Route `chat` → `claude-sonnet-4-5`, max 4096 output tokens, up to 5 tool rounds (`src/server/ai/router.ts:25`) | <ul><li><code>aiMessagesPerOrgMonth</code> (FREE 50, STARTER 1,000, PRO 5,000)</li><li>per-user/org rate limiters</li><li><code>assertAiSpendAllowed</code></li></ul> |
| Utility calls                   | Titles, sentiment, summaries, meeting summaries, extraction     | `claude-haiku-4-5-20251001` (`router.ts:27-30`)                                                                | Same quota for most; meeting summary counts against the AI quota                                                                                                      |
| Deep route                      | Where `deep` is selected                                        | `claude-opus-4-8`, max 8192                                                                                    | Not used by the pilot package as far as traced; confirm before pricing                                                                                                |
| Fallback                        | Anthropic unavailable                                           | `gpt-4o` (`router.ts:44`)                                                                                      | Automatic                                                                                                                                                             |
| Moderation                      | Chat and public assistant                                       | OpenAI moderation                                                                                              | —                                                                                                                                                                     |
| Embeddings                      | KB ingestion job                                                | `text-embedding-3-small` (`src/server/integrations/openai.ts:22`)                                              | <ul><li><code>kbStorageMb</code> (FREE 50 MB, enforced as of this branch)</li><li>up to 2M extracted characters and 1,000 chunks per document</li></ul>               |
| Public marketing assistant      | `/api/v1/public-assistant` (anonymous)                          | Haiku, max 512                                                                                                 | IP limiter that fails closed                                                                                                                                          |
| Email                           | Booking confirmations, reminders, invitations                   | Resend                                                                                                         | Volume equals bookings × (confirmation + reminders + lifecycle mails)                                                                                                 |
| Platform                        | Hosting, database, Redis, queue                                 | Vercel, Supabase, Upstash Redis and QStash                                                                     | Plan tiers. **Unknown**: the current plans and their fixed cost were not inspected                                                                                    |
| Voice (excluded from the pilot) | Vapi plus telephony plus speech-to-text/text-to-speech plus LLM | See `docs/live-voice-cost-report.md` (estimates only)                                                          | Voice minutes; excluded                                                                                                                                               |
| Creator Studio (excluded)       | FAL image/video                                                 | Credit ledger                                                                                                  | Flag off                                                                                                                                                              |

## 2. In-code price constants (USD per 1M tokens, unverified)

| Pattern         | Input | Output |
| --------------- | ----- | ------ |
| `claude-opus`   | 15    | 75     |
| `claude-sonnet` | 3     | 15     |
| `claude-haiku`  | 0.8   | 4      |
| `gpt-4o`        | 2.5   | 10     |
| `gpt-4o-mini`   | 0.15  | 0.6    |
| default         | 3     | 15     |

### Illustrative arithmetic (assumption, not a measurement)

**Assumed turn:** 6,000 input tokens (system prompt, Business DNA, CRM and KB context, history)
and 500 output tokens.

At the in-code Sonnet rates:

- 6,000 × 3 / 1M = $0.018 input
- 500 × 15 / 1M = $0.0075 output
- **≈ $0.026 per turn** with no tool rounds

Each tool round resends the context, so a turn with 2 tool rounds could cost about 3× that.

| Plan        | AI messages / org / month | Upper bound at $0.026–$0.08 per turn |
| ----------- | ------------------------- | ------------------------------------ |
| FREE        | 50                        | about $1.30–$4.00                    |
| STARTER cap | 1,000                     | about $26–$80                        |

STARTER's displayed list price is €29 per seat per month, excluding VAT
(`src/lib/billing/plan-catalog.ts`). A single-seat STARTER organization that uses its full
pooled quota with tool-heavy turns could therefore cost more in AI than it pays. **Measure
before pricing** (§3).

Known metering gaps that make measured spend an **under**-estimate until they are fixed
(launch-blockers B11):

- aborted typed turns record no usage;
- concurrent requests can overshoot the quota.

## 3. Measurements required before a paid price is set

The rows that are read-only database reads use existing tables. The owner should run them
against the pilot environment, read-only.

| Measurement                                                                 | Source                                                                                                 | Why                                                    |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| Average and P95 input/output tokens per chat turn, and tool rounds per turn | `ai_spend` / usage records written by `recordAiSpend` and `recordUsage` (`AI_TOKENS_*`, `AI_MESSAGES`) | The real cost per message                              |
| Real provider invoices versus in-app estimates for the same period          | Anthropic, OpenAI and Resend billing dashboards (owner)                                                | Validate `cost.ts` constants                           |
| Messages per active organization per month                                  | `AI_MESSAGES` usage per organization                                                                   | Is the quota sized right?                              |
| Embedding tokens per MB of uploaded documents                               | Embed job usage plus document sizes                                                                    | KB cost per GB                                         |
| Emails per booking                                                          | Resend dashboard / notification rows                                                                   | Email cost per booking                                 |
| Fixed monthly platform cost                                                 | Vercel, Supabase and Upstash plans (owner)                                                             | Break-even organization count                          |
| Support hours per pilot organization per week                               | Owner log during the pilot                                                                             | Manual onboarding cost (no CSV import, grants by hand) |

## 4. Unknowns

- Current provider list prices. The constants in code may be stale.
- Whether the `deep` (Opus) route is reachable from the pilot package's flows.
- Platform plan tiers and their limits (database size, connection pooling, QStash message
  quota).
- Any VAT or currency effects. Prices in code are EUR excluding VAT; provider costs are USD.
