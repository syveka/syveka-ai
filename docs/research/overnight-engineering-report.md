# Overnight engineering report: render worker and Fish Audio

> **Superseded in part.** The owner's decisions of 2026-11-05 came after this report. See
> [creator-studio-merge-readiness.md](creator-studio-merge-readiness.md) for current state, and for how the
> later security review changed the render worker's status.

For the owner and engineers reviewing this work. Covers the session of 2026-11-05. Everything is on
draft branches: nothing was merged or deployed, and no production system, paid API or customer data
was touched.

## Incident: my testing took down Docker Desktop and destroyed a test database

**Read this first.** It affected things outside this task.

- **What happened.** Chrome crashed inside my render containers. On Docker Desktop with WSL 2, crash
  dumps go to a handler on the Windows host, which wrote 500–700 MB per crash to
  `%TEMP%\wsl-crashes`. C: was already 99% full, and it reached 0 MB. Docker Desktop stopped itself at
  about 02:06 local time.
- **What was lost.** The `syveka-scratch-pg` container. An earlier session (`921a799e`) had started it
  with `--rm`, so Docker removed it and its anonymous volume (about 62 MB) when the engine stopped.
  **Its contents can't be recovered.** It was a local disposable test database with a default password,
  but it had been running for three days and something may have relied on it.
- **Not recreated.** An empty database under the same name could quietly mislead whatever uses it, and
  a connection error is clearer. To recreate it, empty:
  `docker run -d --rm --name syveka-scratch-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:55432:5432 pgvector/pgvector:pg15`
- **What I did.** I deleted only the dumps that came from my image, moved my own scratch files to D:,
  and restarted Docker Desktop. All other containers, images and named volumes were intact in the
  listing afterward. `--ulimit=core=1` stopped the dumps from accidental crashes, and there were none after that. It isn't a full
  fix: a later review found that a process inside can lower its own limit, so a host needs its own policy.
- **Still open.** **C: fell as low as 0.3 GB and had about 1.5 GB free at the end,** less than the
  3.3 GB when I started. About 2 GB is Docker's disk growing during my first image build, which doesn't
  shrink without compaction. A further temporary swing of
  about 2 GB is probably the Windows pagefile, which #398 measured growing from 23,432 to 25,497 MB in
  the same period, though that link is unproven. **C: needs space freed by you.**

The lesson is in [the architecture document](../architecture/creator-studio-render-worker.md), on the
render-worker branch: a limit on a container doesn't bound what the host writes on its behalf.

## What was already there

Draft PR #395, from an earlier session, already held a Fish Audio evaluation and a pilot. I did not
rebuild or overwrite it. I re-checked its facts independently and added the gaps on a stacked branch.
`docs/research/video-skills-evaluation.md` was untracked; it is preserved unchanged here (SHA-256
`6b02fe74…`).

## Branches and pull requests

All three are drafts. `main` is unchanged at `40f71ae7`.

| Pull request | Branch                                 | Base                                | Contents                                                                                |
| ------------ | -------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------- |
| #400         | `experiment/hyperframes-render-worker` | `main`                              | The worker, templates, tests, architecture doc, pilot results                           |
| #401         | `experiment/fish-voice-pilot-gaps`     | `experiment/fish-audio-voice-pilot` | Usage tracking, typed caller turns, latency aggregates, evaluation addendum, comparison |
| #402         | `docs/video-voice-research`            | `main`                              | The preserved evaluation, cost analysis, this report                                    |

Local worktrees are on `D:\syveka-overnight`, because C: was too full. Git needed
`-c safe.directory=…` per command there, since exFAT records no file ownership. No global configuration
was changed.

## Verified facts

- **Video.** See `docs/research/hyperframes-pilot-results.md` on the render-worker branch.
- **Voice.** See `docs/research/fish-audio-evaluation.md` and
  `docs/architecture/voice-provider-comparison.md` on the voice branch.
- **Soniox isn't in the codebase,** although the mission listed it. Any plan assuming it is out of date.
- **fal marks Kling 2.1 Standard deprecated,** and it is Creator Studio's default. Not changed.

## Implemented changes

**Render worker (not connected to the product):** an isolated, pinned container; three templates in
FI/EN/AR at 9:16, 1:1 and 16:9; strict JSON validation; media validation and re-encoding; no writable
host mount, with a capped host-side output reader; timeouts, a host-enforced job deadline and structured
errors; a typed seam to Creator Studio's real types that nothing in `src/` imports.

**Voice pilot additions (development-only, gated as before):** typed caller turns, per-organization usage
with honest pricing, and latency percentiles that keep mock and real timings apart.

## Test results

**CI on Linux passed every check on #400,** including the full unit suite, production build and RLS
tests. Local full-suite runs on this Windows machine and exFAT drive failed in many files, and the
green CI shows that those were environmental for that branch.

**#401 gets no CI,** because `ci.yml` targets `main` and #401 targets #395's branch. Its full-suite
result is local only (25 failures in 10 files, none in the pilot's test file), and its production build
could not run on this drive. #398 finds and fixes test-side causes of such Windows failures on `main`, so
that result should be read alongside it. By owner decision #401 stays a draft, and #395 isn't merged.

| Check                                                       | Result                                       |
| ----------------------------------------------------------- | -------------------------------------------- |
| Render matrix (27), maximum job (12), stress (8), video (3) | All pass                                     |
| Container security probes                                   | 55 of 55 pass; run by hand                   |
| Focused worker unit tests                                   | 107 of 107 pass                              |
| `test:e2e`                                                  | Not run: needs credentials and a running app |
| Opt-in Postgres and Redis suites                            | Not run: needs disposable instances          |
| RLS tests                                                   | Not applicable: no schema or policy changes  |
| Fish against the real API                                   | **Not run: no key, and not authorized**      |
| Voice page in a browser                                     | **Not run: needs local Supabase and Redis**  |

Independent reviews ran from contexts that didn't write the code: one security and one correctness review
of the worker, one of the voice change. They found real problems, including a blocking one, and those
were fixed. Their reviews were of an earlier revision; the fixes themselves haven't had a second
independent review. **These are subagent reviews, not human approval.**

## Estimates

Cost figures are in `docs/research/voice-and-video-cost-analysis.md`, all estimates with stated
assumptions. In short: Fish TTS changes a call's cost by about 0–5%, Vapi's fee is 57% of a call, and a
template render costs about $0.002–$0.004 in compute against $0.42–$0.84 for a generated Kling clip.

## Assumptions

- A push may start Preview deployments on Vercel, as `docs/CLAUDE-ENGINEERING-SYSTEM.md` observes. You
  asked for draft PRs, so I pushed. The new code is unreachable: the worker isn't imported by `src/`,
  and the voice route answers 404 outside `next dev`.
- Staying on `hyperframes@0.8.225`, as the earlier evaluation tested, rather than the newer `0.9.13`.

## Blockers

| Blocked                                                              | Needs                                                                          |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Real Fish audio, latency and quality                                 | **Parked by owner decision: no paid evaluation**                               |
| Real speech recognition in the pilot                                 | A paid or approved provider                                                    |
| Real Kling footage in a template                                     | **Parked by owner decision: no paid calls for now**                            |
| GDPR clearance of Fish                                               | Written answers from Fish, if the owner sends `fish-audio-vendor-questions.md` |
| Legal questions (GSAP, FFmpeg GPL, fal terms, HyperFrames packaging) | Counsel                                                                        |
| Native-speaker quality review                                        | FI and AR reviewers                                                            |

## Remaining work

Each document lists its own. The largest: running on real Linux infrastructure, real footage, and deciding
whether templates deserve a product surface at all. A real +358 baseline call needs more than approval:
#399 lists owner signature, an internal Phase 0, counsel before Phase 1, and Twilio documents, and #397 covers
the AI notice obligations.

## Cleanup you can do

Nothing here is needed by a merged branch. When you've finished with the evidence:

- `docker rmi syveka-hyperframes-render-worker:dev`, `docker rmi node:22-bookworm-slim` (only if nothing
  else uses it) and `docker builder prune`. These free space inside Docker's disk, which only shrinks
  on C: after you compact it.
- `D:\syveka-overnight` holds the worktrees, node modules, renders and evidence. Remove the worktrees
  with `git worktree remove`, not by deleting folders.
