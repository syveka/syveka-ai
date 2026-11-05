# Test failures on Windows, and the disk-space problem

Investigated 2026-11-05 on `origin/main` at `40f71ae7`, on the owner's Windows 11 laptop (12 logical
CPUs, 16 GB RAM, Node 22).

## Result

| Run                        | Before                      | After this branch                   |
| -------------------------- | --------------------------- | ----------------------------------- |
| Full unit suite on Windows | 12–14 failures in every run | **0 failures of 4,956, 54 skipped** |
| CI on Linux (#395)         | All checks passed           | Pending on this PR                  |

No assertion was removed or relaxed, and one was added. Production code isn't touched.

## Causes

| Test file                         | Failures seen           | Root cause                                                                                               | Evidence                                                                            |
| --------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `security/handler-guard-coverage` | 11 in every Windows run | `path.relative` gives backslashes on Windows, while the test's declarations use forward slashes          | Same 11 on clean `40f71ae`. All pass after normalizing. CI on Linux wasn't affected |
| `recovery-drill-scripts`          | 1 in every full run     | Took 14–19 s against the 5 s default. `spawnSync` blocks the runner, so it finishes, then counts as late | Passes alone. Reported durations                                                    |
| `staging-deploy-only-workflow`    | 1, intermittent         | Repeated `spawnSync` of bash, over 5 s under load                                                        | 5,084 ms when it failed. Passes alone                                               |
| `voice-conversation-flow`         | 2 in 1 of 7 full runs   | See below                                                                                                | Reproduced under CPU load                                                           |

Starting bash is slow on Windows, which explains why only Windows runs hit the two script timeouts. The
exact share from antivirus scanning or Git Bash wasn't measured.

## The voice-conversation-flow failures

The concern was that one failing test is "a replayed grant cannot create another generation", a
security property. **The evidence points to a test isolation bug, not a replay bug, though one detail is
inferred rather than directly observed.**

The chain:

1. The chat route imports its modules on the first request. On a busy machine that exceeds Vitest's
   5 s default, so the file's first test times out.
2. A timed-out test keeps running in the background. Vitest doesn't cancel it.
3. It then corrupts later tests through state they share, including `inFlight`.

| Evidence                                                                                                                                                           | What it shows                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| Under CPU load, only the first tests of the file time out, at 5.0–5.5 s                                                                                            | Slow first load, not a fault in a particular test |
| Later tests fail with `expected 9 to be 8` and `expected 7 to be 6` on `maxInFlight`, in 120–310 ms. Over-counts of 1 or 2 match the number of tests still running | Timed-out tests do pollute later ones             |
| The file's own comment warns that simultaneous imports of a mocked module can resolve to the real one                                                              | A known hazard here                               |
| 12 of 14 unfixed runs failed at 30 CPU burners. After the fix, 7 of 7 completed runs passed at the same load, with an eighth cut off by my time limit              | Removing the timeout removes all the failures     |
| One unfixed run showed `expected 200 to be 409` on the replay test, after 4,913 ms                                                                                 | Same pattern as the others                        |

**What wasn't directly observed:** I instrumented that test to capture the first call's status, and the
exact `200 vs 409` failure didn't recur in the 28 instrumented runs. So the explanation for that one line
(the first call failed because of the overlap, and the "replay" was really the first successful use) is
inferred. That test now asserts the first call returned 200, so if it happens again, the failure says so
directly.

**What protects replay in production:** a single-use grant consumed by an atomic Redis script. These
tests use an in-memory emulator, and `tests/integration/voice-conversation-redis.test.ts` runs the real
script. It's opt-in and wasn't run here (`VOICE_REDIS_TEST_URL`). **Whoever reviews this should check that
CI runs it**, or run it against a disposable Redis.

## What changed

| File                              | Change                                                | Why this isn't weakening                                             |
| --------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| `security/handler-guard-coverage` | Normalizes path separators                            | Every route and action is still checked. Linux results are unchanged |
| `voice-conversation-flow`         | 60 s timeout, and asserts the first call returned 200 | Every assertion stays, and one is added. A real hang still fails     |
| `recovery-drill-scripts`          | 60 s for that test                                    | Same assertions                                                      |
| `staging-deploy-only-workflow`    | 60 s for the file                                     | Same assertions                                                      |

Other files could hit the 5 s default under enough load. I didn't raise the global default, because
per-file changes keep the slower limit where it's explained.

## Disk space

The disk is 238 GB and free space has swung between 0 and 3.6 GB during this session. **Nothing was
deleted except this session's own temporary build output and one temporary worktree.**

| Use                             | Size             | Notes                                                                        |
| ------------------------------- | ---------------- | ---------------------------------------------------------------------------- |
| Docker (`AppData/Local/Docker`) | 34 GB            | Includes WSL disk data. Check `docker system df` before pruning              |
| `C:/pagefile.sys`               | 24–25 GB         | **Grows on its own**: see below                                              |
| Desktop                         | 28 GB            | Includes `syveka copy` at 13 GB, and several other checkouts of 1–2.5 GB     |
| Downloads                       | 20 GB            | Not inspected                                                                |
| Windows                         | 18 GB            | System                                                                       |
| npm cache                       | 6.5 GB           | Safe to clear with `npm cache clean --force`, at the cost of slower installs |
| `hiberfil.sys`                  | 6 GB             | Removed only if hibernation is turned off                                    |
| `AppData/Local/Temp`            | 6 GB             | Includes 4.5 GB of Claude session scratch                                    |
| Git worktrees for this repo     | 169, 40 prunable | `git worktree prune` removes only records of folders already gone            |

These add up to about 145 GB. About 90 GB is elsewhere and wasn't traced.

**Why free space swings:** Windows manages the pagefile automatically. It grew from 23,432 MB to 25,497 MB
during this session, while free virtual memory was down to about 750 MB, so about 2 GB of the swing is
pagefile. The largest memory users at the time were WSL (5.7 GB committed), Chrome (5.4 GB), VS Code
(2.9 GB), Claude Code (2.7 GB) and Node (2.1 GB).

**A build crash, probably from the same cause:** the first production build ended with a native abort
(`2147483651`), and a retry failed with `ENOSPC`. A later build passed with 3.2 GB free. I didn't capture
the crash's own message, so the link to memory or disk is likely but unproven.

### Suggested owner actions, none of them done

1. **Docker first:** check what it holds. It's the largest single item.
2. Review `Downloads` and `syveka copy`.
3. Run `git worktree prune`, and review old worktrees. Each one with `node_modules` costs about 1.6 GB.
4. Clear the npm cache, if slower installs are acceptable.
5. Close WSL and Docker during builds, or set a fixed pagefile size so it can't fill the disk at bad times.

## Open

- Run the opt-in real-Redis suite against a disposable instance.
- This session's own worktrees are kept until the owner confirms that preserved work is safe.
