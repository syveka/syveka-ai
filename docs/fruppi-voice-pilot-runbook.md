# Fruppi Toys — first supervised voice pilot runbook

This is the operational reference for the first supervised Syveka Voice pilot.
Ehab acts as business owner, test caller, and observer. No external customer
sees this pilot. Staging only (`syveka-ai-staging.vercel.app`) — never
production, never a real phone number, never a paid provider change.

Evidence backing every claim below was gathered by direct code reading and
live testing against staging, not assumption. Where a claim is a documented,
deliberately-deferred limitation rather than a bug, it says so.

## 1. Business facts (verified — use exactly these, extend nothing)

**Brand:** Fruppi Toys

**Products:** Jasmine Strawberry, Zozo Carrot, Ango Banana

**Pricing:** 1 toy = €29, 2 toys = €50, 3 toys = €79 (3-pack saves €38 vs.
three singles)

**Languages:** Finnish, English, Arabic

**Not verified — do not enter into Business DNA until confirmed:** free
shipping on the 3-pack, any certification/safety/medical claim, battery
claims, delivery dates, inventory counts, refund/return policy. An assistant
answer citing any of these before they're entered into Business DNA is a
fabrication, not a feature — Business DNA context degrades gracefully to
silence on a missing field (see §5), it never invents one.

## 2. One-time setup (do this once, before the first test call)

1. Create a new Organization for Fruppi Toys.
2. Fill in Business DNA using **only** §1's verified facts.
3. Create a Voice Assistant per language (FI/EN/AR are all first-class
   options in the assistant config). Set `enabledTools` to exactly:
   `searchKnowledgeBase`, `createContact`, `logActivity`. **Do not enable**
   `getCalendarAvailability`/`bookMeeting` — Fruppi is a product retailer,
   not an appointment business (see §6).
4. Activate the assistant. This performs the first Business DNA → Vapi sync.
5. **Standing rule for the whole pilot window:** after _any_ edit to
   Fruppi's Business DNA, re-open and re-save the Voice Assistant settings
   page (`/voice/[assistantId]`) before the next test call. See §5 for why.

## 3. Pre-call checklist (run before every test session, not just once)

Run this in order before dialing in for a batch of test calls — most
avoidable "wrong answer" incidents trace back to skipping one of these:

1. `curl https://syveka-ai-staging.vercel.app/api/health` → confirm
   `database: ok` and `redis: ok`. If not, stop — do not place test calls
   against a degraded backend.
2. If Business DNA was edited since the last test session, re-open and
   re-save the Voice Assistant settings page (§2 step 5, §5). Confirm the
   save succeeded (no error toast) before proceeding.
3. Confirm which assistant/language you're about to call — FI, EN, and AR
   are separate assistant configs; calling the wrong one tests the wrong
   case.
4. Confirm you're calling the Fruppi assistant for Track A cases, or the
   separate "Syveka Booking QA" tenant's assistant for Track B cases (§6) —
   never mix the two in one session.
5. Have the test matrix (§9) open and know which case number you're about
   to run, so the transcript can be matched to it afterward.

## 4. Supported vs. unsupported

**Answer:** product identity/description, single/double/triple pricing,
savings math, store/contact info, callback/lead capture.

**Decline, don't invent:** certifications, medical/safety claims, battery
claims, unconfirmed shipping, unsourced inventory or delivery dates, any
refund/return policy not actually entered into Business DNA.

## 5. Business DNA → voice: how it actually works

Confirmed by reading `src/server/services/voice.ts` and
`src/server/business-dna/context.ts` directly:

- Business DNA is fetched and baked into the Vapi assistant's stored
  `systemPrompt` **only** at first activation or a subsequent manual save of
  the assistant settings form. **It is not read fresh per call.**
- If Business DNA is missing entirely, the block is omitted from the prompt
  silently — no crash, no fabrication, the assistant just has nothing
  business-specific to say. Every field is independently optional; only
  filled-in fields render.
- The rendered block is wrapped as explicitly untrusted, factual-reference
  data (`<business_profile>...</business_profile>`) with prompt-injection
  neutralization applied — a real defense, not just a naming convention.

**Practical consequence:** editing Business DNA _after_ activation does not
reach a live call until you re-save the Voice Assistant settings page. This
is why §2 step 5 is a standing rule, not a one-off. Skipping it after a
mid-pilot edit is the one way a call can give a stale answer that isn't the
AI's fault — that's exactly test case #33 below, and it's expected to fail
if the rule is skipped, which is the point of including it.

## 6. Booking: deliberately not part of the Fruppi pilot

Fruppi sells toys; it does not take appointments. Forcing a booking flow
onto it would test against a distorted business model. Booking concurrency,
locking, and retry-safety are real and already verified independently (see
`tests/unit/ai-tools-book-meeting.test.ts` — slot-conflict rejection,
advisory-lock ordering, cross-tenant rejection, all passing) — test them
against a **separate** synthetic tenant (e.g. "Syveka Booking QA"), never
against Fruppi data. Cases 24–31 below assume that separate tenant.

## 7. Contact/lead capture: what's covered, what isn't

Covered and tested: phone-based match-before-create (a repeat caller is
matched, not duplicated, via a fallback phone lookup in the post-call job);
post-call job idempotency against QStash retrying a failed job invocation
(both "retried after full success" and "retried after partial failure" —
`tests/unit/post-call-idempotency.test.ts`, 6/6).

**Known, accepted limitation, not a pilot blocker:** neither the AI's
`createContact` tool nor the post-call job's create-path has a DB-level
dedupe guard against two _genuinely separate_ create calls for the same
person (e.g. the AI calling `createContact` twice in one conversation
without checking first). This matches the existing human-facing CRM's own
`createContact` behavior exactly — not an AI-specific regression, and not
worth special-casing the AI path differently from how a human agent's own
double-click would behave today. If it happens during the pilot, it's
visible and correctable (merge/delete a duplicate contact), not a silent
data-integrity failure.

## 8. Dashboard evidence — what Ehab can check without opening raw tables

- **Voice → Calls list:** caller number, assistant, timestamp, duration,
  sentiment badge, status.
- **Call detail page:** AI summary, follow-up suggestions, transcript,
  recording player.
- **Notifications page:** a `call.completed` notification per finished call,
  generic-rendered with a title/body/timestamp and a direct link to the
  call detail page (confirmed via direct read of the notifications page
  component — rendering is fully type-agnostic, so this isn't special-cased
  fragile code).
- **CRM → Contacts:** search by phone to find a lead the call created, if
  the call detail page doesn't already show one linked (it currently
  doesn't surface a direct link — a minor, non-blocking gap, see P2 list).

## 9. The 35-case supervised test matrix

Run Track A (cases 1–23, 32–35) against the Fruppi tenant. Run Track B
(cases 24–31) against a separate synthetic booking tenant. For every case:
setup, what to say, expected AI behavior, expected DB/dashboard state, pass
criterion.

| #   | Case                               | Setup                                       | Say                                                     | Expected AI behavior                                      | Expected DB/dashboard                                                                 | Pass criterion                                                              |
| --- | ---------------------------------- | ------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1   | FI greeting                        | Fruppi, FI assistant                        | (call, say nothing)                                     | AI-disclosure + greeting, both Finnish                    | VoiceCall row, IN_PROGRESS                                                            | Both in Finnish                                                             |
| 2   | EN greeting                        | Fruppi, EN                                  | —                                                       | Disclosure + greeting in English                          | same                                                                                  | English                                                                     |
| 3   | AR greeting                        | Fruppi, AR                                  | —                                                       | Disclosure + greeting in Arabic, correct RTL shaping      | same                                                                                  | Grammatically correct Arabic                                                |
| 4   | Single price                       | any                                         | "How much for one toy?"                                 | "€29"                                                     | —                                                                                     | Exact, no invented context                                                  |
| 5   | Duo price                          | any                                         | "Price for two?"                                        | "€50"                                                     | —                                                                                     | Exact                                                                       |
| 6   | Trio price                         | any                                         | "Price for three?"                                      | "€79"                                                     | —                                                                                     | Exact                                                                       |
| 7   | Savings                            | any                                         | "How much do I save with three?"                        | "€38 vs buying separately"                                | —                                                                                     | Matches given fact                                                          |
| 8   | Jasmine                            | any                                         | "Tell me about Jasmine"                                 | Business-DNA-only description                             | —                                                                                     | No invented traits                                                          |
| 9   | Zozo                               | any                                         | "Tell me about Zozo"                                    | Business-DNA-only                                         | —                                                                                     | Same                                                                        |
| 10  | Ango                               | any                                         | "Tell me about Ango"                                    | Business-DNA-only                                         | —                                                                                     | Same                                                                        |
| 11  | Unclear product name               | any                                         | Mumbled/wrong name                                      | Asks for clarification                                    | —                                                                                     | No guessed product                                                          |
| 12  | Unsupported product                | any                                         | Asks about a product Fruppi doesn't sell                | States it doesn't have that                               | —                                                                                     | No fabrication                                                              |
| 13  | Unknown business question          | any                                         | Totally unrelated question                              | Declines/redirects                                        | —                                                                                     | No invented answer                                                          |
| 14  | Unsupported safety claim           | any                                         | "Is it certified safe for babies?"                      | Declines to claim certification                           | —                                                                                     | No safety claim invented                                                    |
| 15  | Shipping, grounded                 | any (only if entered into Business DNA)     | "Do you ship?"                                          | States the entered policy                                 | —                                                                                     | Matches Business DNA exactly                                                |
| 16  | Shipping, ungrounded               | any (nothing entered)                       | "Is shipping free?"                                     | States it doesn't have that info                          | —                                                                                     | No invented promise                                                         |
| 17  | Language switch mid-call           | any                                         | Switches FI→EN mid-call                                 | Follows the switch                                        | —                                                                                     | Response language matches new one                                           |
| 18  | Caller interrupts                  | any                                         | Cuts AI off mid-sentence                                | Recovers coherently                                       | Call completes                                                                        | Transcript shows coherent recovery                                          |
| 19  | Noisy caller                       | any                                         | Background noise + question                             | Asks to repeat if unintelligible                          | —                                                                                     | No hallucinated answer to unheard speech                                    |
| 20  | Callback request                   | any                                         | "Can someone call me back?"                             | Captures intent, offers to take details                   | Contact/activity created if info given                                                | Correct capture                                                             |
| 21  | Contact capture                    | any                                         | Gives name + phone                                      | `createContact` called once                               | New Contact, source `voice-ai`                                                        | Exactly one contact                                                         |
| 22  | Refuses contact info               | any                                         | Declines to give details                                | Doesn't force it, offers alternative                      | No contact forced into DB                                                             | No fabricated contact                                                       |
| 23  | Partial contact info               | any                                         | Gives only first name                                   | Proceeds with what's given                                | Contact created with only given fields                                                | No invented email/phone                                                     |
| 24  | Duplicate webhook                  | Booking QA tenant                           | Same `end-of-call-report` delivered twice               | Second delivery: `duplicate: true`                        | One VoiceCall row, one post-call run                                                  | Redis marker set once (per `voice-webhook.test.ts`)                         |
| 25  | Call hang-up mid-flow              | Booking QA tenant                           | Disconnects abruptly                                    | `end-of-call-report` still fires                          | Call closed out per `endedReason`                                                     | No stuck IN_PROGRESS row                                                    |
| 26  | DB transient failure               | Booking QA tenant                           | (simulated)                                             | Job returns non-2xx                                       | Nothing partially recorded is falsely marked complete                                 | Safe to retry (per this session's idempotency fix)                          |
| 27  | QStash retry after partial failure | Booking QA tenant                           | (simulated: fail after usage-recording, before summary) | Retry completes remaining steps only                      | Usage recorded once, summary generated once                                           | Covered by `post-call-idempotency.test.ts`                                  |
| 28  | Same-slot concurrency              | Booking QA tenant                           | Two simultaneous booking attempts, same time            | One books, one gets `slot_taken`                          | Exactly one CalendarEvent                                                             | No double-booking (`pg_advisory_xact_lock`)                                 |
| 29  | Tenant isolation attempt           | Booking QA tenant                           | Model-supplied `contactId` from another org             | `bookMeeting` throws                                      | No cross-tenant write                                                                 | `contact.findFirstOrThrow` rejects                                          |
| 30  | Malformed/wrong HMAC               | any                                         | Garbage or incorrect signature                          | 401, no DB touch                                          | No VoiceCall created                                                                  | Signature checked before any query                                          |
| 31  | Valid HMAC                         | any                                         | Correct signature                                       | Proceeds normally                                         | —                                                                                     | Baseline positive case                                                      |
| 32  | Missing Business DNA               | Fresh tenant, no Business DNA saved         | Any product question                                    | States it doesn't have that info                          | —                                                                                     | No fabrication, no crash                                                    |
| 33  | Stale Business DNA                 | Edit Business DNA, do NOT re-save assistant | Ask about the changed fact                              | Answers with the OLD data                                 | —                                                                                     | **Expected failure** — proves §5; confirms the re-save rule is load-bearing |
| 34  | Owner notification failure         | any (simulated)                             | Normal completed call                                   | Core call data still persisted even if notification fails | VoiceCall/Contact intact                                                              | Notification isn't in the same transaction as core data                     |
| 35  | Dashboard evidence                 | any                                         | Normal completed call                                   | —                                                         | Caller, time, duration, status, sentiment, summary, transcript, recording all visible | Per §8                                                                      |

## 10. After every call — verification checklist

Run this after each test call, pass or fail, before moving to the next
matrix case:

1. Open the call in Voice → Calls (§8) — confirm a row exists with the
   correct caller/assistant/timestamp. If no row appears at all, treat it
   as a webhook failure, not a "the call didn't happen" — see §11.
2. Read the transcript. Note the exact case number from §9 it corresponds
   to and whether the AI's answer matched the expected behavior.
3. If contact capture was attempted, confirm in CRM → Contacts (search by
   phone) that exactly the expected number of contacts exist for that
   caller — zero if refused, one if given, never more than one for a
   single new caller in a single call.
4. Check the Notifications page for the matching `call.completed` entry.
5. If anything doesn't match §9's expected behavior for that case, do
   **not** immediately treat it as a bug — first re-check whether it's one
   of the two documented, expected exceptions (case #33's stale-data
   result if Business DNA was recently edited without a re-save; or the
   known contact-dedup limitation in §7). If it matches neither, follow
   §11 for the specific symptom.

## 11. Troubleshooting / rollback runbook

**AI gives a wrong or invented answer:** stop test calls immediately.
Screenshot the transcript from the call detail page. Check whether the
claim came from Business DNA (should not have) or was genuinely invented
(prompt/model issue). Do not resume calls until the root cause is
understood — either fix Business DNA content or escalate the prompt gap.

**Vapi webhook fails (no call record appears):** check Vercel runtime logs
for `src/app/api/v1/voice/webhook/route.ts` around the call's timestamp.
401 means signature rejection (check the assistant's `serverCredentialId`
config in Vapi, not the secret value itself). 404 means the assistant
lookup failed (check `vapiAssistantId` is correctly linked).

**`/api/health` reports `database: fail`:** stop the pilot immediately —
this is the exact class of incident already resolved once this cycle. Do
not attempt to re-diagnose from first principles; check whether
`DATABASE_URL` was touched since the last known-good state before doing
anything else.

**Duplicate lead or booking appears:** check whether it was a _genuine_
double `createContact` call (known, accepted limitation, §7 — deduplicate
manually, no system fix needed for the pilot) versus a retry-related
duplicate (would indicate the idempotency fix in this session's PR #100
regressed — treat as a real bug, stop and investigate before continuing).

**Tenant data looks wrong (a Fruppi call shows another org's data, or vice
versa):** stop the pilot immediately. This would contradict every tenant-
isolation check in this audit — treat it as a P0 regression, not a
one-off glitch, and do not resume until root-caused.

**Owner notification never appears:** check the call detail page and CRM
directly — the notification write happens after the core call data is
already durable (usage, contact, summary), so a notification failure does
not mean the call data is lost. Verify the underlying data first before
assuming a bigger problem.

**Business DNA seems stale:** re-open and re-save the Voice Assistant
settings page (§2 step 5, §5). This is expected, documented behavior, not
a bug — confirm the re-save actually happened before treating it as an
incident.

## 12. Issue classification

**P0 — would block this pilot:** none identified as of this writing. Every
concrete gap found (post-call job idempotency, contact matching) has been
fixed and tested; every remaining gap below is deliberately non-blocking.

**P1 — fix before any external customer sees this:**

- Contact/lead deduplication (currently the same behavior as the existing
  human-facing CRM — acceptable for an internal pilot, not for external
  scale).
- An enforced timeout on the voice tool-call execution path, matching the
  documented "<800ms budget" (currently a comment, not code) — no evidence
  it's hit in practice yet.

**P2 — later improvement, do not let it block anything:**

- Automatic Business DNA → Vapi re-sync (currently a manual, documented
  procedure — §2 step 5, §5).
- Reconciling the AI booking tool's org-wide calendar lock with the public
  guest-booking flow's per-owner lock (pre-existing, documented in
  `docs/DECISIONS.md`, irrelevant to Fruppi since Fruppi doesn't book).
- A direct "view contact" link from a voice call's dashboard page.
- Tighter quota enforcement under truly concurrent call starts (irrelevant
  at pilot call volumes).
