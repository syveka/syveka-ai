# Chat → Business DNA: overnight reliability and acceptance follow-up — 2026-11-02

Continuation of `docs/chat-business-dna-completion-2026-11-01.md` on PR
[syveka/syveka-ai#385](https://github.com/syveka/syveka-ai/pull/385). Repository-only work:
no merge, no deployment, no staging or production change, no remote SQL, no secret, no
provider or billing change, no paid AI request (every test runs against mocked providers), no
external message. PR #386 (`fix/android-ar-acceptance`) was read, trial-merged in a disposable
worktree and never modified. Every claim names the file, command or test it comes from.

## 1. Ground truth

| Item                             | Value                                                                                                      |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Base (`origin/main`) overnight   | `19581f274e87e876343d0eb3be8cf51547485569` (verified at the time; superseded, see §12)                     |
| Head at the start                | `9fcc93e5a9c555bfc355f2c7f2f6ddbbb56bcad6` (as reported; verified against origin)                          |
| CI on `9fcc93e`                  | run 41353262501: all 19 checks green (read, not re-run)                                                    |
| Final code head                  | `60d8ecb` (this document is committed after it; see the PR for the exact head)                             |
| Overnight commits                | `6c34f55`, `12b724e`, `60d8ecb` (+ this document)                                                          |
| Overnight diff                   | 15 files, +1251 / −118 before this document                                                                |
| Whole PR vs `main`               | 16 files, +2147 / −110 before this document                                                                |
| Schema / migrations / env / deps | none changed                                                                                               |
| PR #386 head read                | `1689886f943a18146393cd6655d4b1a8b6c80b1e` (base `19581f2`, 56 files); merged to `main` as `af75e17` (§12) |

## 2. The documentation contradiction, resolved

The PR body and the 2026-11-01 report said both "cancel the newer one and the earlier one is
offered again" and "a replaced card stays replaced until reload". Tracing the state showed
the latter: the thread recorded "superseded" in its decided map as if it were a decision, so
the earlier card could never come back, and the card had no path from "superseded" to
"pending".

**Verified behaviour now (integrated thread + card test
`tests/unit/chat-thread-supersession.test.tsx`, helper test `superseded-actions.test.ts`,
card tests in `action-confirmation.test.tsx`):**

- Pending A changes a field; newer pending B changes the same field → A reads "Replaced by a
  newer request." and has no buttons; the view is released once for A.
- Cancel B → A is offered again at once (confirmable, nothing sent for it), provided A was
  never decided and hasn't expired; A can then be confirmed on its own.
- Apply B → A stays replaced. A newer proposal whose outcome is unknown or failed replaces
  nothing for sure, so A is offered again (the server still refuses A as stale if B's write
  landed).
- Unrelated fields stay independent. A chain A < B < C: withdrawing C re-offers B only.
- Partial overlap (A: hours + languages; B: hours only): A reads "Replaced by a newer
  request. The newer request doesn't include Supported languages. Ask Syveka again to change
  that too." (EN/FI/AR, plural-aware; field labels are the settings page's). Cancel B → the
  whole of A is offered again. Confirming A after B was applied is refused as stale for the
  whole patch, so old hours can never overwrite the correction, and the languages are never
  dropped silently: the user is told to ask again for them.
- Reload: restored outcomes count exactly like in-session decisions (B restored canceled → A
  confirmable; B restored done → A replaced; A restored done/stale/failed/unknown/unavailable →
  never changed by B). An A that expired while replaced reads as expired, never confirmable.
- A card awaiting a repeat (rate limit, service unavailable, no answer) is open on the server
  too, so a correction replaces it as well: its "Try again" is withheld and returns when the
  correction is withdrawn (found by all three review passes; fixed in `60d8ecb`).

`docs/business-dna-mvp.md` ("Corrections, retries and reopened conversations"), the
2026-11-01 report and the PR body now describe this one behaviour.

## 3. Defects fixed overnight (each with a regression test)

| #   | Severity | Defect                                                                                                                                                                         | Fix                                                                                                                                                    | Commit    |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| 1   | P2       | Canceling a correction never re-offered the earlier proposal (contradicted the docs).                                                                                          | "Superseded" is derived from the thread, never recorded as a decision; the card returns to pending (or expired) when the newer proposal is withdrawn.  | `6c34f55` |
| 2   | P2       | A partial correction silently dropped the earlier proposal's other fields.                                                                                                     | The replaced card names the fields the newer request doesn't include (EN/FI/AR).                                                                       | `6c34f55` |
| 3   | P2       | A card awaiting "Try again" ignored a correction: its retry could send the replaced value, and the correction was then refused as stale.                                       | A replaced card withholds its retry and reports the replacement; the retry returns when the correction is withdrawn.                                   | `60d8ecb` |
| 4   | P2       | A lost Confirm retried after the proposal's 10-minute store expiry read "expired, ask Syveka again" although the change was made (an invitation to do it twice).               | The endpoint answers a not-found repeat from the deciding user's own audit record (409 with the outcome); other users and organizations still get 404. | `60d8ecb` |
| 5   | P3       | A refusal issued before any decision (signed out, malformed request) settled the card as failed, releasing a held redirect for an action still pending on the server.          | Such refusals can be sent again and settle nothing.                                                                                                    | `60d8ecb` |
| 6   | P3       | An unknown recorded outcome value from the server left the card without a state.                                                                                               | Reads as unknown.                                                                                                                                      | `60d8ecb` |
| 7   | P2 a11y  | The result was announced twice: the live region changed text and received focus in the same commit.                                                                            | Focus moves to the card (its label is read once, the live region reads the result once).                                                               | `60d8ecb` |
| 8   | P2 a11y  | Confirm/Cancel/Try again became `disabled` in flight; browsers blur a disabled control, dropping keyboard focus to the page.                                                   | `aria-disabled`/`aria-busy` instead; the one-request guard ignores a second activation; labels stay fixed, the status line carries the progress.       | `60d8ecb` |
| 9   | P2 copy  | Finnish "ei sisällä kohtaa X ja Y … myös se" was ungrammatical for several fields; Arabic named the product in Latin unlike neighbouring strings; EN apostrophes inconsistent. | ICU plural in EN and FI; «سيفيكا» in AR; straight apostrophes.                                                                                         | `60d8ecb` |

## 4. Stress scenarios (section 3 of the brief) and their coverage

All at the component, thread or endpoint level with mocked providers; "sound by trace" means a
reviewer traced it and no test adds a new path.

| Scenario                                                           | Result                                                                                                                                                                             |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Confirm done server-side, answer lost → retry                      | **tested**: 409 with recorded outcome, nothing repeated (`ai-business-dna-tool`, `action-confirmation`)                                                                            |
| Cancel done server-side, answer lost → retry (and a later Confirm) | **tested**: both refused with outcome canceled, nothing applied                                                                                                                    |
| Retry after the store expiry                                       | **tested**: own outcome returned; other user / other org / never-decided → 404                                                                                                     |
| "Already decided" without an outcome                               | **tested**: reads unknown, not retryable, never a success                                                                                                                          |
| Rate limit, service unavailable, no JSON, network loss             | **tested**: retryable, not settled, redirect held                                                                                                                                  |
| Permission, plan limit, mismatch, failure while running, not found | **tested**: settled with a recorded-consistent outcome; redirect released                                                                                                          |
| Double click; Confirm then Cancel; retry double click              | **tested**: one request                                                                                                                                                            |
| Two concurrent confirmations (two tabs)                            | **tested** at the decision store: exactly one applies; the other is refused (the Lua script runs against a real Redis in `ai-tool-actions-redis.test.ts`)                          |
| Switching conversation while a decision is in flight               | **tested**: unmount never redirects; per-card state                                                                                                                                |
| Reload during / after a decision                                   | **tested** (`chat-page-restored-actions`): record wins; decided-without-record → unknown; live pending → confirmable                                                               |
| New chat's deferred navigation                                     | **tested**: held while undecided or in live voice; released once                                                                                                                   |
| Old async answers updating the wrong card                          | **tested**: answers out of order update their own cards only                                                                                                                       |
| Expired / stale proposals through supersession changes             | **tested**: never confirmable again                                                                                                                                                |
| Altered confirmation (digest, conversation, malformed, bad id)     | **tested**: applies nothing, proposal still decidable by its owner                                                                                                                 |
| Re-offered card clicked inside a new chat's redirect window        | **untested**, narrow race noted by review: the remount may show "unknown" until the record is written; next reload shows the outcome. Not fixed (needs a click during navigation). |

One harness limit, recorded honestly: two concurrent requests through the route itself could
not be exercised in Vitest (concurrent dynamic imports of a mocked module resolved one request
to the real session module). The race is therefore tested at the store level and the endpoint
replay sequentially.

## 5. Acceptance journey (section 4 of the brief)

Executable through the existing architecture in `tests/unit/ai-business-dna-tool.test.ts`
("acceptance journey: a user changes Business DNA from chat"), with the real tool registry,
confirmation store rules, patch service, endpoint and prompt-block builder; mocked database,
session and store:

- supported facts → a proposal with only supported fields; preview shows current and proposed
  values for every change; nothing changes before confirmation; confirmation persists exactly
  the approved update and preserves unrelated data; the agent's own Business DNA context reads
  the new values and no longer the cleared one; the audit log holds one profile change and one
  decision, both naming the action; the outcome is restored for a reopened conversation;
- clearing a field (shown as removed), canceling a clear (nothing changes, recorded once, no
  later decision can apply it);
- stale state caused by a settings edit (existing tests in the same file), unauthorized role
  before and after the proposal, cross-tenant read/confirm/cancel, altered confirmations;
- prompt injection embedded in a business fact: stored as data, shown as text, reaches the
  prompt only inside the untrusted profile block with the wrapper-closing sequence neutralized
  (the AI's own instruction fields can't be set from chat, existing tests);
- Finnish, Arabic and mixed-direction values round-tripped unchanged; EN/FI/AR presentation
  and per-block text direction at the card level (`action-confirmation.test.tsx`).

**Not executed: browser and device checks.** The e2e suite needs a running app with Supabase
auth and Redis (`E2E_BASE_URL`); none is available in this session, and setting one up would
need credentials. The browser-only behaviours (real focus blur on `disabled`, screen-reader
announcements, touch, RTL rendering) are proven by trace and attributes only. See §9.

## 6. Review findings and resolutions

Three independent passes in separate contexts on the branch diff after `12b724e`.

| Pass                 | Finding                                                                                                                                                                                                                                                                   | Resolution                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Security/concurrency | F1 P2: a replaced proposal stayed confirmable through "Try again".                                                                                                                                                                                                        | Fixed (§3 #3).                                     |
| Security/concurrency | No other defect. Tenant/user/conversation scoping of the replay outcome, single-use, clear of settings-only fields, expiry, rate limit fail-closed, cross-origin and role re-checks verified sound.                                                                       | —                                                  |
| Security/concurrency | Note: a retry after the TTL read "expired" for an applied action.                                                                                                                                                                                                         | Fixed (§3 #4), with the lookup scoped to the user. |
| Behaviour/recovery   | D1 P2 (same as the note above), D2 P2 (same as F1), D3 P3 (pre-decision refusals settled), D4 P3 (unguarded outcome map).                                                                                                                                                 | All fixed (§3 #4, #3, #5, #6).                     |
| Behaviour/recovery   | Narrow race: re-offered card clicked during a new chat's redirect.                                                                                                                                                                                                        | Documented, not fixed (§4).                        |
| A11y/mobile/locale   | Double announcement; focus lost on `disabled`; Finnish plural; Arabic product name; label change while focused; apostrophes.                                                                                                                                              | All fixed (§3 #7–#9).                              |
| A11y/mobile/locale   | Sound: one live region per card in every state; focus never on mount, supersession or revert; 40 px targets; long values wrap inside the bubble; `dir="auto"` per block and list item; `<bdi dir="ltr">` for hour ranges; no implementation terminology reaches the user. | —                                                  |

## 7. PR #386 overlap and integration assessment

Files both PRs change: `messages/en.json`, `messages/fi.json`, `messages/ar.json`,
`src/components/chat/chat-thread.tsx`. #386 touches the thread only in `ListenControl` (a
count for the voice-playback error) and adds keys elsewhere in the locale files; #385 changes
the thread's action handling and adds keys under `chat.actions`.

Combined validation in a disposable worktree (never pushed), `#385 60d8ecb` merged with
`#386 1689886` using `git merge --no-commit`: clean automatic merge (no conflict),
`npm run i18n:check` PASS (1261 keys in parity), `tsc --noEmit` PASS, `eslint src tests` PASS,
`vitest run` PASS (344 files passed, 9 skipped; 4882 tests passed, 55 skipped). These are
combined results, not #385-only ones. The earlier combined run at `#385 12b724e` plus
`#386 1689886` also merged cleanly and passed typecheck, lint, i18n parity (1261 keys) and the
full suite (344 files, 4874 tests). A first attempt in a fresh worktree failed only because the
generated Prisma client was absent there; generating it fixed every failure, so none was a real
conflict.

Resolution: #386 merged first (`af75e17`), and `main` was then merged into this branch with a
normal merge commit (§12). #385 stays independently reviewable; #386 was never modified.

## 8. Verification on the final code tree (`60d8ecb`)

| Command                                            | Result                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm run format:check`                             | **PASS**                                                                                             |
| `npm run lint`                                     | **PASS**                                                                                             |
| `npm run typecheck`                                | **PASS**                                                                                             |
| `npm test`                                         | **PASS** — 341 files passed, 9 skipped; 4834 tests passed, 55 skipped (opt-in Postgres/Redis suites) |
| `npm run i18n:check`                               | **PASS** (1238 keys in parity in fi and ar)                                                          |
| `npm run migrations:check`                         | **PASS**                                                                                             |
| `npx prisma validate` (placeholder `DATABASE_URL`) | **PASS**                                                                                             |
| `SKIP_ENV_VALIDATION=1 npm run build`              | **PASS**                                                                                             |
| `npm audit --omit=dev --audit-level=high`          | **PASS** at high (12 low/moderate, pre-existing, none introduced here)                               |
| `npm run test:e2e`                                 | **NOT APPLICABLE** (no app runtime with Supabase/Redis; §5)                                          |

Affected suites after each fix (all PASS at `60d8ecb`): `action-confirmation`,
`chat-thread-supersession` (new), `superseded-actions`, `ai-business-dna-tool`,
`ai-tool-actions`, `chat-view-action-navigation`, `chat-page-restored-actions`: 7 files, 210
tests.

CI observed on the final head: the final head is pushed after this document; its CI result is reported in the morning message, not here, so that no commit exists only to record its own SHA.

## 9. Remaining limitations

- No browser, device or screen-reader run (§5). The `aria-disabled` change and the focus move
  to the card are the standard remedies for the reported behaviours, but only a real browser
  proves them.
- A re-offered card is not re-added to the new chat's navigation hold (the redirect has already
  fired by then); the remount restores it from the server. The narrow race in §4 remains.
- A pending card past its expiry while the page stays open still shows Confirm until the
  server answers not found ("expired"); there is no live countdown.
- Whether the assistant re-proposes all still-wanted facts after a partial correction depends
  on the model; the card's note covers the gap by telling the user what to ask for again.

## 10. Manual acceptance checklist (staging, after a separate merge and deploy decision)

1. Ask for an opening-hours change; confirm it; the settings page shows it, the audit log has
   one entry.
2. Ask for hours and languages in one message; then correct only the hours. The first card
   says it is replaced and that languages aren't included; cancel the correction; the first
   card is confirmable again; confirm it; both values land.
3. Correct the hours again and apply the correction; the first card stays replaced.
4. Click Confirm, cut the network, restore it, click "Try again": the true outcome, once.
   Repeat with Cancel.
5. Wait 11 minutes after a Confirm whose answer was lost, then "Try again": the card shows the
   recorded outcome, never "expired, ask again".
6. Click Confirm, then immediately send a correction; the first card withholds "Try again"
   while the correction is open.
7. Keyboard only: Enter on Confirm keeps focus inside the card; after the result, focus is on
   the card and Tab reaches "Try again" or the review link.
8. Screen reader: each result is read once; a replacement is announced without a click.
9. Phone: all buttons and the review link are easy to tap; long Arabic and English values wrap.
10. Arabic interface with an English value, Finnish interface with an Arabic value: each value
    is aligned to its own side.

## 11. Next action

Human review of PR #385. Recommendation: **ready for review** (draft can be marked ready) once
the CI on the final head is read as green; merge and deployment remain separate decisions.

## 12. Integration of `main` after #386 merged (2026-11-02)

| Item                        | Value                                                                                                                                                                                                                                          |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `origin/main` integrated    | `af75e17414d6becfd03d2563403d806a619b8baa` (merge of #386; no other commit since `19581f2`)                                                                                                                                                    |
| Merge commit on this branch | `1485949` (`git merge --no-ff origin/main`; no rebase, no force-push)                                                                                                                                                                          |
| Conflicts                   | none; Git merged the four shared files automatically                                                                                                                                                                                           |
| Shared files                | `messages/{en,fi,ar}.json` (different sections), `src/components/chat/chat-thread.tsx` (#386 edits `ListenControl` only; #385 edits the action handling)                                                                                       |
| Reversion check             | `git diff origin/main HEAD` over the four shared files equals exactly this branch's own additions (+64 / −13); both sides present (`notCarriedOver` and `no_voices_listed` in every locale; `supersededActions` and `countText` in the thread) |

Focused suites on the merged tree (`1485949`): Business DNA and chat (`action-confirmation`,
`chat-thread-supersession`, `superseded-actions`, `ai-business-dna-tool`, `ai-tool-actions`,
`chat-view-action-navigation`, `chat-page-restored-actions`, `chat-tool-status`,
`chat-view-live-voice`) and the #386 suites touching the shared files
(`speech-playback-voice-wait`, `use-speech-playback`, `notification-display`,
`ar-acceptance-forms`, `settings-localization`, `plan-cards-interval`): **PASS**, 15 files,
349 tests; `npm run i18n:check` **PASS** (1261 keys in parity).

Repository checks on the merged tree (`1485949`):

| Command                                            | Result                                                                                               |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `npm run format:check`                             | **PASS**                                                                                             |
| `npm run lint`                                     | **PASS**                                                                                             |
| `npm run typecheck`                                | **PASS**                                                                                             |
| `npm test`                                         | **PASS** — 344 files passed, 9 skipped; 4882 tests passed, 55 skipped (opt-in Postgres/Redis suites) |
| `npm run i18n:check`                               | **PASS** (1261 keys in parity in fi and ar)                                                          |
| `npm run migrations:check`                         | **PASS**                                                                                             |
| `npx prisma validate` (placeholder `DATABASE_URL`) | **PASS**                                                                                             |
| `SKIP_ENV_VALIDATION=1 npm run build`              | **PASS**                                                                                             |
| `npm audit --omit=dev --audit-level=high`          | **PASS** at high (12 low/moderate, pre-existing)                                                     |
| `npm run test:e2e`                                 | **NOT APPLICABLE** (no app runtime with Supabase/Redis)                                              |

CI on the final head is reported in the hand-off message, not here.
