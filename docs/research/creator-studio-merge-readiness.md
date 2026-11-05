# Creator Studio render worker: merge readiness

For the owner, as the evidence requested before any merge of #400. State as of 2026-11-05.

**Status: EXPERIMENTAL. Not INTEGRATION-READY, not PRODUCTION-READY. Do not merge or deploy #400.**

| Stage                 | Meaning                                       | Status                                                                  |
| --------------------- | --------------------------------------------- | ----------------------------------------------------------------------- |
| **EXPERIMENTAL**      | Developer machine, synthetic or trusted media | **Yes,** with the conditions in "Security findings"                     |
| **INTEGRATION-READY** | Work against staging with real footage        | **No.** Needs the items in "Path to integration"                        |
| **PRODUCTION-READY**  | Real customers                                | **No.** Also needs stronger isolation, legal answers and a product case |

**Architecture decision (owner, 2026-11-05):** HyperFrames is an optional template-rendering engine,
alongside Kling and other AI video providers. It doesn't replace the existing generation infrastructure.

## Commits and CI

| Pull request | Head SHA                                                                      | CI at that SHA                                                    | Status                  |
| ------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------- |
| #400         | Reviewed: `83821190c4f5b1cb92cbfa0d1432b7d987e130d8`. The head adds docs only | Read at the PR's head                                             | Draft. **Do not merge** |
| #401         | `e2293351e24d952073a785302092c4ec439f93ff`                                    | **None,** since `ci.yml` targets `main`. Three Vercel checks only | Draft, stays stacked    |
| #402         | This branch's head                                                            | See the pull request                                              | Draft, for final review |

`main` is unchanged at `40f71ae7df7c9d95781ed2f7537f386c49881ae0`. CI evidence for a PR must be read at its
head SHA, since this document can't record the SHA of the commit containing it.

## Security findings

Independent review of `83821190`, from a context that didn't write the code. It read the code and ran
nothing. **Two HIGH findings stay open.**

| Area                   | Verdict                                                                      |
| ---------------------- | ---------------------------------------------------------------------------- |
| Forged RESULT defense  | **BROKEN against "never a false success".** See finding 1                    |
| Output hash            | **SOUND for transport only:** bytes on disk are the bytes received           |
| Docker logging limits  | **SOUND** by reading: `--log-driver=none`, non-file bytes capped             |
| Container isolation    | **WEAK:** good flags, adequate for a pilot; shared kernel, no Chrome sandbox |
| Timeout and kill latch | **SOUND for the caller's answer;** stopping the container isn't guaranteed   |

| Severity | Open finding                                                                                                                                                                                                                                                   | Needed before |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| HIGH     | **`ok` and `hostVerified` mean "arrived intact", not "valid".** A compromised container can send any self-consistent bytes, such as a five-byte file, and get `ok:true`. Needs a rename to `transportVerified` and a separate structural MP4 check on the host | Integration   |
| HIGH     | **A deliberate crash can still reach the host's crash handler,** by lowering its own limit. Repeated dumps can fill a disk, as in the pilot's incident. From reading only, untested. No container flag fixes it; the host must                                 | Hostile media |
| MEDIUM   | No reaper or lifetime limit for orphaned containers. 4 CPUs and 3 GB can stay in use after a client or host crash                                                                                                                                              | Integration   |
| LOW      | A cleanup failure can be hidden behind another error code, though `ok` stays false                                                                                                                                                                             | Integration   |
| LOW      | A missing input path skips symlink resolution. Requires write access to the jobs root                                                                                                                                                                          | Integration   |
| LOW      | A hung `docker kill` isn't retried (the outcome stays honest). The container's exit code is ignored after a good result. The seam requires `durationSeconds`, whose only source is a worker claim                                                              | Integration   |

**Conditions for pilot use:** synthetic or trusted media only, on a machine with disk to spare, with
the crash handler neutralized before any hostile media.

### History of the reviews

Six reviews of successive revisions, each finding real problems, all but those above fixed: a writable
output mount, a forged result claiming success with one real file, unbounded Docker logs, missing deadlines,
an input swap race, unverified Chrome, a failed rename crashing the host. **These are subagent reviews,
not human approval,** and **the last one ran nothing.**

## Test coverage gaps

| Gap                                                                                                         | Risk                                                                                                  |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **CI doesn't run the container.** Unit tests check that flags are present, not what they do                 | A change could break isolation with CI green. See `docs/architecture/container-probes-ci-proposal.md` |
| Probes were run by hand; 55 of 55 at the final image, which only differs from the head in host-side scripts | They're configuration self-tests, not a penetration test                                              |
| No forged stream from a real container; `runWorker` is tested with Docker faked                             | Real attach behaviour with `--log-driver=none` isn't asserted, though real renders work               |
| `killLeftoverProcesses`, `copyInput`, `verifyOutput` have no unit tests                                     | Covered only by hand-run probes and real renders                                                      |
| Not attempted: lowering the core limit, `memfd_create`, `ptrace`, real exploits                             | The containment is designed for them, not proven                                                      |
| Host disk-full behaviour; a hung `docker kill`                                                              | Expected to fail closed, by reading only                                                              |
| Real Kling footage, real customer content, cloud Linux, concurrency, audio                                  | All media was synthetic, and on one laptop                                                            |
| Native FI and AR review                                                                                     | Judged from frames by a non-native reviewer                                                           |
| The render timings are from an earlier revision                                                             | Later changes were to host-side result handling                                                       |

## Licensing blockers

Details: [video-licensing-review.md](video-licensing-review.md). Questions for counsel, kept separate:
[legal-questions-for-counsel.md](legal-questions-for-counsel.md). In short:

| Blocker                                                                                    | Blocks                     | Owner                |
| ------------------------------------------------------------------------------------------ | -------------------------- | -------------------- |
| fal: no clause assigns output ownership, and SaaS clauses conflict                         | **The live product too**   | Counsel, fal         |
| H.264 encoding at commercial scale                                                         | Production                 | Counsel              |
| GPL FFmpeg build: what counts as distribution, and the licence text missing from the image | Production or distribution | Counsel, engineering |
| Third-party notices for code bundled inside `hyperframes`                                  | Production or distribution | Engineering          |
| GSAP                                                                                       | **Nothing:** not used      | None                 |

## Integration approach

**Not implemented.** `integration/creator-template-renderer.ts` is only a typed seam, and nothing in `src/`
imports it. Existing Kling generation is unchanged in every step below.

```
Existing, unchanged:  prompt → CreatorMediaProvider (fal/Kling) → stored asset
New, optional:        stored asset or none → template request → worker service → stored video
```

1. **A separate provider seam.** A new `CreatorTemplateRenderer`, not a change to `CreatorMediaProvider`:
   templates aren't generations, and the two have different inputs and costs. Routing picks one by what the
   customer asked for, so a template never silently replaces a generation.
2. **A separate worker service,** since Vercel functions can't run this. Likely a queue-driven container
   (Cloud Run Jobs or similar) in an EU region, with no route from it to customer data other than one job's
   staged inputs. `RENDER_JOBS_ROOT` becomes a per-job scratch mount.
3. **Identity from the server session only.** The worker gets no org id. The caller loads assets through
   the existing tenant-scoped path, using `requirePermission` and `tenantDb`, and stores output under the
   caller's own org path. **The seam's `AssetStager` has no tenant check today; it must have one.**
4. **Product flow:** Preview → Confirm → Execute → Verify → Audit, on the existing generation, asset and
   credit services. A new generation type would need a schema change, which is separately reviewed.
5. **Credits reserved before rendering,** and released on failure, with a separate lower price to be decided.
6. **Rate limits and concurrency caps per org,** using the shared limiter.
7. **FI, EN and AR strings and RTL review,** by native speakers.
8. **4:5 templates,** which Creator Studio offers and these don't. The seam refuses 4:5 today.

Also feature-flagged per org and off by default, with cross-tenant negative tests.

### Path to integration

- Fix findings 1 and 3, and the LOW items.
- Agree the host's crash-handler policy, and run the probes in CI (proposal in this PR).
- Run the image and probes on the target platform.
- Get answers on fal output rights, since those also affect the live product.
- **Decide whether customers want templates.** Nothing here measures demand.

## Cost model

**All estimates.** CPU and memory were measured on a laptop. Rates and hours are assumptions. The $75/hour
matches the voice analysis in #395.

Per render: 75–150 CPU-seconds at 1.3–2.6 GB, about $0.002–$0.004 in compute at an assumed $0.000024 per
vCPU-second and $0.0000025 per GiB-second. **These rates weren't re-read,** and cloud CPUs may differ.

| Monthly cost, by renders                 | 1,000          | 10,000         | 100,000          | Basis                                                    |
| ---------------------------------------- | -------------- | -------------- | ---------------- | -------------------------------------------------------- |
| Compute, at $0.004                       | $4             | $40            | $400             | Measured CPU, assumed rate                               |
| Output storage, 1 MB each, 3 months kept | Under $1       | $2             | $20              | Assumed about $0.02/GB-month; retention is undecided     |
| Egress, each video viewed once           | Under $1       | $1             | $9               | Assumed about $0.09/GB. Unverified                       |
| Queue, logs, registry, monitoring        | $10            | $20            | $100             | Judgement                                                |
| **Infrastructure subtotal**              | **About $15**  | **About $63**  | **About $529**   |                                                          |
| Operations, hours                        | 4              | 8              | 20               | Judgement: security updates, base image and Chrome bumps |
| Operations at $75/hour                   | $300           | $600           | $1,500           |                                                          |
| **Monthly total**                        | **About $315** | **About $663** | **About $2,029** |                                                          |
| Per render, all-in                       | $0.32          | $0.07          | $0.02            |                                                          |

| One-off                                    | Estimate      |
| ------------------------------------------ | ------------- |
| Security fixes and CI probes               | 1 week        |
| Worker service and queue                   | 1–2 weeks     |
| Product integration, credits, UI, FI/EN/AR | 2–4 weeks     |
| Legal review                               | Not estimated |

**What this means.** Compute is the small part. At low volume, operations dominate, and a template render
costs **more all-in than the about $0.42 of a Kling clip below roughly 800 renders a month.** Above that it
wins, and at 10,000 it costs about a sixth. Generation isn't replaced, because templates can't make footage.

## Rollback plan

| Stage                          | Rollback                                                                                                                                   | Data impact                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- |
| **Now, draft**                 | Close #400, delete the branch (a protected action), and remove the local image and worktree                                                | None                                  |
| **If merged as an experiment** | `git revert`. Nothing in `src/` imports it, and it adds no route, schema, environment variable or dependency to the root package           | None                                  |
| **Staging, once integrated**   | Turn off the per-org flag. Generations keep working, since they don't use this path                                                        | Test renders only                     |
| **Production, once approved**  | Flag off immediately, and let in-flight jobs finish or expire. Release reserved credits through the existing path. Stop the worker service | Rendered videos stay as normal assets |
| **Schema, if any**             | Forward-only and additive, reviewed separately. A rollback leaves unused columns                                                           | None to customers                     |

**Kling isn't touched by any of these.** Its own rollback is in
[kling-migration-assessment.md](kling-migration-assessment.md).

## Voice PRs

Reconciled in [voice-pr-reconciliation.md](voice-pr-reconciliation.md). #401's code stays reference only.

## Decisions for the owner

1. Whether to authorize the security fixes (findings 1 and 3, and LOW items) as the pilot's next step.
2. Whether to approve adding the CI workflow, which changes workflow policy.
3. Whether to send the Fish questions and the legal questions.
4. **Whether templates are worth pursuing at all.** Everything else depends on it, and it's a product
   question, not a technical one.
