# Business DNA Website Ingestion — Gap Review Against Phase 7's Critical Rules

This reviews the mission's 8 "critical rules" for Business DNA website ingestion against what
`src/server/services/business-dna-extraction.ts` + `RegenerateFromWebsite` already do, so the next
person doesn't have to re-derive this from source.

| #   | Rule                                                   | Status             | Evidence                                                                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Approved Business DNA is authoritative                 | **Met**            | `getBusinessDNA`/`getBusinessDnaContext` only ever read the persisted, saved row — extraction output never substitutes for it.                                                                                                                                                                   |
| 2   | Crawled data must not silently overwrite approved data | **Met**            | `extractBusinessDnaFromUrl` returns data to the client only; `RegenerateFromWebsite.handleExtracted` merges into the _form's in-memory state_, not the database; persistence requires the human to click Save (`updateBusinessDnaAction`).                                                       |
| 3   | Conflicting information must be surfaced               | **Gap**            | `mergeExtractedTextFields` fills only fields the extraction returned, leaving existing values elsewhere untouched — this avoids overwriting, but does not flag _when_ an extracted value disagrees with an existing one. No field-level "this conflicts with your saved value" indicator exists. |
| 4   | Missing required fields must be surfaced               | **Partial**        | The form itself already shows an empty-state banner (`emptyBanner`, `isNew` branch) for a brand-new profile, but there's no per-field "extraction found nothing for this" signal distinct from "you haven't filled this in yet."                                                                 |
| 5   | Sources should be retained where feasible              | **Met**            | `sourceUrl` is threaded through the extract response and stored on `BusinessDNA.sourceUrl`/`extractedAt` (`docs/business-dna-mvp.md`).                                                                                                                                                           |
| 6   | Tenant isolation must be preserved                     | **Met, unchanged** | Extraction takes no `orgId` from the client; `upsertBusinessDNA` writes through `tenantDb(ctx.orgId)` exactly like every other Business DNA mutation.                                                                                                                                            |
| 7   | RLS/RBAC must remain correct                           | **Met, unchanged** | Extraction endpoint is gated the same as the rest of `/settings/business-dna` (`business-dna:write` for anything that can trigger a re-extract); nothing in this review found or introduced a bypass.                                                                                            |
| 8   | No secrets/private data leak between orgs              | **Met, unchanged** | The extraction call only ever fetches the URL the authenticated user themselves supplied for their own org's profile — no cross-org read path exists in this flow.                                                                                                                               |

## Net assessment

**6 of 8 fully met today, 1 partial, 1 real gap** (#3, field-level conflict surfacing). This is a
genuinely good starting position — better than "needs to be built from scratch" — and the two open
items are both **UI/UX features**, not architecture gaps: the data needed to build them already
exists (the form already has both the current value and the extracted value in memory at merge
time; a "conflict" is just `current !== extracted && current !== ""`).

## Recommendation

Do not build the conflict/missing-field UI in this foundation pass — it is a scoped product
feature change to an existing, already-working, already-tested surface
(`business-dna-form.tsx`, currently covered by the render tests added on
`fix/business-dna-onboarding-crash`), and this pass's mandate is architecture/foundation, not new
product features. Logged here as a NEXT-classified follow-up: "Business DNA regenerate-from-website
conflict indicator" — a small, well-scoped `git diff`-sized change once picked up, not a redesign.
