# Strix security testing runbook

Strix (https://github.com/usestrix/strix, Apache-2.0) is an open-source AI penetration-testing
agent. It reads source code and/or attacks a running target from inside a Docker sandbox, and
reports only findings it could validate with a proof of concept. This runbook records what was
installed for Syveka, how it was verified, what is still missing, and the rules under which a
first assessment may be run later.

Installing the integration does not make Syveka secure, and installing the skills alone does not
make the scanner operational. Nothing in this document is a claim about Syveka's security posture.
Every Strix finding must be reproduced and validated by a human before it is treated as real, and
a clean run proves only that nothing exploitable was found within the budget and scope given.

## 1. What was installed and where

### 1.1 Claude Code skills (committed, project scope)

Five of the nine official skills from `usestrix/strix` `skills/` are installed as project-scoped
Claude Code skills. They are development tooling only: they are not imported by application code,
not listed in `package.json`, and never shipped to any runtime.

| Skill                                     | Path                                                      | Covers                                                       |
| ----------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------ |
| `penetration-testing-with-strix`          | `.claude/skills/penetration-testing-with-strix/`          | Running an assessment; install, flags, exit codes, artifacts |
| `find-security-vulnerabilities-in-code`   | `.claude/skills/find-security-vulnerabilities-in-code/`   | White-box source review                                      |
| `fix-security-vulnerabilities-with-strix` | `.claude/skills/fix-security-vulnerabilities-with-strix/` | Triage, root-cause fixes, re-scan verification               |
| `web-app-penetration-testing`             | `.claude/skills/web-app-penetration-testing/`             | Dynamic testing of a deployed web application                |
| `api-security-testing`                    | `.claude/skills/api-security-testing/`                    | REST/GraphQL API testing, BOLA/IDOR, function-level authz    |

Not installed, deliberately: `application-security-testing` and `owasp-top-10-testing` (overlap
with the five above), `ci-security-scanning-with-strix` (automatic CI scanning is not enabled, see
§8), and `managed-pentesting-with-strix` (a managed app.strix.ai account is not authorized).

Installation record:

- Installer: `npx skills@1.7.4 add usestrix/strix -a claude-code -s <five names> -y --copy`
  (the `skills` CLI by `vercel-labs/skills`, MIT, published from GitHub Actions via npm trusted
  publishing). `--copy` writes real files instead of symlinks, which is what this repository
  commits. Telemetry was disabled for the install with `DO_NOT_TRACK=1`.
- Upstream source: `usestrix/strix` branch `main`, commit
  `a3c31236bd6305784a501a3102dab0bda83f2317` (2026-10-21T15:30:08Z, GPG-verified commit). Each
  installed `SKILL.md` was compared with the file at that commit and matched byte for byte after
  LF normalization. `skills-lock.json` records the source, skill path and the SHA-256 of that
  upstream content (`computedHash`).
- The committed files were then formatted with the repository's Prettier config so that
  `npm run format:check` passes. The only differences from upstream are Markdown table padding,
  `*emphasis*` rewritten as `_emphasis_`, and blank lines around list items. After any
  `npx skills update`, run `npm run format` again before committing.
- The skills are plain Markdown instructions. They register no hooks, no MCP servers and no
  scripts. Review: `docs/skills/SECURITY_REVIEW.md` §"Review: Strix"; registry:
  `docs/skills/SKILLS_REGISTRY.md` §"Strix".

### 1.2 Strix CLI (local developer machine, not committed)

| Item               | Value                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package            | `strix-agent` 1.7.0 from PyPI (released 2026-10-05; GitHub release `v1.7.0`, tag commit `55bc07991aacb1c26a81b43e7ca53148730d2019`, unsigned)                                                                                                                                                                                                                                                              |
| Install command    | `uv tool install --python 3.12 "strix-agent==1.7.0"` (uv 0.11.32; strix-agent requires Python 3.12 or newer)                                                                                                                                                                                                                                                                                               |
| Isolation          | Dedicated uv tool environment at `%APPDATA%\uv\tools\strix-agent`; executable at `%USERPROFILE%\.local\bin\strix.exe`. No change to global Claude configuration, shell profiles, or the application's dependencies.                                                                                                                                                                                        |
| Why not the script | The documented `curl -sSL https://strix.ai/install \| bash` was downloaded and read, not executed. It fetches a prebuilt binary from GitHub Releases, writes to `~/.strix/bin`, appends to shell rc files, and pulls the sandbox image. The uv route is listed by the project as a supported package-manager install (`strix --update` prints `uv tool upgrade strix-agent`) and avoids the rc-file edits. |
| Sandbox image      | `ghcr.io/usestrix/strix-sandbox:1.3.0`, the default of `STRIX_IMAGE` in `strix/config/settings.py` at v1.7.0. About 1.4 GB compressed for linux/amd64.                                                                                                                                                                                                                                                     |

Verification performed (no scan was started):

- `strix --version` printed `strix 1.7.0`.
- `strix --help` listed the flags used in this runbook (`-t`, `--target-list`, `--instruction`,
  `--instruction-file`, `--workspace-file`, `-n`, `--fail-on`, `-m/--scan-mode`, `--scope-mode`,
  `--diff-base`, `--config`, `--max-budget`, `--max-turns`, `--resume`).
- From the tool environment, the Python Docker SDK reached the local daemon
  (`docker.from_env().ping()` returned `True`; engine 29.7.2, linux/amd64). Existing containers
  were not touched.
- `docker pull ghcr.io/usestrix/strix-sandbox:1.3.0` was run so that the first scan does not
  have to download it. It completed (image id `f6906c3114e5`, 5.9 GB on disk); the 11 containers that were running before were not touched.

Official references used (checked 2026-10-21):

- README: https://github.com/usestrix/strix/blob/main/README.md (skills install command, env vars)
- CLI reference: https://docs.strix.ai/usage/cli (flags, `--max-budget` semantics, exit codes)
- Configuration: https://github.com/usestrix/strix/blob/main/docs/advanced/configuration.mdx
  (all environment variables, telemetry, sandbox settings)
- LLM providers: https://docs.strix.ai/llm-providers/overview
- GitHub Actions: https://docs.strix.ai/integrations/github-actions
- Telemetry: https://github.com/usestrix/strix/blob/main/strix/telemetry/README.md
- Skills CLI: https://github.com/vercel-labs/skills/blob/main/docs/commands.md

## 2. Prerequisites and their status

| Prerequisite                                 | Status on the setup machine (2026-10-21)                                                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Docker engine running                        | Ready (Docker 29.7.2, Linux containers)                                                                                             |
| Strix CLI                                    | Ready (`strix 1.7.0`)                                                                                                               |
| Sandbox image pulled                         | Ready on the setup machine (image id `f6906c3114e5`, 5.9 GB on disk). Elsewhere: `docker pull ghcr.io/usestrix/strix-sandbox:1.3.0` |
| LLM provider key for Strix                   | **Missing by design.** Not provisioned; see §5                                                                                      |
| Isolated test target with synthetic data     | **Missing.** Nothing has been verified as safe to attack; see §4                                                                    |
| Written authorization for a first assessment | **Missing.** Required before any run; see §6                                                                                        |

On another machine, repeat §1.2: install uv (or pipx), run the `uv tool install` command, confirm
`strix --version`, confirm `docker info`, pull the image.

## 3. Update and removal

Skills:

```bash
npx skills@1.7.4 check                                # report upstream changes
npx skills@1.7.4 update                               # refresh from usestrix/strix main
npm run format                                        # re-apply Prettier before committing
npx skills@1.7.4 remove <skill-name> -a claude-code   # remove one skill
```

Any update changes the reviewed content: update the version/commit and "Last reviewed" fields in
`docs/skills/SKILLS_REGISTRY.md` and re-check the review conditions in
`docs/skills/SECURITY_REVIEW.md` in the same PR.

CLI and image (per machine):

```bash
uv tool upgrade strix-agent        # or: uv tool install --python 3.12 "strix-agent==<version>"
uv tool uninstall strix-agent
docker rmi ghcr.io/usestrix/strix-sandbox:1.3.0
```

Strix writes its own state to `~/.strix/` (`cli-config.json`, `mcp-servers.json` when used) and
scan output to `./strix_runs/` in the directory where it is run. Both are outside the application
and `strix_runs/` is gitignored. Delete them to remove all traces.

## 4. Scan scope rules

These rules apply to every Strix run against anything Syveka-related. They are not optional and
they are not enforced by Strix: the operator enforces them.

### 4.1 Explicit target allowlist

- Every run uses `--target-list security/strix/targets.local.txt` (gitignored; copy from
  `security/strix/targets.example.txt`) or an explicit `-t` that appears in that file. The file
  is the allowlist. Nothing outside it is in scope, including hostnames the agents discover.
- Permanently excluded: production URLs (any `syveka.*` production host), the production Supabase
  project, production databases and connection strings, real customer or pilot data, production
  credentials, and every third-party service (Stripe, Resend, Vapi, Anthropic, OpenAI, Upstash,
  QStash, Google/Microsoft calendar, Meta, fal, Sentry, Langfuse). Those are other people's
  systems and other people's data.
- The staging environment (`https://syveka-ai-staging.vercel.app`, its own Supabase project) is
  **not** pre-approved. It is used by the release and invitation-journey workflows, shares an
  auth rate limit with them, and its data and integration keys have not been audited for this
  purpose. Before it can appear in the allowlist, complete the checklist in §4.3 for it.

### 4.2 Integrations: mocks or test modes only

The target deployment used for a dynamic scan must be configured so that an attack cannot cause a
real side effect. Syveka's per-integration env validation (`src/env.ts`) makes this a matter of
which variables are set on that deployment:

| Integration                 | Requirement for a scan target                                                                                                                                     |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stripe (payments, webhooks) | Test-mode keys only (`sk_test_`/`pk_test_` prefixes, a test-mode webhook secret); no live price ids                                                               |
| Resend (outbound email)     | A key from a dedicated sandbox account with no verified sending domain, or leave `RESEND_API_KEY` unset so the integration fails closed; never the production key |
| Inbound email               | `INBOX_EMAIL_MOCK_PROVIDER=1`                                                                                                                                     |
| Calendar providers          | `CALENDAR_MOCK_PROVIDER=1`; no Google/Microsoft client secrets                                                                                                    |
| Vapi (voice calls)          | `VAPI_API_KEY` unset. A scan must not be able to place or receive calls                                                                                           |
| Anthropic / OpenAI (app AI) | Dedicated keys with a provider-side spend limit, never the production keys; or unset for a code-only scan                                                         |
| fal, Meta (Creator Studio)  | Unset (the code falls back to mock providers)                                                                                                                     |
| QStash / Upstash            | A separate test project; jobs must not reach production queues                                                                                                    |
| Sentry / Langfuse           | Unset, or a separate project labelled for security testing                                                                                                        |

Record the exact configuration of the target in `security/strix/instruction.local.md` before the
run so the authorization in §6 refers to a known state.

### 4.3 Verifying a candidate target before it enters the allowlist

1. It is a separate deployment with its own Supabase project and database. The project ref is not
   the production ref (the release workflows already refuse when the two are equal; apply the same
   check by hand).
2. The database contains only synthetic organizations, users, contacts, documents and
   conversations created for testing. Check row counts and e-mail domains; if any real customer or
   pilot record is present, the target is rejected until it is reseeded.
3. Every integration variable matches §4.2. Verify by prefix or presence without printing secret
   values.
4. No other automated workflow (staging release, invitation journeys, E2E) will run against it
   during the scan window.
5. Someone is able to reset the target afterwards: Strix agents create, modify and delete data,
   and a local path passed with `-t` is mounted writable into the sandbox.

### 4.4 Assessment goals

The order below is the priority for instructions given to Strix and for triage. These are goals
for the assessment, not statements about what Strix will cover.

1. Cross-tenant data access and authorization (`tenantDb()` discipline, `unscopedPrisma` call
   sites, `organizationId` derivation from the server-verified session).
2. Authentication, roles and admin boundaries (`src/server/auth/permissions.ts`, `OWNER`..`VIEWER`,
   invitation and membership flows).
3. Supabase RLS and server-side database access (RLS protects only the Supabase-native client
   paths; the Prisma connection bypasses it).
4. API authorization including IDOR/BOLA across `src/app/api/v1/**`, API-key scopes, public
   booking and public-assistant routes.
5. AI tool execution and required-confirmation enforcement (`src/server/ai/tools/`).
6. Prompt injection through documents, inbox e-mail, voice transcripts or chat that could bypass
   tool permissions or expose another tenant's data.
7. Webhook authentication, signatures and replay handling (`src/app/api/v1/webhooks/**`,
   `src/app/api/v1/voice/webhook`).
8. Secret exposure, SSRF, injection and unsafe uploads (file/URL ingestion, upload-url routes).

## 5. Credentials, cost and data handling

### 5.1 Environment variables (names verified against the official configuration reference)

Set these in the operator's shell for the duration of a run, or in `~/.strix/cli-config.json`
(outside the repository). Never add them to `.env*` files of the application and never commit
them.

```bash
# Required
STRIX_LLM="anthropic/claude-sonnet-4-6"   # LiteLLM model id; see docs.strix.ai/llm-providers/overview
LLM_API_KEY="<dedicated key with a provider-side spend limit>"

# Recommended
STRIX_TELEMETRY=0                                    # disables PostHog + Scarf + remote OTEL export
STRIX_IMAGE="ghcr.io/usestrix/strix-sandbox:1.3.0"   # pin the sandbox image explicitly

# Optional
LLM_API_BASE="<gateway url>"               # only for a self-hosted or proxied model endpoint
STRIX_REASONING_EFFORT="high"              # default
LLM_TIMEOUT=300                            # seconds, default
STRIX_SANDBOX_EXECUTION_TIMEOUT=120        # seconds, default
POSTMAN_API_KEY=...                        # only for postman:// targets (not used by Syveka)
PERPLEXITY_API_KEY / EXA_API_KEY           # optional web search for the agents; leave unset
```

Use a key created for this purpose with its own spend limit at the provider. Do not reuse the
application's `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Strix also accepts `OPENAI_API_KEY` as a
fallback for `LLM_API_KEY`, so make sure the application's key is not exported in the shell that
runs Strix.

### 5.2 What leaves the machine

- To the model provider named in `STRIX_LLM`: the contents of every file the agents read from a
  code target, every HTTP request and response the agents exchange with a dynamic target
  (including any data in it), the text of `--instruction`/`--instruction-file` (so any test
  credentials in it), and the agents' own reasoning. This is why only synthetic data and
  throwaway test credentials may ever be in scope.
- To ghcr.io: the sandbox image pull.
- To PostHog (`us.i.posthog.com`) and Scarf (`strix.gateway.scarf.sh`): usage telemetry unless
  `STRIX_TELEMETRY=0`.
- To Perplexity/Exa: only if those keys are set (they are not).
- To app.strix.ai: nothing, unless `strix cloud ...` commands are used. They are not authorized.

Locally, `strix_runs/<run>/` holds the report, per-finding PoCs, `vulnerabilities.json/.csv`,
`findings.sarif`, `run.json` (status, cost) and `events.jsonl` (run telemetry). Findings are
sensitive: keep the directory out of git (it is gitignored), out of chat tools, and share only
through the private channel agreed in §6.

### 5.3 Budget controls

- `--max-budget <USD>` is mandatory on every run. In headless mode (`-n`) it is a hard stop:
  the run ends with status `stopped` and the sandbox is torn down. Sub-agents are stopped at 90 %
  to leave room for the report. The cost is a best-effort estimate from token usage and pricing;
  it is checked after each model response, so it can overshoot slightly, and providers that do not
  return priced usage can be under-counted. Strix cannot enforce a provider-side limit; set one at
  the provider as well.
- `--max-turns <N>` caps turns per agent (default 500) and is a second brake.
- `-m quick` or `-m standard` for routine runs; `deep` (the default) can run for hours and must be
  budgeted explicitly.
- A run that hit the budget may still exit `0`. Always read `run.json` (`status`, cost) before
  interpreting a clean exit as coverage.

## 6. Authorizing and running a first narrowly scoped assessment

Nothing below has been run. This task authorized installation and preparation only.

### 6.1 Phase 1: source-code assessment (no live target)

1. Obtain explicit written authorization from the repository owner naming: the commit to scan,
   the paths in scope, the budget cap, the model, and who receives the findings.
2. Create a clean, disposable checkout of that commit outside any working tree (the sandbox mounts
   the path writable), for example `git worktree add <tmp-path> <commit>` or a fresh clone.
3. Export the variables from §5.1 in the shell. Confirm `docker info` and `strix --version`.
4. Write `security/strix/instruction.local.md` from the example: tenancy model, trust boundaries,
   attacker-controlled inputs, the priority list from §4.4, and the exclusions.
5. Run, from the clean checkout:

   ```bash
   strix -n -t . -m standard --scope-mode full \
     --instruction-file <repo>/security/strix/instruction.local.md \
     --max-budget 15 --max-turns 300 --fail-on medium
   ```

   For a change-only review of a branch, replace `--scope-mode full` with
   `--scope-mode diff --diff-base origin/main` and lower the budget.

6. Exit codes: `0` nothing validated at or above `--fail-on` within scope, `1` fatal error
   (missing variables, Docker down, diff resolution failure), `2` validated findings.
7. Copy `strix_runs/<run>/` to the private location agreed in step 1 and delete the disposable
   checkout.

### 6.2 Phase 2: isolated dynamic assessment (later)

Only after §4.3 is complete for a target and a second written authorization names that target:

1. Prepare test accounts in the target: organization A with an `OWNER` and a `MEMBER`,
   organization B with an `OWNER`, one user who belongs to no organization, and one API key per
   organization with minimal scopes. Record them in `security/strix/instruction.local.md`
   (gitignored), never in `--instruction` on the command line (shell history).
2. List the target base URL in `security/strix/targets.local.txt`. Add the clean code checkout as
   a second target for grey-box depth if the authorization covers it.
3. Run:

   ```bash
   strix -n --target-list <repo>/security/strix/targets.local.txt -t <clean-checkout> \
     -m standard --instruction-file <repo>/security/strix/instruction.local.md \
     --max-budget 20 --max-turns 300 --fail-on medium
   ```

4. Reset the target's data afterwards and rotate every test credential used.

## 7. Triage, fix, retest

1. Read `penetration_test_report.md`, then each `vulnerabilities/*.md`, ordered critical to low.
2. Reproduce the proof of concept by hand against the same target. A finding that cannot be
   reproduced is recorded as unconfirmed, not as a false positive, until someone explains why.
3. File each confirmed finding privately (restricted issue or the agreed channel). Do not paste
   PoCs or data samples into public issues, PR descriptions or chat.
4. Fix the root cause following `CLAUDE.md` §2: a dedicated branch, the smallest correct change,
   a focused unit test that fails before and passes after, the full validation suite, a PR, and
   human authorization before merge. Prefer the shared mechanism (`tenantDb()`,
   `requirePermission()`, the shared rate limiter, the central validators) over a route-local
   patch.
5. Retest with a focused run from a clean checkout of the fix branch:

   ```bash
   strix -n -t . -m quick --scope-mode diff --diff-base origin/main \
     --instruction "Re-test finding <id>: <one-line description>. Confirm the exploit no longer works." \
     --max-budget 5
   ```

   Exit `2` means the finding (or a new one) is still present; `0` means nothing validated in the
   analyzed scope. Check `run.json` to make sure the run completed and was not cut off by the
   budget. Repeat the manual PoC as well.

6. Record the finding, the fix PR and the retest result in `docs/SECURITY-AUDIT.md`.

## 8. Proposed manual CI workflow (not added)

No workflow file is added in this change. Workflow files are protected configuration under
`CLAUDE.md` §9 (CI policy change) and require their own explicit authorization, and the two
repository secrets it needs do not exist yet. Automatic scanning on `push`, `pull_request` or a
schedule is explicitly not proposed: it would expose a paid model key to every PR and run attacks
without an operator. The proposal below is `workflow_dispatch` only, code-scope only, and sized
for the GitHub-hosted Ubuntu runner, which has Docker available.

Dependencies before it can be added: (1) authorization for a CI policy change, (2) a GitHub
Environment named `security-scan` with required reviewers, holding `STRIX_LLM` and
`LLM_API_KEY` as environment secrets, (3) a decision on where findings are stored (the artifact
below is visible to anyone with read access to the repository's Actions).

```yaml
name: Strix source assessment (manual)

# Manual, operator-approved, code-only Strix run. Never on push/pull_request/schedule.
on:
  workflow_dispatch:
    inputs:
      confirm:
        description: "Type SCAN-SOURCE to confirm a budgeted, code-only run"
        required: true
        type: string
      max_budget_usd:
        description: "Hard LLM spend cap in USD"
        required: true
        default: "10"
        type: string
      scan_mode:
        description: "quick | standard"
        required: true
        default: "quick"
        type: choice
        options: [quick, standard]

permissions:
  contents: read

concurrency:
  group: strix-source-assessment
  cancel-in-progress: false

jobs:
  strix:
    name: Strix code assessment
    runs-on: ubuntu-latest
    environment: security-scan # required reviewers approve every run
    timeout-minutes: 60
    steps:
      - name: Validate inputs
        shell: bash
        run: |
          set -euo pipefail
          [ "$CONFIRM" = "SCAN-SOURCE" ] || { echo "confirmation missing"; exit 1; }
          [[ "$BUDGET" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "budget must be numeric"; exit 1; }
        env:
          CONFIRM: ${{ inputs.confirm }}
          BUDGET: ${{ inputs.max_budget_usd }}

      - name: Checkout
        uses: actions/checkout@v4
        with:
          fetch-depth: 0
          persist-credentials: false

      - name: Install Strix (pinned)
        run: pipx install "strix-agent==1.7.0" && strix --version

      - name: Pull sandbox image (pinned)
        run: docker pull ghcr.io/usestrix/strix-sandbox:1.3.0

      - name: Run code-only assessment
        id: scan
        shell: bash
        run: |
          set -uo pipefail
          strix -n -t ./ -m "$SCAN_MODE" --scope-mode full \
            --instruction-file security/strix/instruction.ci.md \
            --max-budget "$BUDGET" --max-turns 300 --fail-on medium
          echo "exit_code=$?" >> "$GITHUB_OUTPUT"
        env:
          STRIX_LLM: ${{ secrets.STRIX_LLM }}
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
          STRIX_TELEMETRY: "0"
          STRIX_IMAGE: ghcr.io/usestrix/strix-sandbox:1.3.0
          SCAN_MODE: ${{ inputs.scan_mode }}
          BUDGET: ${{ inputs.max_budget_usd }}

      - name: Require a completed run (budget stop is not coverage)
        shell: bash
        run: |
          set -euo pipefail
          run_json=$(ls -t strix_runs/*/run.json | head -n1)
          status=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$run_json")
          echo "run status: $status"
          [ "$status" = "completed" ] || { echo "run did not complete"; exit 1; }

      - name: Upload findings (restricted retention)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: strix-run
          path: strix_runs/
          retention-days: 7
          if-no-files-found: ignore

      - name: Fail on validated findings
        if: steps.scan.outputs.exit_code == '2'
        run: |
          echo "Strix reported validated findings at or above the threshold. See the artifact."
          exit 1
```

Notes on the proposal: `security/strix/instruction.ci.md` would be a committed, credential-free
instruction file; the SARIF upload to code scanning (`findings.sarif`, needs
`security-events: write`) is left out until the visibility question in dependency (3) is
settled; and the install step pins the same version reviewed here.

## 9. Limitations

- Strix is an AI agent. Coverage is non-deterministic, bounded by budget and turns, and shaped by
  the instructions given. Two runs on the same commit can differ.
- It does not replace the existing gates: the `gitleaks` secret scan and
  `production-dependency-audit` in `ci.yml`, the RLS SQL tests, the unit and E2E suites, and
  human review remain in place and are not weakened by this integration.
- Findings are produced by an LLM reading code and responses; they can be wrong in both
  directions. Validation by a human is part of the process, not an optional step.
- The CLI is pinned to 1.7.0 and the sandbox image to 1.3.0. Newer versions require re-review
  (§3).
- Windows is a supported host for the CLI, but the sandbox is a Linux container; a local dev
  server on the host is reached from the sandbox as `http://host.docker.internal:<port>`.
