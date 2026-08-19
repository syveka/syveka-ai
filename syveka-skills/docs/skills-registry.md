# Syveka Master Skill — Registry Design

This is the design doc for the machine-readable registry implemented in `core/registry/`. For the
human-readable, narrative registry of externally-reviewed Skills (Scrapling etc.), see
`docs/skills/SKILLS_REGISTRY.md` at the Syveka repo root - that document and this codebase's
registry are meant to describe the same underlying facts in two forms (prose for humans, typed
data for the orchestrator), not two independent sources of truth. `core/registry/data.ts`'s
Scrapling entry is transcribed directly from that document's fields.

## Schema (`schemas/index.ts` `registryEntrySchema`)

| Field                                                                    | Purpose                                                                                                        |
| ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `id`                                                                     | Stable identifier                                                                                              |
| `name`                                                                   | Human-readable name                                                                                            |
| `capability`                                                             | The abstract capability this entry serves (routing key)                                                        |
| `provider`                                                               | The `Provider` implementation id this entry maps to                                                            |
| `version` / `commit`                                                     | Exact pinned version - never a floating `latest`/`main`                                                        |
| `source`                                                                 | Authoritative URL                                                                                              |
| `license`                                                                | Required for every entry, including first-party ones (`"N/A (Syveka-owned)"`)                                  |
| `trust_level`                                                            | `TRUSTED` / `CONDITIONAL` / `UNTRUSTED` - used for routing rank when multiple providers serve one capability   |
| `risk_level`                                                             | `LOW` / `MEDIUM` / `HIGH`                                                                                      |
| `status`                                                                 | `APPROVED` / `EXPERIMENTAL` / `REVIEW` / `REJECTED` / `RESEARCH_ONLY`                                          |
| `supported_agents`                                                       | Which adapters can legitimately offer this capability                                                          |
| `permissions`, `network_access`, `filesystem_access`, `scripts`, `hooks` | The concrete capability footprint a security reviewer checked                                                  |
| `dependencies`                                                           | Direct dependencies, for supply-chain awareness                                                                |
| `credential_requirements`                                                | What secrets/keys it needs, if any                                                                             |
| `approval_required`                                                      | Whether using this entry always needs a human approval gate, independent of the per-action risk classification |
| `installation_scope`                                                     | `none` / `local` / `container` / `global` - how far this entry's footprint reaches on a real machine           |
| `last_reviewed` / `last_updated`                                         | Dates - a stale `last_reviewed` is a signal to re-review, not evidence of continued safety                     |
| `security_notes`                                                         | Free text - always links back to the full review document where one exists                                     |

## Statuses and what they mean for routing

| Status          | Routable?                                                                       |
| --------------- | ------------------------------------------------------------------------------- |
| `APPROVED`      | Yes                                                                             |
| `EXPERIMENTAL`  | Yes (controlled/project-scoped use, per the original Skills Lab classification) |
| `REVIEW`        | **No** - exists in the registry for visibility, not usable yet                  |
| `REJECTED`      | **No**, ever, even as a last resort - see `evals/capability-routing.test.ts`    |
| `RESEARCH_ONLY` | **No** - architecture ideas may be studied, code must not be used               |

`core/registry/eligibleForRouting()` is the single choke point enforcing this - see
`docs/architecture.md`.

## Current seed entries (as of this MVP)

| id                       | capability                 | status                 | notes                                                          |
| ------------------------ | -------------------------- | ---------------------- | -------------------------------------------------------------- |
| `local-engineering-test` | `engineering.test`         | APPROVED               | First-party, local, no network                                 |
| `local-git-diff`         | `engineering.diff_capture` | APPROVED               | First-party, local, no network                                 |
| `local-skill-registry`   | `skill.discovery`          | APPROVED               | First-party, searches this registry only                       |
| `scrapling`              | `research.web.fetch`       | APPROVED (conditional) | Reviewed, not installed - see `docs/skills/SECURITY_REVIEW.md` |
| `shadcn-mcp`             | `ui.component.provide`     | REVIEW                 | Not independently reviewed yet                                 |
| `twentyfirst-dev`        | `ui.component.discover`    | REVIEW                 | Metered service, needs owner approval before any use           |
| `claude-video`           | `video.analyze`            | REVIEW                 | Not independently reviewed yet                                 |

Notice only 3 of 7 entries are `APPROVED`, and all 3 of those are first-party/local. This is
intentional, not a shortfall to apologize for: it's the registry accurately reflecting what has
actually been reviewed, which is the entire point of having one.

## Production evolution path (not built in this MVP)

A real deployment would replace the static `core/registry/data.ts` array with a versioned registry
service (database-backed), support org-scoped private registry entries (ENTERPRISE tier, see
`docs/commercialization.md`), and add a review workflow UI. The `registryEntrySchema` and the
`eligibleForRouting`/`findByCapability`/`searchRegistry` function signatures are designed to be
swappable onto a real datastore without changing any caller.
