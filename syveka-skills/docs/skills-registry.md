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
| `integration_state`                                                      | `REFERENCE` / `REVIEWED` / `INSTALLED` / `CONNECTED` / `VERIFIED` - see below, distinct from `status`          |
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

## Integration state vs. review status

`status` answers "has this been reviewed and approved to route to." `integration_state` answers a
different question: "how far has the actual code integration progressed." A registry entry can be
`status: "APPROVED"` while `integration_state: "REFERENCE"` (the review said yes, nobody has
written provider code yet) - the two axes are independent on purpose.

| State       | Meaning                                                                            |
| ----------- | ---------------------------------------------------------------------------------- |
| `REFERENCE` | Studied/documented only - no provider code exists                                  |
| `REVIEWED`  | Security review complete - still no provider code                                  |
| `INSTALLED` | Provider code exists, has not yet been exercised against the real dependency       |
| `CONNECTED` | Provider code has been run against the real dependency at least once, manually     |
| `VERIFIED`  | Automated tests/evals exercising the real integration have actually run and passed |

**`VERIFIED` is earned, not granted.** Marking an entry `VERIFIED` on the strength of a code
review, a design document, or "it should work" is exactly the failure mode this field exists to
prevent - see `evals/scrapling-live.test.ts` for what actually had to pass (real Docker, real
network, 5/5) before Scrapling's entry was allowed to say `VERIFIED`, and
`docs/skills/scrapling-integration.md`'s "Milestone 2" section for two real bugs that live testing
caught which a code review alone did not (a `--read-only` flag incompatible with the image's own
entrypoint, and an external test service that stopped behaving as documented).

## Current seed entries (as of this milestone)

| id                       | capability                 | status                 | integration_state | notes                                                                |
| ------------------------ | -------------------------- | ---------------------- | ----------------- | -------------------------------------------------------------------- |
| `local-engineering-test` | `engineering.test`         | APPROVED               | VERIFIED          | First-party, local, no network                                       |
| `local-git-diff`         | `engineering.diff_capture` | APPROVED               | VERIFIED          | First-party, local, no network                                       |
| `local-skill-registry`   | `skill.discovery`          | APPROVED               | VERIFIED          | First-party, searches this registry only                             |
| `scrapling`              | `web.research`             | APPROVED (conditional) | VERIFIED          | Real Docker-isolated provider, live-tested - see Milestone 2 section |
| `shadcn-mcp`             | `ui.component.provide`     | REVIEW                 | REFERENCE         | Not independently reviewed yet                                       |
| `twentyfirst-dev`        | `ui.component.discover`    | REVIEW                 | REFERENCE         | Metered service, needs owner approval before any use                 |
| `claude-video`           | `video.analyze`            | REVIEW                 | REFERENCE         | Not independently reviewed yet                                       |

Scrapling is the first (and so far only) externally-sourced entry to reach `VERIFIED` - everything
else either stayed first-party/local or is still honestly `REFERENCE`. This is intentional, not a
shortfall to apologize for: it's the registry accurately reflecting what has actually been
reviewed and proven, which is the entire point of having one.

## Production evolution path (not built in this MVP)

A real deployment would replace the static `core/registry/data.ts` array with a versioned registry
service (database-backed), support org-scoped private registry entries (ENTERPRISE tier, see
`docs/commercialization.md`), and add a review workflow UI. The `registryEntrySchema` and the
`eligibleForRouting`/`findByCapability`/`searchRegistry` function signatures are designed to be
swappable onto a real datastore without changing any caller.
