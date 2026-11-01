# Android Arabic acceptance ledger — 2026-11-01

Consolidated findings from the manual acceptance session on a Samsung Android phone (Chrome and
Samsung Internet; AR, FI, EN) in the test organization "Syveka Pilot Acceptance (TEST)"
(`syveka-pilot-acceptance-test`), Europe/Helsinki.

- Base: `origin/main` = deployed staging = `19581f274e87e876343d0eb3be8cf51547485569` (PR #384 merge).
- Branch: `fix/android-ar-acceptance`.
- Nothing here was merged, deployed, or run against staging or production data. No SQL was run,
  no email was sent, and no paid provider was called.

**Classes:**

- **Defect**: proven in code and reproduced in a test.
- **Wording**: copy or terminology improvement.
- **UX**: presentation improvement; nothing was broken.
- **Config gap**: something missing outside the code.
- **Plan-blocked**: unavailable because of the plan.
- **Not a defect**: the behavior is correct.
- **Untested**: functionality not exercised.

**Root cause** is marked _proven_ only where the code shows it.

**Evidence:** a mocked test proves behavior in code. It does not prove a live integration, and it
does not prove audible playback.

## Summary

| ID  | Observation                                                             | Class / severity                    | Status                           |
| --- | ----------------------------------------------------------------------- | ----------------------------------- | -------------------------------- |
| A1  | Chrome Listen says "no Arabic voice installed"; Samsung Internet speaks | Defect (copy), medium               | Fixed; device retest needed      |
| A2  | Voice matching for engine codes; silent "success"; speak() throwing     | Hardening, low                      | Fixed                            |
| B1  | Availability weekdays in English in Arabic UI                           | Defect, low                         | Fixed                            |
| B2  | Booking type card "min 60"                                              | Defect, low                         | Fixed                            |
| B3  | Workflow failure notification "step failed (DriverAdapterError)"        | Defect, medium                      | Fixed (historical rows too)      |
| B4  | Historical booking notifications in English in Arabic UI                | Defect (partly), low                | Partly fixed; time text deferred |
| B5  | Dashboard billing "FREE / ACTIVE"                                       | Defect, low                         | Fixed                            |
| B6  | Dashboard "New conversation"                                            | Defect, low                         | Fixed                            |
| B7  | Misplaced punctuation in mixed Arabic/Latin text                        | Defect, low                         | Fixed where Syveka renders it    |
| C1  | Task due date/time input without visible label                          | UX, low                             | Fixed                            |
| C2  | Long selected names clipped in narrow RTL selects                       | UX, low                             | Improved                         |
| C3  | Emails/URLs/slugs typed in RTL fields                                   | UX, low                             | Fixed                            |
| C4  | Arabic wording (booking window, trigger, open pipeline)                 | Wording                             | Applied                          |
| C5  | Audit log action labels                                                 | UX                                  | Deferred (design note)           |
| D1  | Equal stage bars for €250 and €1,000; marks on empty stages             | UX (not a calculation bug)          | Fixed                            |
| E1  | Price/unit order with slashes hard to read in Arabic                    | UX, low                             | Fixed                            |
| E2  | Annual cards: no amount charged; €24/€66 vs "2 months free"             | Defect (presentation), medium       | Fixed; Stripe amounts unverified |
| F1  | Email "verification required", inbox empty                              | Config gap (proven), high for email | UI fixed; owner action needed    |
| F2  | Phone assistant "requires setup" on FREE                                | Plan-blocked                        | Copy fixed; voice untested       |
| F3  | Chat microphone                                                         | Untested (gated)                    | Documented                       |
| G1  | Deterministic step failures retried 3× (follow-up)                      | Defect, low                         | Fixed                            |
| G2  | Workflow failure notification translation (follow-up)                   | Defect                              | Fixed (= B3)                     |
| G3  | Restricted editor offers steps the server blocks (follow-up)            | UX, low                             | Fixed                            |
| G4  | PostgreSQL settings suite not wired into CI (follow-up)                 | Process gap                         | Not done: protected CI change    |
| H   | Manual test facts (deleted event, unsaved schedule, calendar sync…)     | Not a defect / untested             | Recorded                         |

## A. Arabic Listen (browser speech)

### A1. Chrome reports "no Arabic voice installed"

**Observation.** On the same phone, the Samsung TTS Arabic voice is installed and its sample plays.
Syveka Listen works in Samsung Internet. In Chrome it shows "No Arabic voice is installed on this
device".

**Root cause.** The wording is _proven_ wrong. Why Chrome's list lacks Arabic is _not established_.

- Listen (`src/hooks/use-speech-playback.ts`) only speaks with a voice the browser lists through
  `speechSynthesis.getVoices()` for the reply's language. It waits up to 2.5 s for late lists.
- When the wait ended with no match, the hook reported `no_voice` in two different cases:
  - the browser listed **no voices at all**;
  - the browser listed voices, **but none in Arabic**.
- The copy for both cases said the **device** has no Arabic voice. It cannot know that. A browser
  can expose fewer voices than the device's speech engine. Samsung Internet speaking Arabic on the
  same device shows the device voice exists.
- Which of the two cases Chrome hit is not known. The new message reports the count, so the next
  device retest will tell (see the manual check).

**Fix.**

- **Separate codes.** `no_voices_listed` means the browser listed nothing. `no_voice` means voices
  were listed but none in the reply's language, and it now carries the number listed.
- **Copy (EN/FI/AR).** It now describes what **this browser** offers, suggests another browser or
  the device's speech settings, and never claims the device lacks the voice. The same correction
  applies to:
  - the live-conversation notices (`chat.live.notices.no_voice`, `voiceUnavailable`,
    `voiceUnknown`);
  - `playback_failed`.
- **Unchanged.** Language matching still holds: nothing is spoken with another language's voice,
  and an empty list is never left to the engine's default voice.

**Changed files.** `src/hooks/use-speech-playback.ts`, `src/components/chat/chat-thread.tsx`,
`src/lib/voice/voices.ts`, `messages/*.json`.

**Validation.** `tests/unit/speech-playback-voice-wait.test.tsx` and
`tests/unit/use-speech-playback.test.tsx` cover:

- an empty list leading to `no_voices_listed`, with no speech;
- a list without Arabic leading to `no_voice` with the count;
- a late voice arriving within the wait still speaking;
- the rendered EN/FI/AR copy, with no message claiming the device has no voice.

**Manual check (physical device, required).**

1. In Chrome on the Samsung phone, open the Arabic chat and tap Listen on an Arabic reply.
2. Record the exact message, including the number of voices.
3. If it says Chrome offered N voices but none Arabic, Chrome's engine list lacks Arabic. Check
   Chrome's speech engine (Android Settings → Text-to-speech output → preferred engine) and whether
   Chrome lists Samsung TTS voices.
4. If it says no voices were listed, Chrome exposes no voices to the page.
5. Mocked tests do not prove audible playback in either browser.

### A2. Hardening in the same path

- **Three-letter codes.** Some Android engines report voice languages as three-letter codes
  (`ara-SAU`). `primaryLanguage` now maps exactly `ara`/`arb`→ar, `fin`→fi and `eng`→en, and speaks
  with a two-letter tag. `fil` still never matches `fi`, and `arz` never matches `ar`.
  - _Not proven_ to be Chrome's issue. It is a safe widening that never crosses languages.
- **Silent "success".** A chunk the engine never starts (no `start` event before the watchdog) now
  reports `playback_failed` instead of ending silently as a success.
- **`speak()` throwing** is reported as `playback_failed`.
- **Tests.** Three-letter matching, never-started chunk, started chunk advancing, and `speak()`
  throwing. Cancellation, unmount, page hide and superseding a play were already covered and still
  pass.
- **No server text-to-speech** was added.

## B. Arabic localization and mixed-direction text

### B1. Weekdays stay Monday–Sunday in Arabic

- **Root cause (_proven_).** `availability-editor.tsx` used `Intl.DateTimeFormat(undefined, …)`, the
  browser's default locale, not the interface language.
- **Fix.** It now uses the next-intl locale. The order stays Monday first.
- **Test.** `tests/unit/ar-acceptance-forms.test.tsx`: Arabic, Finnish and English day names.

### B2. Booking type card "min 60"

- **Root cause (_proven_).** The card hardcoded `{minutes} min`.
- **Fix.** The card reuses `booking.durationLabel`, already used by the public booking page:
  "60 دقيقة", "60 min".
- **Test.** `tests/unit/booking-calendar-mobile-ui.test.tsx`.

### B3. Workflow failure notification shows "step failed (DriverAdapterError)"

**Root cause (_proven_).**

- The job stores its failure text as the notification body (`run-workflow/route.ts`).
- The notifications page printed stored title and body verbatim.
- Run history translated the same text through `workflowRunFailure()` (PR #384); the notification
  did not.

**Fix.**

- New `src/lib/notifications/display.ts`. On the notifications page a `workflow.failed` row shows
  "Workflow failed: ‹name›" and the same translated reason code as Run history.
- This includes **historical rows**: a pre-#384 row maps to "internal".
- Stored text and the run record keep the technical detail for diagnostics; the page never shows
  it. The workflow name is isolated with `<bdi>`.

**Test.** `tests/unit/notification-display.test.tsx`: the stored staging row renders in AR/FI/EN
without "DriverAdapterError".

### B4. Historical booking notifications in English

**Root cause (_proven_).**

- Booking notifications are written as finished sentences in the **owner's profile language**
  (Settings → Profile, `User.locale`) when the booking happens.
- The topbar language switch changes only the URL locale, so an owner whose profile is English gets
  English rows while viewing the app in Arabic.
- Rows store no booking id (`href: "/calendar"`) and no parameters.

**Fix (display only, rows unchanged).**

- The action word ("New booking", "Booking canceled", …) is recognised in any of the three stored
  languages and shown in the viewer's language.
- The booking type and guest name are shown as isolated user data.

**Deferred.** The body (weekday, month and time) was formatted in the writer's language and cannot
be re-formatted safely without the booking's time. Parsing English dates is fragile. The body is
shown in its own direction (`dir="auto"`).

**Remaining decision.** One of:

- store structured parameters on new notification rows, which is a schema change needing approval;
- the owner sets Settings → Profile → language to Arabic, so new rows are written in Arabic.

**Test.** `notification-display.test.tsx`: an English-stored row renders with the Arabic action.

### B5. Dashboard billing "FREE / ACTIVE"

- **Root cause (_proven_).** Raw enum values were inserted into `"{plan} / {status}"`.
- **Fix.**
  - The plan uses the product name (`PLAN_NAMES`: Free, Starter, Pro), which stays untranslated by
    policy.
  - The status is translated: active, trial, payment overdue, canceled, payment pending, paused.
- **Test.** `tests/unit/display-time-zone-pages.test.tsx` shows "Free · Active" and "Free · نشط",
  with no raw enum.

### B6. Dashboard "New conversation"

- **Root cause (_proven_).**
  - "New conversation" is the **system default**: `Conversation.title @default("New conversation")`.
  - It stays until the best-effort AI titling replaces it.
  - No user rename path exists.
- **Fix.** `src/lib/chat/conversation-title.ts` shows exactly that default in the interface
  language, on the dashboard and in the conversation list. Any other title is shown as stored.
- **Test.** Dashboard: Arabic "محادثة جديدة"; a user title stays.

### B7. Mixed-direction punctuation

| Text                                       | Source                                                                         | Fix                                                                                   |
| ------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------- |
| "Pilot Guest TEST." in notification titles | Guest name (user data) inside the stored booking title                         | Guest and booking type isolated with `<bdi>` (B4)                                     |
| "Test bookings only — no real customers."  | Not in the code: user-written booking-type description or confirmation message | `dir="auto"` on the public description and confirmation; the text itself is unchanged |
| Guest email example in Arabic helper text  | `calendar.fields.guestEmailsHint`                                              | Example wrapped in `<bdi dir="ltr">` via a rich-text tag in EN/FI/AR                  |
| Other stored notification text             | Workflow `notify.member` titles and other rows                                 | `dir="auto"` per paragraph                                                            |

- Customer data was neither translated nor rewritten.
- Tests: `notification-display.test.tsx` and `booking-calendar-mobile-ui.test.tsx` (hint isolation).

**Not Syveka defects.** Native Samsung date/time picker buttons (Prev., Next, Done, Set, Cancel,
Clear) are browser controls and were not replaced.

## C. Mobile forms and wording

### C1. Task due date/time had no visible label

- **Fix.** `deal-tasks.tsx` gives the task a visible label ("Task") and the due input the label
  "Due date and time (optional)", in EN/FI/AR.
  - The field is optional on the server (`dueAt: optionalDateString`).
  - The fields stack on phones.
- **Test.** `ar-acceptance-forms.test.tsx`: the labels are associated and the due input is not
  required.

### C2. Long selected names in narrow RTL selects

- **Observation.** No data loss: the expanded options and detail pages show full names.
- **Fix.** The contact, company and owner selects in the deal dialog, and the company select in the
  contact dialog, take the full width on phones (one column below `sm`). They keep two columns on
  wider screens.
- **Untested.** Native select rendering is browser-owned. A device check is needed.

### C3. Text direction of emails, URLs and identifiers

- **Fix.** Email, phone, URL, domain, booking slug and guest-email inputs have `dir="ltr"`. They stay
  editable.
- **Where.**
  - contact, company and booking type dialogs;
  - booking widget;
  - auth forms;
  - invite;
  - voice phone inputs;
  - Business DNA website.
- Horizontal scrolling inside a long input is not data loss.

### C4. Arabic wording (applied)

| Key                               | Before              | After                           |
| --------------------------------- | ------------------- | ------------------------------- |
| `calendar.bookingTypes.maxWindow` | أقصى نافذة (يوم)    | أقصى مدة للحجز مسبقًا (بالأيام) |
| `workflows.fields.trigger`        | المُطلق             | الحدث المُشغِّل                 |
| `crm.openPipeline`                | خط المبيعات المفتوح | إجمالي قيمة الصفقات المفتوحة    |

"حدث بدء التشغيل" (suggested) was not used because it reads like a device start-up; "الحدث المُشغِّل" needs a native-speaker check. The two Run-history reasons that used "المُطلق" use the new term, and "سير عمل" became
"مسار عمل" to match the rest of the workflows UI.

### C5. Audit log action labels (deferred)

- The log shows canonical codes (`calendar.delete`) and filters by substring.
- There are 88 distinct literal action codes, plus computed ones. Translating them needs a
  maintained code→label map in three languages, kept in sync as actions are added.
- **Proposal.** A typed `AUDIT_ACTION_LABELS` map with a test that every literal code has EN/FI/AR
  labels. Show the label next to the unchanged code; keep filtering on the code.
- Not done in this change, to keep it reviewable.

## D. Dashboard chart semantics

### D1. Equal bars for €250 and €1,000; marks on empty stages

**Root cause (_proven_).** Not a calculation bug.

- Bar width is the stage's **deal count** relative to the largest count (`crm-dashboard.tsx`).
- Each of the €250 open, €1,000 won and €1,000 lost stages holds one deal, so their bars are equal.
- A 4% minimum width drew a colored mark for stages with zero deals.

**Fix.**

- A caption says the bars show the number of deals, not their value.
- Each stage shows "1 deal · €250.00", with plural forms in all three languages.
- Empty stages draw no bar.
- The bar is `aria-hidden`; the text carries the numbers.
- Totals and the weighted forecast are unchanged.

**Test.** `display-time-zone-pages.test.tsx` with the acceptance data: €250 open at 10%, €1,000
won, €1,000 lost.

- Three full bars and three empty ones.
- Open value €250.00 and forecast €25.00 unchanged.

## E. Billing presentation

### E1/E2. Price presentation and annual cadence

**Price authority (_proven_).**

- Displayed prices come from `src/lib/billing/plan-catalog.ts`: 29 and 79 EUR per seat per month,
  and `ANNUAL_BILLED_MONTHS = 10`.
- Checkout sends `STRIPE_PRICE_{PLAN}_{MONTHLY|ANNUAL}` × member count. The amounts live in Stripe
  and are not in the repository.

**Discrepancy (_proven_ in the display).**

- The annual cards showed `round(monthly × 10 / 12)`: €24 for Starter and €66 for Pro.
- 12 × €24 = €288 and 12 × €66 = €792, while 10 months is €290 and €790.
- So the shown figures were not "2 months free" exactly: 2.07 and 1.97 months.

**Fix (presentation only).**

- The card shows the amount charged and how often, without slashes:
  - monthly: "€29, per user per month, billed monthly";
  - annual: "€290, per user per year, billed once a year", plus "Equals €24.17 per user per month:
    12 months for the price of 10".
- The equivalent is shown to the cent (12 × €24.17 = €290.04); the amount charged is the annual figure. In Arabic the amount uses
  Latin digits after a right-to-left mark.
- **Unchanged:** prices, Stripe price IDs, entitlements, quotas, subscription state and the checkout
  arguments.

**Tests.**

- `plan-catalog.test.tsx`: 290 and 790, and the exact equivalent.
- `plan-cards-interval.test.tsx`: exact per-locale strings, no "€/" form, the same checkout
  arguments.
- `settings-localization.test.tsx`.

**Remaining manual check (owner, no purchase).** In the Stripe dashboard (test mode for staging),
confirm the `STRIPE_PRICE_STARTER_ANNUAL` and `STRIPE_PRICE_PRO_ANNUAL` prices are €290 and €790 per
seat per year. If they differ, the catalog or the Stripe prices must change together; nothing was
changed here.

## F. Setup readiness

### F1. Email: "verification required", empty inbox

**Readiness condition (_proven_).**

- `getEmailChannelStatus` reported `verification_required` whenever Resend credentials exist and no
  inbound email with a provider id has arrived.

**Gap (_proven_ in code).**

- Inbound email is routed only to an organization with an `inbox_mailboxes` row whose address
  matches a recipient. Both webhooks reject other recipients with 401.
- The address is `{org slug}@{INBOX_EMAIL_DOMAIN}`.
- **Nothing in the application creates that row.** `getOrCreateMailbox` is only called from tests.
- So unless a row was inserted by hand, no email can reach the test organization, and the status
  can never become "ready".
- Signature validation (svix for Resend; shared secret for the generic route), tenant routing by
  recipient only, idempotency on `external_id` (duplicate → 200, other org → 409) and rate
  limiting are implemented and covered by existing tests.

**Fix (read-only UI, no provider or DNS change).**

- **No mailbox row.** The new status is `no_address`. The dashboard shows "Setup required" and the
  Inbox explains that email can't arrive until a receiving address exists.
- **With a row.** The Inbox shows the address, isolated left-to-right, and the manual test: send
  one email from your own mailbox to it.
- The email item links to `/inbox`.

**Tests.** `setup-readiness.test.ts` and `inbox-email-channel-status.test.tsx` (EN/FI/AR).

**Remaining owner actions (not authorized here).**

1. Read-only check of whether the test organization has a mailbox:
   ```sql
   select m.address, m.created_at
   from inbox_mailboxes m
   join organizations o on o.id = m.organization_id
   where o.slug = 'syveka-pilot-acceptance-test' and m.channel = 'EMAIL';
   ```
2. If none exists, a mailbox has to be created. Options:
   - an authorized one-row insert;
   - a reviewed "set up receiving address" action, which is a product decision.
3. The receiving domain must have Resend inbound routing to `/api/v1/webhooks/inbox-email/resend`,
   with `RESEND_INBOUND_WEBHOOK_SECRET` set on staging. These are provider/DNS settings and were not
   inspected or changed.
4. Then send **one** email from your own mailbox to the shown address and confirm it appears in the
   Inbox and the status becomes "received".

Until then, inbound email is **untested**, neither working nor broken.

### F2. Phone assistant

**Observation.** FREE has `voiceAssistants: 0`. The New assistant page refuses correctly, so this is
**Plan-blocked / not tested**, not a provider failure.

**Fix.**

- The dashboard voice item shows "Requires Starter or above", linking to Billing, instead of
  "Setup required".
- The New assistant page shows the product plan name ("Free", not "FREE").
- It distinguishes a plan at its assistant limit ("Voice assistant limit reached") from a plan
  without Voice AI.
- Server enforcement (`upsertAssistant`) is unchanged.

**Test.** `voice-assistant-plan-block.test.tsx` and `setup-readiness.test.ts`.

**Not touched.** Issue #380 (activating an assistant buys a Vapi number automatically) is
unchanged. Activation still calls `buyPhoneNumber`.

**Remaining.** Before any voice test on a paid plan:

- resolve #380, separating configuration from an explicit purchase step;
- authorize the plan, the number and the call costs.

### F3. Chat microphone (dictation and live voice)

This is separate from the phone assistant and Listen. Both are off unless every gate holds.

**Dictation gates:**

- `AI_TRANSCRIPTION_ENABLED=1`;
- OpenAI configured;
- the `orgId:userId` pair in `AI_TRANSCRIPTION_PILOT_ALLOWLIST`;
- the transcription rate limit;
- the AI-message quota;
- the size and duration limits;
- 10 attempts per user per day.

**Live voice gates:**

- `AI_VOICE_CONVERSATION_ENABLED=1`;
- OpenAI configured;
- a valid `AI_VOICE_CONVERSATION_*` limit configuration;
- the pair in `AI_VOICE_CONVERSATION_PILOT_ALLOWLIST`;
- the per-turn rate limit;
- the AI-message quota.

**Remaining decisions.** Whether to enable either feature for the pilot, which members, and the
accepted OpenAI cost. Nothing was enabled.

## G. Previous fixes and follow-ups

**Preserved from PR #384 (re-run, passing):**

- missing or malformed contact-id guards before any UUID query;
- tenant-scoped contact lookup;
- activity idempotency across redelivery;
- the safe Run-history reasons;
- the `workflow_steps_internal_only` operator restriction and the atomic settings writes (#383).

| ID  | Follow-up                                   | Result                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Deterministic failures retried              | **Fixed.** A `WorkflowStepError` (invalid recipient, missing or unknown contact) now ends the job with 200 and notifies the creator once, like a refusal, instead of three identical QStash retries. Unexpected errors still return 500 and are retried. Tests: `run-workflow-contact-field.test.ts` (first attempt with `upstash-retried: 0`). |
| G2  | Translate the workflow failure notification | **Fixed** (B3).                                                                                                                                                                                                                                                                                                                                 |
| G3  | Restricted editor offers blocked steps      | **Fixed.** With the restriction set, the Email, AI and Wait step buttons are disabled with the reason. Save, activation, test run and the job still enforce it on the server. Test: `workflows-entitlement-ui.test.tsx`.                                                                                                                        |
| G4  | PostgreSQL settings suite in CI             | **Not done.** It needs a `ci.yml` change, which is a protected action. It requires explicit authorization.                                                                                                                                                                                                                                      |

A Test run without a contact still can't create an activity. A Test run is not equivalent to a real
"contact created" event; it fails with the translated reason.

## H. Manual test facts (not defects)

- **Calendar event "سعاد" deleted.** The user deleted it; not a regression.
- **Saturday / exception enabled, then refreshed without saving.** The original schedule returned:
  Mon–Fri 09:00–17:00, weekend unavailable, no exceptions. This is the expected unsaved-form
  behavior.
- **Google/Outlook calendar.** Both show "not configured in this environment"; sync is
  **untested**.
- **Contacts.**
  - Searching for "NoMatch987" showed the localized empty state.
  - Clearing the search restored the three contacts.
  - Contact, company and deal relationships were consistent.
- **Deal and task.** Pilot Test Deal is Lost, €1,000, 0%, €0 expected. The task Pilot follow-up
  test is completed.
- **What screenshots don't prove.** They prove none of:
  - authorization security;
  - audit completeness;
  - email delivery;
  - voice calls;
  - paid-feature readiness.

## Device retest checklist

Each check runs on the Samsung phone, in the browsers and languages noted, once the branch is on
staging.

1. **Listen.** Chrome, Arabic chat: tap Listen on an Arabic reply.
   - Record the message and the voice count.
   - Then repeat in Samsung Internet; it should still speak.
2. **Notifications (AR).**
   - The pilot workflow failure reads "فشل مسار العمل: Pilot contact workflow test" with the
     translated reason.
   - Booking rows start with the Arabic action and "Pilot Guest TEST." keeps its dot at the end.
3. **Availability (AR).** Weekdays are Arabic. Do not save.
4. **Booking types (AR).** Cards show "60 دقيقة".
5. **Dashboard (AR).**
   - Billing shows "Free · نشط".
   - The conversation shows "محادثة جديدة".
   - The stage caption is shown, empty stages have no bar, totals are €250 and €25.
6. **Billing (AR, then EN).** Switch to annual:
   - €290 / €790 per user per year, billed once a year;
   - equivalent €24.17 / €65.83.
   - Do not check out.
7. **Deal.**
   - The task form shows both labels.
   - In the edit dialog the selects are full width in portrait and two columns in landscape.
8. **Inbox.** Shows the receiving address, or the "no receiving address" message.
9. **Workflows.** In the restricted pilot workflow, the Email, AI and Wait buttons are disabled with
   the reason.
