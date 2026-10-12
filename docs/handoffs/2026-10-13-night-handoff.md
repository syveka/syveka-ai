# Night handoff — 2026-10-13 (NEW Claude account)

A snapshot written at the end of the night of 2026-10-12 → 2026-10-13. Verify live state
(`git log`, `gh pr list`, `gh run list`) before acting on anything here. Nothing in this
file is a readiness score; older readiness documents (for example July's) are not current
evidence.

**Checkout used:** `.claude/worktrees/voice-contact-identity` (branch
`fix/voice-contact-phone-identity`). Its `node_modules` is a **junction** to
`.claude/worktrees/invite-flow/node_modules`: remove the junction itself (`rmdir`, not a
recursive delete) before removing this worktree, or the other worktree's packages go with it.

## 1. Verified state (read 2026-10-13, GitHub API / `git`)

| Item                                | Value                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------- |
| `main`                              | `526f3779d5c6a551f015fd6b07e3bd0bbdaf7150` (#315), unchanged since 2026-10-12 |
| Staging                             | `526f377`, staging-release run 38294065687, success, 2026-10-12 18:54 UTC     |
| Production                          | `fc645727c`, last Production deployment 2026-09-25 13:38 UTC; untouched       |
| #309 head                           | `ff776ab1428632960f4a3517dad2f0fff85d7371`, base `ba79a1a`, 6 commits behind  |
| #310 head                           | `d2ccdf26184f93abb6a6e233eff04b9fc324de5d`, base `ba79a1a`, 6 commits behind  |
| This branch                         | `fix/voice-contact-phone-identity`, from `526f377`                            |
| Run 35914082059 (staging env audit) | still `waiting` since 2026-09-23; separate concurrency group; left alone      |

No merge, deployment, workflow dispatch, environment approval, configuration or data
change was made tonight.

## 2. Priority 1 — Voice contact identity and concurrency

### Existing work checked first

No open PR, issue or branch implements phone normalization or contact deduplication.
`ci/voice-postgres-evidence` (#303, DO NOT MERGE), `integration/rc-2026-10-11*` and
`fix/voice-post-call-summary-failures` only carry the pre-#297 post-call code that `main`
already contains. The repository has no phone-number library.

### Findings (on `main` 526f377)

| #   | Severity | Finding                                                                                                                                                                                                                                                                                            | Reference                                                                |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| F1  | P1       | A caller is matched by exact `phone` equality after removing whitespace only. A contact saved as `+358 40-123 4567`, `(…)`-formatted or `00…` is never found for `+358401234567`, and a duplicate contact is created on every first call. P1: it corrupts the pilot's CRM on the most common path. | `src/app/api/v1/jobs/post-call/route.ts` step 2                          |
| F2  | P1       | The contact step's advisory lock is keyed on the call id. Two different calls from the same new caller processed at once both find nothing and both create a contact.                                                                                                                              | same, `lockedStep`                                                       |
| F3  | P2       | A non-number caller id ("anonymous", a SIP URI), if the provider sends one, was used as a phone: every such call would link to one shared contact with that text as its phone. Calls with no caller number were already skipped.                                                                   | same                                                                     |
| F4  | P2       | CRM search and the AI `searchContacts` tool use `contains` after removing whitespace only, so they miss formatted phones. Not changed tonight (separate surface).                                                                                                                                  | `src/server/services/contacts.ts:42`, `src/server/ai/tools/index.ts:125` |
| F5  | P3       | Manual CRM create, AI `createContact` and public booking store phones as typed and take no phone lock. Booking deduplicates by email (`lockContactEmail`), not phone. Not changed.                                                                                                                 | `contacts.ts:146`, `booking.ts:500-516`, `tools/index.ts`                |

There is no contact import path in the codebase.

### Implemented (commit on this branch, Draft PR)

- `src/lib/crm/phone-identity.ts` (pure). What a caller number identifies:
  - formatting is ignored: spaces (incl. non-breaking), dots, dashes, slashes, parentheses;
  - an international number (`+` or `00`, E.164 digit rules) matches the same digits
    stored with `+` or `00`;
  - a number without an international prefix matches only the same digits. No country
    or trunk prefix is assumed, so `040 1234567` and `+358401234567` remain different;
  - anonymous, SIP, extensions (`;ext=`, `x`, `#`), letters, too short or too long numbers
    identify no one: no lookup, no contact; the call is still processed.
- Post-call step 2: one raw query in the organization, not deleted, oldest first, at most
  two rows. Several matches: the oldest is linked; nothing is merged or changed; a
  warning with ids only. A created contact stores the canonical number.
- `lockContactPhone` (`src/server/calendar/locks.ts`, second key `4`): held with the call
  lock (order: call, then number) around the lookup and create.
- No schema change, migration, backfill or change to any stored contact.

### Decisions left for review (not implemented)

1. **National ↔ international matching** (for example `040…` ↔ `+35840…`). It needs a
   phone library (for example `libphonenumber-js`, a new dependency) and a trustworthy
   country per organization. Without it, any rule guesses a country. Design: store the
   organization's country explicitly; match national forms only when it is set; record the
   rule in `docs/DECISIONS.md`.
2. **Several contacts with one number** link to the oldest. The alternative is to link none
   and flag it for the owner. A product decision.
3. **A DB-level guarantee** (an expression index or a normalized `phone_e164` column with a
   per-organization unique constraint) needs a migration plus a backfill that would expose
   existing duplicates. It cannot be unique while legitimate shared numbers exist. Not
   started.
4. **`(0)` notation** (`+358 (0)40 …`) is not matched: the digits differ once formatting is
   removed. Safe to add with the library from item 1.

### Tested locally vs. verified on staging

- **Local, PASS:**
  - `tests/unit/post-call-contact-identity.test.ts`: 45 new tests;
  - the post-call idempotency and organization-guard suites: 104 in all across the 3 files.
- **Mutation-checked:**
  - without the number lock, the 2 same-caller concurrency tests fail;
  - with whitespace-only formatting, 7 tests fail;
  - without the `00` form, its tests fail.
- **Real Postgres: NOT RUN.** No disposable database was available: Docker isn't running,
  and pulling an image isn't safe with ~5.5 GB free. The scenarios are written into
  `tests/unit/post-call-concurrency.postgres.test.ts`; it runs only with `VOICE_PG_URL`,
  and CI does not set that today.
- **Staging: NOT VERIFIED.** Nothing deployed.

## 3. Priority 2 — Business DNA consistency (#309, #310)

Both are Draft, mergeable (CLEAN), with 18 checks passed on their heads, and 6 commits
behind `main`.

- **#309** (onboarding industry → Business DNA). It creates the profile in the
  organization's own transaction, trims the value, stops writing `settings.industry` for
  new organizations, audits the creation, and adds a skip link while only the industry is
  set. Its tests cover rollback, retry, isolation and the first save's version.
  **Recommendation: ready to merge after a refresh on current `main` and green CI.** Gap:
  existing organizations keep their legacy `settings.industry`; nothing copies it into
  Business DNA.
- **#310** (chat prefers the Business DNA industry). It uses
  `businessDna?.industry?.trim() || settings.industry`.
  - **Finding (P2):** when an owner deliberately clears the Business DNA industry (stored as
    `null`), chat falls back to the legacy onboarding copy, which no screen can edit, so the
    stale value comes back. The PR's own test asserts this fallback ("no industry in
    Business DNA" → legacy value).
  - It is not worse than `main`, where chat always shows the legacy value next to the DNA
    one, but it does not fully fix the drift.
  - **Recommendation: do not merge as is.** Fall back only when no Business DNA record
    exists (`businessDna ? businessDna.industry : settings.industry`), and update the two
    fallback test cases.
  - Trade-off: older organizations whose profile exists without an industry no longer show
    the onboarding value in chat; the owner can enter it in Business DNA.
  - A reviewed one-time copy of `settings.industry` into empty profiles would avoid that.
    It is a data change and needs separate approval.
- Merge order: #309, then the amended #310. They touch different files.
- Still duplicated (P1, unchanged): organization name vs. `displayName`;
  `settings.aiInstructions` vs. Business DNA response instructions.

## 4. Priority 3 — #315 staging QA evidence

The OLD account reported its browser-only QA as **NOT RUN**. No other report exists on the
PR or in local reports. The only runtime evidence comes from this account's session on
2026-10-12 (staging, one test document, then deleted). Graded strictly:

| Evidence                                   | Status         | Basis                                                                                                                           |
| ------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Deployed SHA                               | **VERIFIED**   | Staging health reported build `526f377`; release run 38294065687 success                                                        |
| Initial processing                         | **VERIFIED**   | Uploaded document reached READY, `chunkCount` 1, one "ready" notification                                                       |
| `chunkCount` field before/after redelivery | **VERIFIED**   | 1 → 1 via the Knowledge API                                                                                                     |
| Actual chunk rows before/after             | **UNVERIFIED** | No database read; `chunkCount` is the stored field, not a row count                                                             |
| Ready notifications before/after           | **VERIFIED**   | Exactly one before and after (notifications page)                                                                               |
| Redelivery skipped ("already processed")   | **UNVERIFIED** | One republished message delivered HTTP 200 in 1 s; the console does not show the body; inferred by elimination only             |
| No second embedding / usage charge         | **UNVERIFIED** | Inferred from no new notification; no usage record or provider dashboard was read                                               |
| Cleanup                                    | **PARTIAL**    | Document deleted in the UI and the list is empty (verified); chunk and storage removal are inferred from the code, not observed |

**Correction:** this account's report on 2026-10-12 called the redelivery test a PASS. On
the evidence above, the accurate status is **partially verified**.

Smallest owner action that would close it, with no new delivery and no provider call: in the
staging database (read-only), check for the test document id from the 2026-10-12 session:

- `document_chunks` rows: expect 0 after the deletion;
- `usage_records` with metric `EMBEDDINGS`: expect exactly one, from the first run.

The record count can also be read on the staging Usage page if it shows EMBEDDINGS.

## 5. Validation run tonight (this branch)

| Check                             | Result                                                                                                                                                                                                                                                |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prettier / ESLint (changed files) | PASS                                                                                                                                                                                                                                                  |
| `tsc --noEmit`                    | No errors in changed code. 81 errors elsewhere, all from packages missing locally; the one listed for `post-call-concurrency.postgres.test.ts` is its existing `@prisma/adapter-pg` import, as in other Postgres test files                           |
| Focused tests                     | PASS: 104 (3 files)                                                                                                                                                                                                                                   |
| Full unit suite                   | 3431 passed, 46 skipped, 5 failed in 10 files. 9 files are the known local-environment set (Sentry, `@prisma/internals`, release-chain CLI, tenant-models, error boundaries). `voice-conversation-flow` timed out under load and passes alone (21/21) |
| `i18n:check` / `migrations:check` | NOT APPLICABLE (no messages, schema or migrations changed)                                                                                                                                                                                            |
| `build` / e2e                     | NOT RUN locally (disk); CI runs the build                                                                                                                                                                                                             |
| Real-Postgres concurrency         | NOT RUN (see §2)                                                                                                                                                                                                                                      |

## 6. Remaining pilot and production gates

| Gate                                                                                                               | Source (date)                                                  |
| ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| Review and merge this branch, then a staging release, then one supervised test call from a formatted saved contact | this file (2026-10-13)                                         |
| Real-Postgres run of the post-call concurrency file (disposable database or the #303-style workflow)               | this file; #303 (2026-10-11)                                   |
| #315 evidence gaps in §4                                                                                           | this file (2026-10-13)                                         |
| #309 merge; #310 amendment                                                                                         | this file (2026-10-13)                                         |
| Fruppi supervised pilot: pre-call checklist and 35-case matrix                                                     | `docs/fruppi-voice-pilot-runbook.md` (last changed 2026-10-10) |
| Production has not been deployed since 2026-09-25; any production release needs its own authorization              | GitHub deployments API (read 2026-10-13); `CLAUDE.md` §2/§9    |

## 7. Next three owner actions

1. Review the Draft PR for this branch. If acceptable, approve its merge, then approve a
   separate staging release.
2. Decide #310: approve the "fallback only without a Business DNA record" change, or the
   reviewed one-time industry copy. Approve the #309 merge after its refresh.
3. Close the #315 gaps with the read-only staging check in §4. Choose whether national
   ↔ international phone matching (with a phone library and an organization country) is
   wanted before the pilot.
