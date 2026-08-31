# Business DNA Website Ingestion — Gap Review Against Phase 7's Critical Rules

This reviews the mission's 8 "critical rules" for Business DNA website ingestion against what
`src/server/services/business-dna-extraction.ts` + `RegenerateFromWebsite` already do, so the next
person doesn't have to re-derive this from source.

**Update**: the two items this review originally flagged as "Gap"/"Partial" (#3 and #4 below) were
closed by `feat/business-dna-conflict-indicators` (PR #105) —
`src/lib/business-dna/classify-extracted.ts` + `field-review-indicator.tsx`. The table below is
kept as the historical record of what was found and recommended; both rows now read "Met."

| #   | Rule                                                   | Status             | Evidence                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Approved Business DNA is authoritative                 | **Met**            | `getBusinessDNA`/`getBusinessDnaContext` only ever read the persisted, saved row — extraction output never substitutes for it.                                                                                                                                                            |
| 2   | Crawled data must not silently overwrite approved data | **Met**            | `extractBusinessDnaFromUrl` returns data to the client only; `RegenerateFromWebsite.handleExtracted` merges into the _form's in-memory state_, not the database; persistence requires the human to click Save (`updateBusinessDnaAction`).                                                |
| 3   | Conflicting information must be surfaced               | **Met** (PR #105)  | `classifyExtractedTextFields`/`classifySupportedLocales` classify every field as SAME/NEW/CONFLICT/MISSING before anything is applied; a CONFLICT renders an inline card (current vs. website value) with explicit "Keep current"/"Use website value" actions — never auto-applied.       |
| 4   | Missing required fields must be surfaced               | **Met** (PR #105)  | An important field (`IMPORTANT_TEXT_FIELDS`: displayName, description, productsServices, currency — editorial, not schema-required) with nothing on either side now shows a distinct "Not found on website — please verify" indicator, separate from the pre-existing empty-state banner. |
| 5   | Sources should be retained where feasible              | **Met**            | `sourceUrl` is threaded through the extract response and stored on `BusinessDNA.sourceUrl`/`extractedAt` (`docs/business-dna-mvp.md`).                                                                                                                                                    |
| 6   | Tenant isolation must be preserved                     | **Met, unchanged** | Extraction takes no `orgId` from the client; `upsertBusinessDNA` writes through `tenantDb(ctx.orgId)` exactly like every other Business DNA mutation.                                                                                                                                     |
| 7   | RLS/RBAC must remain correct                           | **Met, unchanged** | Extraction endpoint is gated the same as the rest of `/settings/business-dna` (`business-dna:write` for anything that can trigger a re-extract); nothing in this review found or introduced a bypass.                                                                                     |
| 8   | No secrets/private data leak between orgs              | **Met, unchanged** | The extraction call only ever fetches the URL the authenticated user themselves supplied for their own org's profile — no cross-org read path exists in this flow.                                                                                                                        |

## Net assessment (original, at the time of the AI Skills Foundation pass)

**6 of 8 fully met today, 1 partial, 1 real gap** (#3, field-level conflict surfacing). This is a
genuinely good starting position — better than "needs to be built from scratch" — and the two open
items are both **UI/UX features**, not architecture gaps: the data needed to build them already
exists (the form already has both the current value and the extracted value in memory at merge
time; a "conflict" is just `current !== extracted && current !== ""`).

## Recommendation (original) — superseded, see update above

Do not build the conflict/missing-field UI in this foundation pass — it is a scoped product
feature change to an existing, already-working, already-tested surface
(`business-dna-form.tsx`, currently covered by the render tests added on
`fix/business-dna-onboarding-crash`), and this pass's mandate is architecture/foundation, not new
product features. Logged here as a NEXT-classified follow-up: "Business DNA regenerate-from-website
conflict indicator" — a small, well-scoped `git diff`-sized change once picked up, not a redesign.

**Current status**: built, exactly as scoped above, in PR #105 — see `docs/business-dna-mvp.md`'s
"Website extraction review" section for the shipped behavior. Remaining deferred items (unchanged):
opening-hours conflict detection and per-service conflict detection — both documented as scoped-out
limitations in that same section, not silent gaps.
