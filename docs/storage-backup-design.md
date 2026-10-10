# Supabase Storage backup and recovery design

**Status: design only. No infrastructure was created and no cost was incurred.** Database
backups (daily PHYSICAL, or PITR) exclude Storage objects; only their metadata rows are included.
Today Syveka has **no independent copy of any uploaded file**.

## Inventory (from the repository at `eca6822`)

Buckets are created in `prisma/sql/004_storage.sql`. The private buckets' policies require an
object's first folder to be the organization id (`storage.foldername(name)[1] = org_id`).

| Bucket                     | Public | Layout                            | Written by                                                                                 | Referenced by                                              | Sensitivity                                                   | Recovery importance                                                                                                                                    |
| -------------------------- | ------ | --------------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `documents`                | No     | `orgId/<uuid>/<file>`             | `src/server/services/documents.ts`                                                         | `Document.storagePath`, `DocumentUploadIntent.storagePath` | Customer business documents (may contain personal data)       | **High**: knowledge base answers depend on them (chunks/embeddings live in the database, so search survives, but source files and re-embedding do not) |
| `creator-reference-assets` | No     | `orgId/<profileId>/<uuid>/<file>` | `src/server/services/creator-profiles.ts`                                                  | `CreatorReferenceAsset.storagePath`                        | **Highest**: people's likeness images, uploaded under consent | High while Creator Studio is in use                                                                                                                    |
| `creator-generated-media`  | No     | `orgId/...`                       | `src/server/ai/creator/fal-provider.ts`                                                    | `CreatorReferenceAsset.storagePath` (generated assets)     | AI-generated media of real people                             | Medium: regenerable at provider cost, but published posts reference them                                                                               |
| `voice-recordings`         | No     | org-prefixed by policy            | **Unused**: call recordings are Vapi-hosted (`VoiceCall.recordingUrl` from Vapi's webhook) | —                                                          | —                                                             | None today. Recording retention is a Vapi setting                                                                                                      |
| `exports`                  | No     | org-prefixed by policy            | **Unused** today (planned for GDPR export)                                                 | —                                                          | —                                                             | None today                                                                                                                                             |
| `avatars`                  | Yes    | `userId/...` (policy)             | No app code writes it today                                                                | `User.avatarUrl`                                           | Low                                                           | Low                                                                                                                                                    |
| `org-logos`                | Yes    | —                                 | No app code writes it today                                                                | `Organization.logoUrl`                                     | Low                                                           | Low                                                                                                                                                    |

## Restore ordering and integrity

1. Restore the database (or confirm it is intact).
2. Restore objects **by exact path** into the same bucket names; paths are the join key to the
   rows above, so no rewriting is needed.
3. Verify: every `Document.storagePath` and `CreatorReferenceAsset.storagePath` row resolves to
   an object (report missing paths per organization); sampled objects match the backup's SHA-256
   manifest.
4. Objects with no referencing row (orphans) are reported, not deleted, until reviewed.

## Option A: production-grade scheduled backup

- **Mechanism:** Supabase Storage's S3-compatible endpoint, copied nightly with `rclone sync`
  (or `aws s3 sync`) to an **external** S3-compatible bucket in an EU region (for example AWS S3,
  Cloudflare R2 or Backblaze B2), run by a scheduled job outside the application (a dedicated
  GitHub Actions workflow with its own environment and reviewers, or a small scheduled worker).
- **Versioning and immutability:** bucket versioning on, plus object-lock or retention rules, so
  a compromised or buggy run can't destroy the history.
- **Credentials:** a dedicated Supabase S3 access key used only by the backup job, stored as an
  environment secret with required reviewers; the destination key is write-only for the job and
  read-only for restores (separate keys).
- **Encryption:** server-side encryption at the destination; the bucket is never public; access
  is limited to the owner and the backup job.
- **Manifest:** each run writes a manifest (path, size, SHA-256, run time) and fails loudly on
  any copy error; an alert fires if the last successful run is older than 36 hours.
- **Restore drill:** quarterly, into the disposable project from `docs/recovery-drill-runbook.md`.
- **Cost (order of magnitude):** storage at roughly a few cents per GB-month at these providers,
  plus versioning overhead; at pilot volumes (single-digit GB) this is well under a few euros a
  month. Exact pricing must be checked when a provider is chosen.
- **Operational complexity:** medium: one workflow, two secrets, one alert, a quarterly drill.

## Option B: pilot-safe, lower-cost backup

- The same `rclone` copy, **run daily or weekly** on a schedule, of only the buckets in use
  (`documents`, `creator-reference-assets`, `creator-generated-media`), to an encrypted external
  bucket **with versioning** but without object lock, keeping a fixed number of versions.
- Manifest and failure alert as in A; restore tested once before the pilot starts.
- **Complexity:** low. **Limits:** shorter history, no immutability, weaker protection against a
  compromised credential.

## GDPR interaction (owner decision required)

A backup keeps deleted files until they expire from it. The backup retention must be no longer
than the deletion promise allows, and the privacy notice should state it. Erasure (#290) deletes
live objects only; backup copies age out by retention. **The retention period is a legal decision
and is not chosen here.**

## Recommendation

- **Limited Pilot: Option B**, with versioning, a failure alert, and one tested restore before the
  first pilot customer uploads files. Creator likeness assets make an untested backup unacceptable.
- **Full Production: Option A**, including object lock and the quarterly drill.

Owner actions: choose the destination provider and region, approve the cost, create the two
credentials, decide retention, and authorize the workflow (it is a CI/infrastructure change).
