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

| Item                                | Value                                                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------------------ |
| `main`                              | `526f3779d5c6a551f015fd6b07e3bd0bbdaf7150` (#315), unchanged since 2026-10-12                    |
| Staging                             | `526f377`, staging-release run 38294065687, success, 2026-10-12 18:54 UTC                        |
| Production                          | `fc645727c`, last Production deployment 2026-09-25 13:38 UTC; untouched                          |
| #309 head                           | `8a2eccceaf12fbfe4d5bc87a718f48b8cc76d40b`: `ff776ab` plus a merge of `main` 526f377             |
| #310 head                           | `0bdd97d5cdc6f75f6c56e038172b0ee8c70d6663`: `d2ccdf2` plus a merge of `main` 526f377             |
| #310 amendment (branch only, no PR) | `fix/chat-industry-no-stale-fallback` `4280308f7df4e1e7f0aac49ae7acddc640929468`, on top of #310 |
| This branch                         | `fix/voice-contact-phone-identity`, from `526f377`                                               |
| Run 35914082059 (staging env audit) | still `waiting` since 2026-09-23; separate concurrency group; left alone                         |

No merge, deployment, workflow dispatch, environment approval, configuration or data
change was made tonight.

## 2. Priority 1 — Voice contact identity and concurrency

### Existing work checked first

No open PR, issue or branch implements phone normalization or contact deduplication.
`ci/voice-postgres-evidence` (#303, DO NOT MERGE), `integration/rc-2026-10-11*` and
`fix/voice-post-call-summary-failures` only carry the pre-#297 post-call code that `main`
already contains. The repository has no phone-number library.

### Findings (on `main` 526f377)

F1-F3 are **still open on `main`, staging and production.** #316 is a proposed fix: Draft,
not reviewed, not merged, not deployed.

| #   | Severity | Finding                                                                                                                                                                                                                                                                                            | Reference                                                                |
| --- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| F1  | P1       | A caller is matched by exact `phone` equality after removing whitespace only. A contact saved as `+358 40-123 4567`, `(…)`-formatted or `00…` is never found for `+358401234567`, and a duplicate contact is created on every first call. P1: it corrupts the pilot's CRM on the most common path. | `src/app/api/v1/jobs/post-call/route.ts` step 2                          |
| F2  | P1       | The contact step's advisory lock is keyed on the call id. Two different calls from the same new caller processed at once both find nothing and both create a contact.                                                                                                                              | same, `lockedStep`                                                       |
| F3  | P2       | A non-number caller id ("anonymous", a SIP URI), if the provider sends one, was used as a phone: every such call would link to one shared contact with that text as its phone. Calls with no caller number were already skipped.                                                                   | same                                                                     |
| F4  | P2       | CRM search and the AI `searchContacts` tool use `contains` after removing whitespace only, so they miss formatted phones. Not changed tonight (separate surface).                                                                                                                                  | `src/server/services/contacts.ts:42`, `src/server/ai/tools/index.ts:125` |
| F5  | P3       | Manual CRM create, AI `createContact` and public booking store phones as typed and take no phone lock. Booking deduplicates by email (`lockContactEmail`), not phone. Not changed.                                                                                                                 | `contacts.ts:146`, `booking.ts:500-516`, `tools/index.ts`                |

There is no contact import path in the codebase.

### Proposed fix: Draft PR #316 (awaiting review; not merged or deployed)

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
- **Staging: NOT VERIFIED.** #316 is not merged or deployed; staging still runs the old
  matching.

## 3. Priority 2 — Business DNA consistency (#309, #310)

Both are Draft. On 2026-10-13 both were brought up to date with a normal merge of `main`
526f377 (no rebase, no force-push); the merges had no conflicts. Locally after the refresh:

- #309: 20 Business DNA, onboarding and organization test files (307 tests) and 6 form and
  prompt files (36 tests) pass; Prettier and ESLint pass; `tsc` reports the known 24
  missing-package errors only;
- #310: 7 chat and prompt files (83 tests) pass.

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
    exists.
  - The change is prepared on branch `fix/chat-industry-no-stale-fallback` (`4280308`,
    pushed, **no PR**) and waits for the product decision below. The two fallback cases now
    assert that no legacy text appears; both fail with #310's previous line. 83 chat and
    prompt tests pass.
  - If the decision is approved, apply it to #310 by merging that branch into it.
  - Trade-off: older organizations whose profile exists without an industry no longer show
    the onboarding value in chat; the owner can enter it in Business DNA.
  - A reviewed one-time copy of `settings.industry` into empty profiles would avoid that.
    It is a data change and needs separate approval.
- Merge order: #309, then the amended #310. They touch different files.
- Still duplicated (P1, unchanged): organization name vs. `displayName`;
  `settings.aiInstructions` vs. Business DNA response instructions.

## 4. Priority 3 — #315 staging QA evidence

**Overall verdict: PARTIALLY VERIFIED.**

The OLD account reported its browser-only QA as NOT RUN. The browser QA run by this account
on 2026-10-12 is the only runtime evidence. It used staging, one test document and one
approved republish. Times below are UTC; the QStash console showed UTC+3.

### Observed

- The deployed staging build was `526f377`: health endpoint and release run 38294065687.
- The test document was uploaded and reached READY. Its first QStash delivery at 20:13:52
  returned HTTP 200.
- **One approved republish** of the same job body (QStash Request Builder, 20:20:38)
  returned **HTTP 200** in about 1 s.
- The document **remained READY**, with a **displayed chunk count of 1 before and after**
  the republish.
- **Exactly one ready notification** was visible after the republish.
- After deletion in the UI, the **document disappeared from the list**, and the Knowledge
  API then listed none.

### Unverified

- **The exact response body.** The QStash console does not show it.
- **Whether chunk rows were replaced.** A full reprocess deletes and re-inserts the same
  number of chunks, so an unchanged displayed count cannot rule out replacement.
- **Whether a second embedding request or usage charge occurred.** The ready notification
  is written in a separate step that only logs its own failure. No new notification is
  therefore not proof that no paid call was made.
- **Physical removal of the chunks and the stored file** after the deletion.

**Correction:** the 2026-10-12 report's "only possible outcome" and "no notification
means no paid call" conclusions were inferences, not evidence. Its PASS is withdrawn.

### Existing evidence that could close the gaps

No new delivery, paid call, credential access or database query is needed for any of these.
Each is a read of an existing dashboard or log by the owner.

| Gap                          | Existing source                                                                                                                 | What decides it                                                                                                                                                          | Caveat                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Second embedding / paid call | OpenAI platform → Usage, for the project or key staging uses, model `text-embedding-3-small`, 2026-10-12 20:13–20:22 UTC        | One embeddings request (the first run) means no second paid call. Two means a reprocess                                                                                  | Decisive only if staging has its own project or key and nothing else embedded in that window. A Knowledge-base chat query also makes one embedding call |
| Chunk replacement            | Same as above                                                                                                                   | A reprocess has to call the embedding API before it re-inserts chunks (the document stayed READY, so a failed partial run is excluded). One request means no replacement | The chunks were deleted with the document, so the rows themselves no longer show it                                                                     |
| Response body                | Vercel runtime logs, staging deployment of `526f377`: `POST /api/v1/jobs/embed-document` near 20:20:38                          | Execution time and any outgoing request to `api.openai.com`, if Vercel Observability records outgoing requests on this plan, separate a skip from a run                  | The success path writes no log line, so the body itself is never logged. Log retention depends on the plan (possibly only about a day), so check soon   |
| Usage charge record          | `usage_records` (metric `EMBEDDINGS`, `metadata.documentId`)                                                                    | One row means one charged run                                                                                                                                            | Database read: deferred under the current instruction. No app page shows EMBEDDINGS usage                                                               |
| File removal                 | Supabase dashboard → Storage, `documents` bucket, the organization's folder; or the Supabase Storage logs for the deletion time | Object absent, or a successful delete request logged                                                                                                                     | Storage log retention depends on the plan                                                                                                               |
| Chunk removal                | Supabase Logs Explorer (Postgres)                                                                                               | Probably not decisive: statement logging is not on by default                                                                                                            | A database read of `document_chunks` would decide it (deferred)                                                                                         |

Recommended order:

1. The OpenAI usage view: it decides the paid call and the chunk replacement together.
2. The Vercel logs, before their retention runs out.
3. The Storage view.

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

| Gate                                                                                                                | Source (date)                                                  |
| ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Voice F1-F3 open: review and merge #316 (proposed), a staging release, one supervised call from a formatted contact | #316 (2026-10-13)                                              |
| Real-Postgres run of the post-call concurrency file (disposable database or the #303-style workflow)                | this file; #303 (2026-10-11)                                   |
| #315: PARTIALLY VERIFIED; close the gaps in §4 from existing logs and dashboards                                    | this file (2026-10-13)                                         |
| #309 merge; #310 amendment                                                                                          | this file (2026-10-13)                                         |
| Fruppi supervised pilot: pre-call checklist and 35-case matrix                                                      | `docs/fruppi-voice-pilot-runbook.md` (last changed 2026-10-10) |
| Production has not been deployed since 2026-09-25; any production release needs its own authorization               | GitHub deployments API (read 2026-10-13); `CLAUDE.md` §2/§9    |

## 7. Next three owner actions

1. Review the Draft PR for this branch. If acceptable, approve its merge, then approve a
   separate staging release.
2. Decide #310: approve the "fallback only without a Business DNA record" change, or the
   reviewed one-time industry copy. Approve the #309 merge after its refresh.
3. Read the OpenAI usage view for the #315 window, then the staging Vercel logs, as in §4.
   Choose whether national ↔ international phone matching (with a phone library and an
   organization country) is wanted before the pilot.
