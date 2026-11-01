# Chat → Business DNA completion sprint — 2026-11-01

Repository-only work in a cloud session on an isolated branch. No deployment, no staging or
production change, no remote SQL or migration, no secret read or written, no provider or
billing change, no paid AI request (every test runs against mocked providers), no merge.
Every claim below names the file, command or test it comes from. Outcomes are labeled
**implemented**, **tested**, **untested**, **blocked** or **deferred**. This report does not
claim launch readiness; see §10 for the release decision it asks for.

## 1. Ground truth

| Item                       | Value                                                                             |
| -------------------------- | --------------------------------------------------------------------------------- |
| Starting `main` SHA        | `19581f274e87e876343d0eb3be8cf51547485569` (merge of #384; branch base, verified) |
| Branch                     | `claude/chat-business-dna-completion`                                             |
| Final head                 | `TBD-HEAD` (this report is the last commit)                                       |
| Pull request               | TBD-PR (draft, into `main`)                                                       |
| Commits on the branch      | 5 (3 features/fixes, 1 docs, 1 report)                                            |
| Code changed (before docs) | 13 files, +788 / −101 (`git diff --stat origin/main..f1d6dbd`)                    |
| Schema / migrations        | none (`git diff origin/main..HEAD -- prisma supabase` is empty)                   |
| Environment contract       | unchanged (no new variable, no changed default)                                   |

## 2. Existing work reused (not duplicated)

The server side of the flow was already complete on `main` (PR #274 and its follow-ups) and
is reused unchanged except for one additive response field (§4). Verified by reading, and
by the existing tests that still pass:

| Piece                                  | Where                                                                                    | Guarantees already in place                                                                                                                                                                                     | Existing tests                                                                                     |
| -------------------------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Tool `proposeBusinessDnaUpdate`        | `src/server/ai/tools/index.ts`                                                           | Proposes only; nothing is written until the user confirms.                                                                                                                                                      | `ai-business-dna-tool.test.ts`, `ai-system-prompt.test.ts`                                         |
| Preview / apply                        | `src/server/services/business-dna-patch.ts`                                              | `CHAT_FIELDS` allowlist (settings-only fields excluded), tenant from the server session, role check, partial updates, clear ops, basis values, advisory lock + `FOR UPDATE`, stale check, audit `via: ai_chat`. | `business-dna-patch-validator.test.ts`, `business-dna-action.test.ts`, `business-dna-rbac.test.ts` |
| Confirmation store                     | `src/server/ai/tool-actions.ts`                                                          | Single-use decision (Redis Lua), bound to organization, user, conversation and change digest; 600 s expiry.                                                                                                     | `ai-tool-actions.test.ts`, `ai-tool-actions-redis.test.ts`, `ai-tool-actions-upstash.test.ts`      |
| Decision endpoint                      | `src/app/api/v1/ai/actions/[id]/route.ts`                                                | Auth context, rate limit, safe error codes (`not_found`, `already_decided`, `mismatch`, `permission_denied`, `plan_limit`, `rate_limited`, `service_unavailable`).                                              | `ai-business-dna-tool.test.ts`, `business-dna-route-rate-limit.test.ts`                            |
| Outcome restored after reload          | `src/server/ai/tool-action-history.ts`, `src/hooks/use-chat.ts`                          | Decided actions are restored from the audit log (`done`, `canceled`, `stale`, `failed`, `unknown`, `unavailable`); pending ones keep their expiry.                                                              | `chat-page-restored-actions.test.tsx`                                                              |
| Card, change list, navigation deferral | `src/components/chat/action-confirmation.tsx`, `business-dna-changes.tsx`, `use-chat.ts` | Full before/after display with the settings page's labels; a new chat's redirect waits for pending cards.                                                                                                       | `action-confirmation.test.tsx`, `chat-view-action-navigation.test.tsx`                             |

Gap map (what was missing for the customer): no way to recover from a lost or refused
confirmation request without losing the outcome; a replayed confirmation could not tell the
user what had actually happened; a corrected fact left the earlier card confirmable with the
old value; screen-reader and keyboard users lost focus after deciding; a plan-limit refusal
read as a failure; the "review on the settings page" link was below touch size; Arabic
values inside an English or Finnish interface were only shaped inline, not laid out as a
block.

## 3. Customer behaviour delivered

All of the following are **implemented and tested** with mocked providers unless marked.

- **Retry after a failed request, without doing it twice.** When Confirm or Cancel gets no
  usable answer (network loss, a 5xx without a known refusal, service unavailable, rate
  limit), the card says so in plain words and offers "Try again". The repeat sends the same
  decision; if the first one did go through, the server refuses it as already decided and
  returns the recorded outcome, which the card shows as the true result ("done", "canceled",
  "stale", …), never as a second write. (`action-confirmation.test.tsx` "a request that got no
  usable answer can be sent again"; `ai-business-dna-tool.test.ts` "a repeated confirmation is
  refused with the first decision's outcome and nothing is applied twice".)
- **Double-click and in-flight repeat.** A second click while a request is in flight is
  ignored; while a repeat is in flight the retry button stays in place, disabled and busy, so
  keyboard focus never falls off the card.
- **Corrections.** When the user corrects a fact ("actually we close at 16") and the assistant
  proposes again about the same field, the earlier card reads "Replaced by a newer request."
  and can no longer be confirmed. Proposals about different fields stay independent. Cancel
  the newer one and the earlier one is offered again; apply it and the earlier stays replaced.
  Decisions made in this view and outcomes restored after a reload count the same way.
  (`superseded-actions.test.ts`, card tests "a proposal replaced by a newer one".)
- **Returning after a reload or in a reopened conversation.** Decided cards show their recorded
  outcome; a replaced one is computed again from the thread. (Existing behaviour, now covered
  for the new states.)
- **Plain outcomes for every refusal.** Permission, plan limit ("Your plan doesn't allow this
  change. See Billing."), a change made elsewhere in the meantime ("stale", no retry),
  expiry, and an outcome that can't be confirmed ("unknown", never shown as a success).
- **Focus and announcements.** One persistent live region per card (`role="status"`,
  `aria-live="polite"`) announces every change of state, including the one the user didn't
  make (replaced). After the user's own decision, focus moves to the outcome; never on mount.
- **Touch and layout.** Every control, including the review link, is at least 40 px tall.
- **EN / FI / AR, RTL.** All new copy exists in the three locales (parity checked, 1237 keys
  each); values keep their own text direction per block and per list item, so an Arabic
  paragraph is laid out right-to-left inside a Finnish interface and the other way round. No
  implementation terminology reaches the user (no tool names, codes or "proposal ids").
- **Held redirect never waits for a card that can't change.** A refusal that consumed the
  decision (permission, plan limit, mismatch, a failure while the tool ran) settles the card
  like a result; only requests that can be sent again keep a new chat's redirect held.
  (`chat-view-action-navigation.test.tsx`.)

**Untested in this sprint** (no change was made to them; see §8): clearing a text field to
empty through chat (server path exists and is covered by `business-dna-patch-validator.test.ts`
at the validator level only), expiry of a proposal that was never decided (shown from
`expiresAt`, covered by the card's "already expired" test but not end to end), and the real
screen-reader experience (jsdom asserts roles and attributes, not announcements).

## 4. Components changed and decisions

| Change                                                                                                    | File                                                    | Decision and why                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `already_decided` refusal carries the recorded outcome (`error.outcome`), additive                        | `src/app/api/v1/ai/actions/[id]/route.ts`               | Lets a replayed confirmation show the true result. Looked up through `recordedActionOutcomes(ctx.orgId, …)`, so a repeat from another organization still gets a bare 404/409 without any outcome. Status code and error code unchanged (backward compatible).               |
| Card: `retrying`, `noAnswer`, `planLimit` states; retry; one live region; focus; `onSettled(id, outcome)` | `src/components/chat/action-confirmation.tsx`           | Retry is offered only for refusals the server has not consumed (`service_unavailable`, `rate_limited`) or for no usable answer (5xx without a known code, non-JSON, network). `already_decided` without an outcome reads as "unknown": never a success the user didn't see. |
| Superseded proposals                                                                                      | `src/lib/chat/superseded-actions.ts`, `chat-thread.tsx` | A view decision only; the server still binds every confirmation to its own proposal and refuses a superseded one as stale once the newer one is applied. The thread keeps the outcomes decided in this view so supersession follows the user's choices without a reload.    |
| Text direction per value block                                                                            | `src/components/chat/business-dna-changes.tsx`          | `dir="auto"` on the block that holds the value (and on each list item), so whole lines align correctly in mixed-language content.                                                                                                                                           |
| Copy (EN/FI/AR)                                                                                           | `messages/*.json`                                       | Added `retrying`, `result.noAnswer`, `result.planLimit`, `result.superseded` reworded; removed the unused "already handled" string. No automatic translation; FI and AR written by hand.                                                                                    |
| Docs                                                                                                      | `docs/business-dna-mvp.md`                              | New subsection "Corrections, retries and reopened conversations".                                                                                                                                                                                                           |

Not changed, on purpose: the AI tool definition and prompt (the flow already proposes rather
than writes), the Business DNA settings form, the audit model, rate limits (already applied by
the shared limiter on the decision endpoint), and anything in the Android / RTL / Listen /
notifications / billing-presentation / email / phone-plan area owned by the parallel task.

## 5. Verification

All providers are mocked in unit tests; no paid AI request was made. Commands run from the
branch head (see §1), with exit codes read from the logs.

| Command                                                                                           | Result                                                                                                     |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `npx vitest run` on the 5 focused suites (card, supersession, navigation, restored actions, tool) | **PASS** — 5 files, 120 tests                                                                              |
| `npm run format:check`                                                                            | **PASS**                                                                                                   |
| `npm run lint`                                                                                    | **PASS** (0 errors, 0 warnings)                                                                            |
| `npm run typecheck`                                                                               | **PASS**                                                                                                   |
| `npm test`                                                                                        | **PASS** — 340 files passed, 9 skipped; 4795 tests passed, 55 skipped (opt-in Postgres/Redis suites)       |
| `npm run i18n:check`                                                                              | **PASS** (1237 keys in parity in fi and ar)                                                                |
| `npm run migrations:check`                                                                        | **PASS** (ordered, 8 published checksums match)                                                            |
| `npx prisma validate` (placeholder `DATABASE_URL`)                                                | **PASS**                                                                                                   |
| `SKIP_ENV_VALIDATION=1 npm run build`                                                             | **PASS**                                                                                                   |
| `npm audit --omit=dev --audit-level=high`                                                         | **PASS** at high (12 low/moderate findings in production dependencies, pre-existing, none introduced here) |
| `npm run test:e2e`                                                                                | **NOT APPLICABLE** — needs a running app with Supabase and Redis; not available in this session.           |

CI actually observed on the pull request: TBD-CI.

Tests added or extended on this branch: `tests/unit/action-confirmation.test.tsx` (retry after
503 / 429 / network loss / non-JSON, replay returning the recorded outcome, replay without an
outcome reads as unknown, non-retryable refusals offer no retry, Cancel retried as Cancel,
in-flight repeat keeps the busy button, persistent live region, FI/AR copy, replaced card,
which outcomes settle the card), `tests/unit/superseded-actions.test.ts` (new),
`tests/unit/chat-view-action-navigation.test.tsx` (consumed refusals release the held
redirect; retryable ones hold it), `tests/unit/ai-business-dna-tool.test.ts` (repeated
confirmation refused with the first outcome, nothing applied twice; cross-organization repeat
gets no outcome).

## 6. Independent review passes

Three review passes ran in separate contexts that did not author the code (security;
behaviour and concurrency; UX, accessibility and locale). Findings and what was done:

| Pass               | Finding                                                                                                                                                                                                                                                | Resolution                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| Security           | No confirmed defect. Tenant binding of the outcome lookup, single-use decision, digest binding and safe error bodies verified against the tests.                                                                                                       | —                                                                                                         |
| Security           | Recommendation: `already_decided` without an outcome must not read as a success.                                                                                                                                                                       | Applied: reads as "unknown" (`f1d6dbd`).                                                                  |
| Security           | Recommendation: supersession should follow decisions made in this session, not only restored ones.                                                                                                                                                     | Applied: the thread passes the decided outcomes to `supersededActionIds` (`f1d6dbd`).                     |
| Behaviour          | D1: non-retryable consumed refusals never released the held redirect of a new chat.                                                                                                                                                                    | Fixed: `onSettled` fires for every outcome that can't be sent again; navigation test updated (`f1d6dbd`). |
| Behaviour          | D2: a canceled newer proposal kept the earlier one replaced until reload.                                                                                                                                                                              | Fixed by the decided map (same commit).                                                                   |
| Behaviour          | D3: `dir="auto"` only on inline spans.                                                                                                                                                                                                                 | Fixed: on the value block and each list item, with an RTL test (`f1d6dbd`).                               |
| Behaviour          | D4: a minor note, no behaviour change asked for.                                                                                                                                                                                                       | Noted; no code change.                                                                                    |
| UX / a11y / locale | Six defects, each matched by a fix on the branch: no label while a repeat is in flight, focus moved on mount, result inserted rather than announced, plan limit read as a failure, review link below touch size, values not laid out as blocks in RTL. | All fixed (`3d8abbc`, `2e75843`, `f1d6dbd`).                                                              |

## 7. Security and concurrency summary

- **Replay / idempotency:** the decision is single-use on the server; a repeat is refused with
  the first decision's recorded outcome, which the card shows. No path writes twice (tested).
- **Tenant isolation:** the outcome lookup on a repeat is scoped to the caller's organization
  from the server session; a cross-organization repeat gets nothing (tested).
- **Concurrency with the settings page:** unchanged server logic (advisory lock, `FOR UPDATE`,
  stale check); the card shows "stale" with no retry.
- **Error disclosure:** only the existing error codes are returned; no internal message or
  stack reaches the client.
- **Rate limits:** unchanged; the decision endpoint shares the AI chat limiter (`limitAiChat`,
  per organization and user, failing closed as 503), and a `429` is shown as a retryable
  "too many requests".

## 8. Limitations, blockers and deferred items

- **Untested end to end:** no browser or screen-reader run in this session (no app runtime
  with Supabase and Redis). Behaviour is proven at the component and route level only.
- **Deferred:** clearing a field to empty from chat is handled by the existing server path but
  has no new end-to-end test here; a proposal that expires while the user is away is shown as
  expired from its timestamp but there is no live countdown.
- **Deferred:** the view keeps a replaced card replaced for the rest of the session even if
  the newer one is later canceled; a reload offers it again. Acceptable for an MVP; a revert
  in place would need the card to go back from "replaced" to confirmable.
- **Blocked by authorization (by design):** no staging verification, no paid AI request, no
  merge, no deployment.

## 9. Manual acceptance checklist for Ehab (staging, after merge and deploy authorization)

Use an organization whose plan allows Business DNA changes, in each of EN, FI and AR.

1. Ask the assistant to change opening hours. A card shows the current and proposed hours
   with the same labels as the settings page. Nothing changes before Confirm.
2. Confirm. The card says it's done and links to the Business DNA page; the page shows the new
   value and the audit log records the change as made from chat.
3. In a new message, correct the fact ("actually we close at 16"). The earlier card reads
   "Replaced by a newer request." and has no buttons; the new card can be confirmed.
4. Cancel the new card. Nothing changes on the settings page.
5. Open the settings page in a second tab, change the same field there, then confirm an older
   chat card about it. The card reports the change was made elsewhere and offers no retry.
6. Turn the network off, click Confirm, turn it back on, click "Try again". The card shows
   the true outcome exactly once; the audit log has one entry.
7. Click Confirm twice quickly. One request is sent; one audit entry.
8. Reload the page during a conversation with decided and pending cards. Decided ones show
   their outcome; a pending one can still be confirmed until it expires.
9. Wait past the proposal's expiry (10 minutes) and confirm. The card says the request is no
   longer available.
10. As a member without the role to change Business DNA, confirm a card. The card says the
    role doesn't allow it; nothing changes.
11. On a phone, every button and the review link is comfortably tappable; the card fits the
    screen without horizontal scrolling.
12. With a screen reader, after Confirm the outcome is read out and focus lands on it; a
    replaced card is announced without any click.
13. In Arabic, a value typed in English inside the card reads left-to-right; in Finnish, an
    Arabic value reads right-to-left and its whole line is aligned to the right.

## 10. Next action for the release decision

The branch is a draft pull request. The next action is a human review of the pull request and
an explicit decision to (a) mark it ready for review and merge it, or (b) request changes.
Merging and any deployment are separate protected actions (CLAUDE.md §2 steps 13–14) that
this sprint does not request implicitly; nothing in this report should be read as launch
readiness.
