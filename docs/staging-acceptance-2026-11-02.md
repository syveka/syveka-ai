# Staging acceptance record — 2026-11-02

Manual acceptance of the staging release of `62af0635be6751f7d32735d6fda0329e96f8c592`
(PR #385 merge), in the test organization `syveka-pilot-acceptance-test`, on a Samsung Android
phone.

- Deployed by [run 41453444188](https://github.com/syveka/syveka-ai/actions/runs/41453444188)
  (workflow file from main `a02b4d6`, the #390 merge).
- Re-checked at 2026-11-02 23:38 UTC: `/api/health` reports `healthy`, database `ok`, Redis `ok`, build
  `62af0635be6751f7d32735d6fda0329e96f8c592`.
- The fixes below are in draft PRs. They are **not deployed**, so nothing here was observed with
  them on a device.
- No SQL, Checkout, email, message or paid provider call was made for this record.

**Evidence labels.**

- **Owner-observed**: Ehab did it on the phone on 2 November 2026 and reported the result. Claude
  did not perform these steps.
- **Automated**: a test in this repository. A mocked test proves code behavior, not a live device,
  browser or provider.

## Summary

| Area                      | Result                                                    | Status               |
| ------------------------- | --------------------------------------------------------- | -------------------- |
| Chat → Business DNA       | Preview, cancel, confirm, restore and audit rows work     | OWNER-OBSERVED PASS  |
| Audit log on Arabic page  | Change-details JSON hard to read (direction)              | FAIL → fixed in PR   |
| Listen, Samsung Internet  | Arabic reply is read aloud                                | OWNER-REPORTED PASS  |
| Listen, Chrome            | 92 voices listed, none Arabic; nothing read               | FAIL, unresolved     |
| Billing display           | Monthly and annual amounts and copy as designed           | OWNER-OBSERVED PASS  |
| Stripe Price objects      | Not inspected                                             | BLOCKED              |
| Inbox                     | No receiving address for the pilot org; warning shown     | BLOCKED (config)     |
| Workflow, contact trigger | New contact → one CRM activity, run succeeded             | OWNER-OBSERVED PASS  |
| Workflow, Test run        | Fails without a contact; explained only after the failure | UX gap → fixed in PR |
| TalkBack                  | No reliable result                                        | NOT COMPLETED        |
| FI/EN browser journeys    | Not performed in this session                             | NOT TESTED           |

## A. Chat → Business DNA

**Owner-observed pass.**

- Original short description: `نشاط لاختبار الملف التجاري والحجوزات، ولا يستقبل عملاء حقيقيين.`
- Temporary test description: `شركة تجريبية لاختبار تحديث الهوية التجارية من الدردشة`

What Ehab observed:

1. The preview showed the old and the proposed short description.
2. Cancel left the original description unchanged.
3. A confirmed proposal saved the temporary description.
4. Settings showed the temporary description after navigating back.
5. A confirmed restoration returned the original description.
6. Settings then showed the restored original.
7. Audit entries appeared for the confirmed changes.
8. A later request to set the already-restored description got a no-change reply, not a new
   confirmation card. This was seen in the chat only; a database-level no-op was not verified.

**Audit rows.** One confirmed change writes two rows; that is not a duplicate business update.

- `ai_action.confirm` (`src/app/api/v1/ai/actions/[id]/route.ts`) records the decision. Its
  `after` is `{ tool, outcome }`, which matches the payload
  `{"tool":"proposeBusinessDnaUpdate","outcome":"done"}`.
- `business_dna.update` (`src/server/services/business-dna-patch.ts`) records the change. Its
  `after` holds `fields`, `via: "ai_chat"`, `actionId` and `conversationId`, which matches the
  restoration payload (before: temporary, after: original, `actionId`
  `b19dfc96-efff-4f88-89ff-bcaf5be12e02`).
- When copying the restoration payload, "ai_action.confirm" was appended to it. In code, that
  payload shape is written only under `business_dna.update`. There is no evidence of a mislabeled
  event.

## B. Audit log readability on an Arabic page

**Owner-observed fail; fixed in a draft PR, not deployed.**

- **Observation.** The Arabic mobile screenshot showed the raw before/after JSON with
  reversed-looking punctuation and confusing alignment.
- **Root cause (proven).** The details `<pre>` had no direction, so on Arabic pages it inherited
  RTL. The Unicode bidi algorithm then reordered braces, quotes, colons and commas around the Latin
  keys and the Arabic values. The action code above it already had `dir="ltr"`.
- **Fix** (branch `fix/audit-log-bidi`, PR #391).
  - The details block always lays out left to right.
  - Each string value is wrapped in `<bdi>`, so an Arabic value keeps its own order and its
    trailing punctuation.
  - The stored data, the visible text and horizontal scrolling are unchanged.
- **Tests.** `tests/unit/audit-log-page-timezone.test.tsx` renders the real page in Arabic with
  the observed restoration payload.
  - It asserts that the block is LTR and each value isolated, including escaped quotes, a
    newline/tab/backslash value, an Arabic URL with a query and a mixed Arabic/Latin value.
  - It asserts that the visible text equals the stored JSON exactly and parses back to it, and
    that the canonical action code is shown as stored.
  - The isolation test fails on unchanged main.
- **Local browser check (automated, not a device).** The real page's server markup was rendered
  in Arabic into a static page and opened in desktop Chrome at a 360 px page width:
  - the fixed block computes `direction: ltr`; the main version computes `rtl` and shows the
    braces mirrored and the key/value order rearranged, as observed on the phone;
  - both blocks are 293 px wide in a 359 px column and scroll their 601 px content inside
    themselves, so the page does not widen;
  - the text content of both blocks is identical.
- **Action names** stay canonical codes. Translating them is the deferred design note C5 in
  `android-ar-acceptance-2026-11-01.md`, and it is unchanged here.
- **Device check after deployment.** Open Settings → Audit log in Arabic and expand "Changes" on a
  `business_dna.update` row. Expect the JSON to read left to right, with each Arabic value
  readable on its own.

## C. Arabic Listen

**Samsung Internet: owner-reported pass.** Ehab confirmed that an Arabic reply is read aloud.

**Chrome: unresolved in the observed session.**

- **Observation.** The app reported 92 available voices, none matching Arabic, and read nothing.
  The diagnostic message appeared correctly.
- Relative to A1 in `android-ar-acceptance-2026-11-01.md`: in this session the page received a
  non-empty voice list (92 voices) in which nothing matched Arabic, rather than an empty list.
- **Code trace.**
  - `src/hooks/use-speech-playback.ts` waits up to 2.5 s for voice-list updates (`voiceschanged`),
    then decides.
  - `src/lib/voice/voices.ts` matches the primary language subtag and accepts `ar`, `ar-XA`,
    `ar_SA`, `AR-eg`, and the engine codes `ara`/`arb` (`ara-SAU`, Samsung).
  - `tests/unit/speech-playback-voice-wait.test.tsx` covers these tags, late and partial lists,
    and the "listed but none Arabic" diagnostic. A 92-voice list containing any of these tags
    would have been used.
- **Conclusion.** No application defect was identified in the investigated path. Arabic playback
  remains unavailable in the observed Chrome session; the underlying browser/device cause is not
  conclusively established.
  - Samsung Internet's result does not show that Chrome can speak Arabic, and Chrome's list does
    not show that the device lacks Arabic voices.
  - The exact tags in Chrome's 92-voice list were not captured, so a tag form outside the
    tested set cannot be excluded.
  - No code change was made. Paid or server TTS was not added; that would be a product
    decision.
- **Optional, later.** A future Chrome session could record the listed voices' `lang` values. No
  device setting needs to change for that, and no retest is required for this record.

## D. Billing display

**Owner-observed pass (display only).** On staging:

- Monthly: Starter €29, Pro €79.
- Annual: Starter €290 (shown as €24.17/month), Pro €790 (shown as €65.83/month).
- The annual copy says one payment per year and 12 months for the price of 10.

These match `PLAN_MONTHLY_PRICE_EUR` and `ANNUAL_BILLED_MONTHS = 10` in
`src/lib/billing/plan-catalog.ts`. No Checkout, purchase or plan change was made.

**Stripe Price objects: BLOCKED.** No read-only Stripe access was available, and no secret was
read. The charge is whatever the Prices behind `STRIPE_PRICE_STARTER_ANNUAL` and
`STRIPE_PRICE_PRO_ANNUAL` say.

- **How the code uses them** (`src/server/integrations/stripe.ts`):
  - Checkout uses one line item, `{ price, quantity: seats }`, with `automatic_tax` enabled.
  - The Stripe webhook maps the price id back to the plan and takes `seats` from the item
    quantity.
  - An unknown price id is stored as FREE and logs `stripe_unknown_price`.

**Stripe mode used by staging: unknown.** It is set by the staging secret key, which was not
read. A key starting `sk_test_`/`rk_test_` means test mode. Open the dashboard in the mode where
the staging Price ids exist.

**Fields to confirm in the Stripe dashboard, for each of the four Prices:**

| Field          | Starter annual         | Pro annual             | Starter monthly | Pro monthly |
| -------------- | ---------------------- | ---------------------- | --------------- | ----------- |
| Price id       | = staging env var      | = staging env var      | = env var       | = env var   |
| Active         | yes                    | yes                    | yes             | yes         |
| Currency       | EUR                    | EUR                    | EUR             | EUR         |
| Amount         | 290.00                 | 790.00                 | 29.00           | 79.00       |
| Billing period | Yearly (interval 1)    | Yearly (interval 1)    | Monthly         | Monthly     |
| Pricing model  | Standard, per unit     | Standard, per unit     | per unit        | per unit    |
| Usage type     | Licensed (not metered) | Licensed (not metered) | Licensed        | Licensed    |
| Tax behavior   | Record it              | Record it              | Record it       | Record it   |
| Product        | Starter                | Pro                    | Starter         | Pro         |

- **Per unit and licensed** make the quantity (seats) multiply the amount: 3 seats on Starter
  annual is 3 × €290 per year.
- **Display versus provider.** The page computes €290/€790 and €24.17/€65.83 from constants
  (owner-observed correct). Only the Price objects decide what is charged.
- **Tax behavior** decides whether VAT is added on top of the €290/€790 the page shows (exclusive)
  or included in them (inclusive). This is a product decision if it does not match the intended
  display.

The env var values are in Vercel's staging environment. Compare them without copying them anywhere
public.

## E. Inbox

**Blocked by configuration.** The Arabic UI said the email provider is configured but the pilot
organization has no receiving address, so inbound mail cannot reach its inbox.

- The warning passed Ehab's visual check.
- End-to-end inbound email and Resend routing were not tested.

**Checked against current main** (`a02b4d6`). The schema, `src/server/services/inbox-mailbox.ts`
and both inbound webhook routes are unchanged since #387's handoff.

- The read-only query in `staging-release-handoff-2026-11-02.md` §2 still matches the schema:
  - `inbox_mailboxes.address`, `created_at`, `organization_id` and `channel`;
  - enum value `EMAIL`;
  - `organizations.slug` and `deleted_at`.
- There is still no supported UI or API that creates the receiving address. `getOrCreateMailbox`
  is called only from tests. The supported procedures are the ones in §2 of that handoff.

**Minimum owner steps, each separately authorized:**

1. Run the §2 read-only query on staging. Expected: no row, matching the UI.
2. Choose the staging receiving domain (`INBOX_EMAIL_DOMAIN`).
3. Create the address: either the single authorized insert in §2, or approve a small product change
   ("Set up receiving address" for `org:update` users, audited, calling `getOrCreateMailbox`).
4. In Resend, enable inbound for that domain:
   - point the webhook to `/api/v1/webhooks/inbox-email/resend`;
   - set `RESEND_INBOUND_WEBHOOK_SECRET` on staging.
5. Verify:
   - the Inbox shows the address, and the warning is gone;
   - one email from your own mailbox creates one thread.

   In Resend's log, 401 means an unknown recipient and 503 means the secret is missing.

**Reading the results:**

- **Ready to test inbound:** the query returns one row whose address is on the Resend inbound
  domain, `organization_deleted_at` is empty, and the Inbox page no longer shows the warning.
- **Still blocked:**
  - no row (step 3 not done);
  - an address on another domain (it must match `INBOX_EMAIL_DOMAIN` and Resend's inbound
    domain);
  - Resend inbound not pointing at the route, or the secret not set (401/503 in Resend's log).

## F. Workflows

**Contact trigger: owner-observed pass.** The workflow was "Pilot contact workflow test" (active):

- trigger: contact created;
- one step: create CRM activity, contact `trigger.contactId`, text "Pilot workflow activity test".

What Ehab observed:

- **18:44:02, Test run: failed.** A test run has no contact. The error explained this. One
  notification for that run was visible.
- **19:05:50, after a new contact:** Ehab created the synthetic contact `اختبار أتمتة 2 نوفمبر`
  (no email or phone, consent unchecked).
  - A new run succeeded.
  - The contact's timeline showed one activity, "Pilot workflow activity test", at 19:05.
  - No new failure notification appeared.
- **What this proves.** The basic contact-created journey works. It proves nothing about
  deduplication under redelivery, retries or concurrency. Those are #388's subject, and #388 is
  not deployed.

**Test run UX: fixed in a draft PR, not deployed.**

- **Root cause.** "Test run" (`testWorkflowAction`) starts a run whose trigger data is only
  `{ test: true, triggeredBy }`. A CRM activity step it reaches therefore has no contact and fails,
  and the editor said so only after the failure.
- **Fix** (branch `fix/workflow-test-contact-hint`, PR #392).
  - When the saved workflow has a CRM activity step, a short EN/FI/AR note next to the button says
    that the test fails there if the run reaches that step, and when the step does run. (An
    earlier condition can end a test run before the step, hence "if".)
  - The note is linked to the button with `aria-describedby`.
  - Unchanged: the test run, its payload, and the contact-created workflow. No contact is chosen,
    and no trigger data is invented.
  - Richer test payloads, such as picking an existing contact, would be a larger design and are
    not built.
- **Tests.** `tests/unit/workflows-entitlement-ui.test.tsx` (EN/FI/AR) covers:
  - the note and its link;
  - the button still enabled, with the test run called with only the workflow id;
  - the note also for a CRM step whose contact field is not `trigger.*`;
  - no note without a CRM activity step;
  - the plan notice still taking precedence.

  The note tests fail on unchanged main.

## G. TalkBack

**NOT COMPLETED.** The test was started, but no reliable result was obtained, and turning TalkBack
off was very difficult.

- Do not repeat this without preparation.
- A future screen-reader session needs:
  - a prepared exit method (for example the volume-key shortcut, set up and tried first);
  - someone experienced with TalkBack present.

## Remaining limits

- **#388** (workflow failure atomicity and ownership) stays an unmerged draft at `f92f9d3`. Its
  documented limits are:
  - an enqueue failure after WAITING can leave a run without a resume;
  - a residual failure notice is possible in a duplicate-resume race.
- Not tested:
  - inbound email;
  - Checkout or payments;
  - TalkBack;
  - Chrome Arabic audio;
  - workflow redelivery and deduplication;
  - FI/EN browser journeys;
  - the two UI fixes on a device.
- These partial results are not a customer-launch readiness signal.
