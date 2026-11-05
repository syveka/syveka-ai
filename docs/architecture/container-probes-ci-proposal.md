# Proposal: container security probes in CI

For the owner and engineers. **A proposal only. Nothing here is added to `.github/`,** since a workflow
change needs owner approval. It adds a check; it removes or relaxes none.

## The gap

The worker's unit tests run in CI today, but they can't prove what the kernel enforces. Network isolation,
the read-only filesystem, deleted CLI commands and malicious-media handling are proved only by
`scripts/container-probes.mjs`, which has been run by hand. A later change could silently break isolation
with all CI green.

## Proposed workflow

A separate workflow file, `.github/workflows/render-worker-probes.yml`:

```yaml
name: Render worker probes
on:
  pull_request:
    paths:
      - "experiments/hyperframes-render-worker/**"
      - "tests/unit/hyperframes-render-worker.test.ts"
permissions:
  contents: read
concurrency:
  group: render-worker-probes-${{ github.ref }}
  cancel-in-progress: true
jobs:
  probes:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    steps:
      - uses: actions/checkout@<pinned SHA>
        with:
          persist-credentials: false
      - uses: actions/setup-node@<pinned SHA>
        with:
          node-version: "22"
      - name: Stop crash dumps reaching the runner's handler
        run: echo '/dev/null' | sudo tee /proc/sys/kernel/core_pattern
      - name: Build the image
        working-directory: experiments/hyperframes-render-worker
        run: docker build --provenance=false -t syveka-hyperframes-render-worker:dev .
      - name: Security probes
        working-directory: experiments/hyperframes-render-worker
        env:
          RENDER_JOBS_ROOT: ${{ runner.temp }}/render-jobs
        run: |
          mkdir -p "$RENDER_JOBS_ROOT/probe-in"
          node scripts/run-probes.mjs "$RENDER_JOBS_ROOT/probe-in" | tee "$RUNNER_TEMP/probes.jsonl"
          # Fails on any failed probe, and on a run that reported nothing.
          node -e "
            const lines = require('fs').readFileSync(process.env.RUNNER_TEMP + '/probes.jsonl', 'utf8')
              .trim().split('\n').map(JSON.parse);
            const summary = lines.at(-1);
            if (!summary.summary || summary.failures !== 0 || lines.length < 50) process.exit(1);
          "
```

A second job could render one real video for `hostVerified: true`, at the cost of a few more minutes.

## Requirements and limits

| Item           | Requirement                                                                                                                                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runner         | A GitHub-hosted, ephemeral Linux runner with Docker. **Never a self-hosted or shared runner:** the job builds and runs hostile-media handling                        |
| CPU and memory | The container asks for 4 CPUs and 3 GB. Standard hosted runners vary by plan, so check the current size. Probes need well under that; a render needs about 3.5 CPUs  |
| Disk           | About 1.5 GB for the image. Hosted runners have room; **it must not run on a developer machine with a nearly full drive**                                            |
| Duration       | Estimated 10–15 minutes uncached: the build took about 9 minutes on the pilot laptop, and probes under a minute. Layer caching could help, but adds a cache to trust |
| Network        | Needed for `docker build` to fetch pinned artefacts. **None at probe time**, enforced by `--network=none`, which is itself a probe                                   |
| Secrets        | None. It references no secrets or environments                                                                                                                       |
| Crash dumps    | The ephemeral runner's `core_pattern` is neutralized first. Changing a machine-wide kernel setting is exactly why it must stay on ephemeral runners                  |

## Safety

- `pull_request`, never `pull_request_target`, so a fork's code never runs with repo privileges.
- `contents: read` only, and `persist-credentials: false`.
- Pin all actions to commit SHAs. The base image, FFmpeg and Chrome are already pinned.
- `paths` limits it to this experiment, so it costs other PRs nothing.
- Nothing is published: no image push, and no deploy step.

## Rollout, without weakening anything

1. Add it as **non-required**, watch several runs, and measure real duration and flakiness.
2. Add a job-level `if` or keep the path filter so the experiment doesn't slow unrelated PRs.
3. Only make it a required check when the worker moves toward integration. **A path-filtered workflow
   can't simply be required,** because skipped runs don't report, so it would need the pattern `ci.yml`
   already uses through `CI required`. That is a separate branch-protection change for the owner.

The existing `CI required` gate, and all other checks, stay exactly as they are.

## Worth adding to the probes first

The security review noted that these are self-tests of the configuration. Before relying on them:

- Attempt `memfd_create` execution and `ptrace` of another process, and record the outcome.
- Run a hostile-stream test: a tiny test image that emits forged `FILE` and `RESULT` lines through the
  real `run-worker.mjs`, proving the host reader end to end.
- Test the core-limit bypass on a disposable host, with dumps directed at a size-limited location.

## Limits of this proposal

It proves one image on one kernel, GitHub's. It says nothing about a production host, and it isn't a
penetration test. **The workflow text hasn't been run,** so expect small corrections on first use.

**Decision needed:** whether to approve adding it. It changes workflow policy, so it needs your explicit
approval, and it's most useful once the pilot continues past this stage.
