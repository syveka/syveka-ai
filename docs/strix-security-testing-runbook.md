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

Strix is an autonomous agent with shell and network tools. An instruction file, a target list and
Docker's defaults do **not** stop it from contacting a system that is reachable from its sandbox.
Isolation has to be built around it (§4.5) before the first run.

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
- The skills' own install and run examples (`curl | bash`, `-t ./`, `host.docker.internal`,
  credentials in `--instruction`) are superseded by this runbook. An agent following a skill in
  this repository must run Strix only through §6.

### 1.2 Strix CLI (local developer machine, not committed)

| Item               | Value                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package            | `strix-agent` 1.7.0 from PyPI (released 2026-10-05; GitHub release `v1.7.0`, tag commit `55bc07991aacb1c26a81b43e7ca53148730d2019`, unsigned)                                                                                                                                                                                                                                                              |
| Install command    | `uv tool install --python 3.12 "strix-agent==1.7.0"` (uv 0.11.32; strix-agent requires Python 3.12 or newer)                                                                                                                                                                                                                                                                                               |
| Isolation          | Dedicated uv tool environment at `%APPDATA%\uv\tools\strix-agent`; executable at `%USERPROFILE%\.local\bin\strix.exe`. No change to global Claude configuration, shell profiles, or the application's dependencies.                                                                                                                                                                                        |
| Why not the script | The documented `curl -sSL https://strix.ai/install \| bash` was downloaded and read, not executed. It fetches a prebuilt binary from GitHub Releases, writes to `~/.strix/bin`, appends to shell rc files, and pulls the sandbox image. The uv route is listed by the project as a supported package-manager install (`strix --update` prints `uv tool upgrade strix-agent`) and avoids the rc-file edits. |
| Sandbox image      | `ghcr.io/usestrix/strix-sandbox:1.3.0`, the default of `STRIX_IMAGE` in `strix/config/settings.py` at v1.7.0. About 1.4 GB compressed for linux/amd64.                                                                                                                                                                                                                                                     |

Verification performed (no scan was started, no model call was made):

- `strix --version` printed `strix 1.7.0`.
- `strix --help` listed the flags used in this runbook (`-t`, `--target-list`, `--instruction`,
  `--instruction-file`, `--workspace-file`, `-n`, `--fail-on`, `-m/--scan-mode`, `--scope-mode`,
  `--diff-base`, `--config`, `--max-budget`, `--max-turns`, `--resume`).
- From the tool environment, the Python Docker SDK reached the local daemon
  (`docker.from_env().ping()` returned `True`; engine 29.7.2, linux/amd64). Existing containers
  were not touched.
- `docker pull ghcr.io/usestrix/strix-sandbox:1.3.0` completed (image id `f6906c3114e5`, 5.9 GB
  on disk); the 11 containers that were running before were not touched.
- The installed package's runtime source (`strix/runtime/*.py`, `strix/interface/main.py`,
  `strix/report/state.py`) was read to establish the sandbox facts in §4.5 and the exit-code and
  `run.json` semantics in §8.

### 1.3 Deployment side effects of the integration branch

Pushing `chore/strix-security-integration` triggered Vercel's automatic Git integration. Evidence
collected read-only on 2026-10-22 (GitHub commit statuses and the Vercel bot payload on PR #356):

- Two **Preview** deployments were created for the branch head, one in each Vercel project
  (`syveka-ai-production` and `syveka-ai-staging`). Both carry Git-branch preview hostnames
  (`*-git-chore-strix-security-*.vercel.app`) and were reported by Vercel as previews.
- No deployment was started by hand. The production release workflow (`deploy.yml`,
  `workflow_dispatch` from `main` only) has not run since 2026-09-25 (run #23). `vercel.json`
  disables Git deployments for `main`; Preview deployments for other branches are not disabled.
- A Vercel project named `syveka-ai-production` receiving a Preview deployment is not a
  production release. Whether the production alias (`https://syveka.com`) changed cannot be
  verified from this environment (no Vercel API access; production was deliberately not probed),
  so no claim is made either way. An owner can confirm it in the Vercel dashboard.

Official references used (checked 2026-10-21):

- README: https://github.com/usestrix/strix/blob/main/README.md (skills install command, env vars)
- CLI reference: https://docs.strix.ai/usage/cli (flags, `--max-budget` semantics, exit codes)
- Configuration: https://github.com/usestrix/strix/blob/main/docs/advanced/configuration.mdx
  (documented environment variables, telemetry, sandbox settings)
- LLM providers: https://docs.strix.ai/llm-providers/overview
- GitHub Actions: https://docs.strix.ai/integrations/github-actions
- Telemetry: https://github.com/usestrix/strix/blob/main/strix/telemetry/README.md
- Skills CLI: https://github.com/vercel-labs/skills/blob/main/docs/commands.md
- Installed source, tag `v1.7.0`: `strix/runtime/docker_client.py`, `strix/runtime/session_manager.py`,
  `strix/runtime/docker_connection.py`, `strix/interface/main.py`, `strix/report/state.py`

## 2. Prerequisites and their status

| Prerequisite                                        | Status on the setup machine (2026-10-22)                                                                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker engine running                               | Ready (Docker Desktop 29.7.2, Linux containers)                                                                                                                                 |
| Strix CLI                                           | Ready (`strix 1.7.0`)                                                                                                                                                           |
| Sandbox image pulled                                | Ready (image id `f6906c3114e5`, 5.9 GB). Elsewhere: `docker pull ghcr.io/usestrix/strix-sandbox:1.3.0`                                                                          |
| LLM provider key for Strix                          | **Missing by design.** Not provisioned; see §5                                                                                                                                  |
| Verified provider-side hard spend limit on that key | **Missing.** Must be configured and verified at the provider before the key is used; see §5.3                                                                                   |
| Sanitized source snapshot                           | **Missing.** Created per run with `git archive`; see §6.1                                                                                                                       |
| Clean operator environment                          | **Missing.** `security/strix/preflight.sh` must pass; on the setup machine it fails today because the interactive shell carries unrelated tokens, so a fresh shell is required  |
| Restricted sandbox network                          | **BLOCKED on the setup machine.** Docker Desktop on Windows cannot reach container IPs on a user-defined network, so Strix's restricted-network mode is unusable here; see §4.5 |
| Isolated Linux runner or VM                         | **Missing.** Proposed in §4.5; nothing provisioned                                                                                                                              |
| Isolated test target with synthetic data (phase 2)  | **Missing.** Nothing has been verified as safe to attack; see §4                                                                                                                |
| Written authorization for a first assessment        | **Missing.** Required before any run; see §6                                                                                                                                    |

Until the blocked and missing rows above are resolved, no Strix run is authorized, including a
source-only run.

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
`docs/skills/SECURITY_REVIEW.md` in the same PR. A new CLI version also invalidates the sandbox
facts in §4.5 and the `run.json`/exit-code semantics in §8: re-read the runtime source before
relying on them.

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
they are not enforced by Strix: the operator enforces them, and §4.5 describes the technical
controls that have to exist before an operator can rely on them.

### 4.1 Explicit target allowlist

- Every run uses `--target-list security/strix/targets.local.txt` (gitignored; copy from
  `security/strix/targets.example.txt`) or an explicit `-t` that appears in that file. The file
  is the allowlist. Nothing outside it is in scope, including hostnames the agents discover.
- The allowlist is a scope declaration for the agents and for the record. It is **not** a
  technical control: an agent that decides to contact another host can do so if the sandbox
  network allows it. §4.5 covers what does restrict it.
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
6. The sandbox network for the run allows exactly that target and nothing else (§4.5). A dynamic
   target needs a network design that is not yet written; phase 2 stays blocked until it is.

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

### 4.5 Sandbox isolation: what is verified, what is unknown, what is required

#### Verified in the installed strix-agent 1.7.0 source (2026-10-22)

| Aspect                   | Fact (file)                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where model calls happen | In the `strix` host process (`warm_up_llm` in `interface/main.py`, LiteLLM). `LLM_API_KEY` is read by the host process and is **not** passed into the sandbox container                                                                                                                                                                                                                                          |
| Container environment    | Exactly: `PYTHONUNBUFFERED`, `HOST_GATEWAY=host.docker.internal`, `http_proxy`/`https_proxy`/`ALL_PROXY` pointing at the in-container Caido proxy, `NO_PROXY=localhost,127.0.0.1`, and on Linux hosts `STRIX_HOST_UID`/`STRIX_HOST_GID` (`runtime/session_manager.py`). No other host environment variable is forwarded                                                                                          |
| Mounts                   | Each local `-t` path is bind-mounted **writable** at `/workspace/<name>`. `.git`, `.agents` and `.codex` inside that path are overlaid read-only. For a linked worktree whose `.git` is a file, the shared git directory is mounted read-only only if it lies inside the tree; otherwise it is not mounted (the pointer dangles). `--workspace-file` content is copied in. Nothing else from the host is mounted |
| Docker socket            | Not mounted. The only Docker access is the host process talking to the daemon (`runtime/docker_connection.py`: `DOCKER_HOST`, else the current context, else the default socket)                                                                                                                                                                                                                                 |
| Capabilities             | `cap_add`: `NET_ADMIN`, `NET_RAW` (raw sockets for `nmap -sS` and similar), added unconditionally (`runtime/docker_client.py`). `SYS_ADMIN` only if a manifest requires FUSE, which Strix's manifest does not                                                                                                                                                                                                    |
| Network                  | Default Docker bridge with **unrestricted egress**, plus `extra_hosts host.docker.internal=host-gateway`, so the sandbox can reach every service on the host and everything the host network can reach. The Caido proxy port is published on `127.0.0.1` with a random host port                                                                                                                                 |
| Restricted-network mode  | `STRIX_DOCKER_SANDBOX_NETWORK=<name>` (present in `runtime/docker_client.py`, **not in the official documentation**) attaches the sandbox to that user-defined network and drops the port publish; the host must then reach the container IP directly on that network                                                                                                                                            |
| Resource limits          | Opt-in via `STRIX_SANDBOX_MEM_LIMIT`, `STRIX_SANDBOX_CPUS`, `STRIX_SANDBOX_PIDS_LIMIT`, `STRIX_SANDBOX_SHM_SIZE` (source-only); json-file log size is capped by default                                                                                                                                                                                                                                          |
| Telemetry                | PostHog and Scarf beacons from the host process at start and end; off with `STRIX_TELEMETRY=0`                                                                                                                                                                                                                                                                                                                   |

Probes run on the setup machine with throwaway containers (no Strix, no model call, cleaned up):

- A container on a `docker network create --internal` network could not reach `ghcr.io`
  (egress blocked); the same image on the default bridge could.
- The Windows host could not reach a container IP on either network (Docker Desktop has no route
  to container addresses). Consequence: on this machine `STRIX_DOCKER_SANDBOX_NETWORK` would
  break Strix's own Caido connection, so the restricted mode is **unusable on Docker Desktop for
  Windows** (and, for the same reason, expected to be unusable on Docker Desktop for macOS;
  untested).

#### Not verified (treat as unknown)

- What the sandbox image contains and which of its tools make their own outbound connections.
- Whether the restricted-network mode works end to end on a Linux host (Caido reachability via
  the container IP, `--internal` network with no gateway). It is the only candidate for egress
  control inside Strix and has not been exercised.
- How the agents behave when egress is blocked (package installs, web search, fetches).
- The internals of the `openai-agents` sandbox SDK and the Caido proxy.

#### Requirements for any source assessment (phase 1)

1. **A disposable, sanitized snapshot** of the authorized commit only: `git archive` of that
   commit into an empty directory, outside every worktree. It contains only tracked files, so
   untracked `.env*`, dumps, backups, `node_modules`, build output and the Prisma generated client
   cannot be in it. No `.git` metadata at all, so no linked-worktree pointer and nothing shared
   with the main checkout. (For a diff-scoped run, which needs git history, use an independent
   `git clone --no-local` into an empty directory, never a worktree.)
2. **No production credentials, application `.env` files, database dumps, customer data, cloud
   credentials, or inherited application API keys** on the host that runs Strix: not in the
   snapshot, not in the shell. `OPENAI_API_KEY` counts because Strix accepts it as a fallback for
   `LLM_API_KEY`.
3. **Explicit inspection of what enters the sandbox**: run `security/strix/preflight.sh
<snapshot>` from a clean shell (`env -i` with an explicit allowlist, §6.1). It checks the snapshot
   for forbidden files and git pointers, the environment for secret-bearing names (names only),
   the pinned versions, and the network policy, and refuses otherwise.
4. **Filesystem isolation**: the snapshot is the only host path given to Strix; it is deleted
   after the run; no worktree, no home directory, no credential store is ever passed with `-t` or
   `--workspace-file`.
5. **Enforced network restriction for the sandbox**: `STRIX_DOCKER_SANDBOX_NETWORK` set to an
   `--internal` network with no other containers, on a Linux host. For a code-only run the sandbox
   needs no egress at all. A target list or instruction file is not a substitute.
6. **Model-provider traffic is separate from target traffic**: the model provider is reached by
   the host process and is never a scan target; the sandbox (where target traffic originates) has
   no route to it. The host's own egress should be limited to the provider endpoint (host firewall
   or VM-level rules; not changed on the setup machine by this task).
7. **No Docker socket and no unrelated host directory** exposed to the agents. Strix 1.7.0 does
   not mount either; this must be re-verified after any CLI upgrade. `DOCKER_HOST` must be unset
   (local daemon only).

#### Blocker and proposed arrangement

Requirement 5 cannot be met on the setup machine (Docker Desktop for Windows). Until it is met
somewhere, phase 1 is blocked. Proposed, not yet provisioned or verified:

- A dedicated Linux VM (local hypervisor or a disposable cloud VM) with Docker Engine, created
  for the run and discarded afterwards. No Syveka credentials on it other than the dedicated
  Strix model key.
- Outbound firewall on the VM allowing only the model provider's API endpoint from the host
  process (and `ghcr.io` during the image pull), nothing else; the sandbox on an `--internal`
  Docker network with no egress.
- The snapshot copied in as a `git archive` tarball; `preflight.sh` and `verify-run.sh` copied in
  with it; `strix_runs/` copied out over the same channel; the VM destroyed.
- First use of that VM must confirm that Strix starts and the Caido proxy connects with
  `STRIX_DOCKER_SANDBOX_NETWORK` set, with a minimal budget, before any real assessment.

Phase 2 (a live target) needs an additional network design that allows exactly the target and is
not written yet.

## 5. Credentials, cost and data handling

### 5.1 Environment variables (names verified against the official configuration reference)

Set these in a clean shell for the duration of a run (§6.1), or in `~/.strix/cli-config.json`
(outside the repository). Never add them to `.env*` files of the application and never commit
them.

```bash
# Required
STRIX_LLM="anthropic/claude-sonnet-4-6"   # LiteLLM model id; see docs.strix.ai/llm-providers/overview
LLM_API_KEY="<dedicated key with a verified provider-side hard limit>"

# Required by this runbook
STRIX_TELEMETRY=0                                    # disables PostHog + Scarf + remote OTEL export
STRIX_IMAGE="ghcr.io/usestrix/strix-sandbox:1.3.0"   # pin the sandbox image explicitly
STRIX_DOCKER_SANDBOX_NETWORK="strix-isolated"        # --internal network; source-only setting, see §4.5

# Optional
LLM_API_BASE="<gateway url>"               # only for a self-hosted or proxied model endpoint
STRIX_REASONING_EFFORT="high"              # default
LLM_TIMEOUT=300                            # seconds, default
STRIX_SANDBOX_EXECUTION_TIMEOUT=120        # seconds, default
STRIX_SANDBOX_MEM_LIMIT / STRIX_SANDBOX_CPUS / STRIX_SANDBOX_PIDS_LIMIT   # source-only cgroup caps
POSTMAN_API_KEY=...                        # only for postman:// targets (not used by Syveka)
PERPLEXITY_API_KEY / EXA_API_KEY           # optional web search for the agents; leave unset
```

Use a key created for this purpose with its own spend limit at the provider. Do not reuse the
application's `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. Strix also accepts `OPENAI_API_KEY` as a
fallback for `LLM_API_KEY`, so the application's key must not be present in the shell that runs
Strix (`preflight.sh` fails if it is).

### 5.2 What leaves the machine

- To the model provider named in `STRIX_LLM`, from the host process: the contents of every file
  the agents read from a code target, every HTTP request and response the agents exchange with a
  dynamic target (including any data in it), the text of `--instruction`/`--instruction-file`
  (so any test credentials in it), and the agents' own reasoning. This is why only synthetic data
  and throwaway test credentials may ever be in scope.
- From the sandbox: whatever the agents send to the targets, and anything else its network
  allows (§4.5). On an `--internal` network: nothing.
- To ghcr.io: the sandbox image pull.
- To PostHog (`us.i.posthog.com`) and Scarf (`strix.gateway.scarf.sh`): usage telemetry unless
  `STRIX_TELEMETRY=0`.
- To Perplexity/Exa: only if those keys are set (they are not).
- To app.strix.ai: nothing, unless `strix cloud ...` commands are used. They are not authorized.

Locally, `strix_runs/<run>/` holds the report, per-finding PoCs, `vulnerabilities.json/.csv`,
`findings.sarif`, `run.json` (status, inputs including the instruction text, usage/cost) and
`events.jsonl` (run telemetry). Findings are sensitive: keep the directory out of git (it is
gitignored), out of chat tools, and share only through the private channel agreed in §6.

### 5.3 Budget controls

- `--max-budget <USD>` is mandatory on every run, but it is an **estimated-cost stop, not a
  billing ceiling**. Strix computes cost from token counts and its own pricing table after each
  model response; in headless mode it stops the run cleanly (status `stopped`, sandbox torn
  down) when the estimate reaches the cap. The estimate can lag in-flight requests, can be wrong
  for models or providers whose pricing Strix does not know, and can under-count providers that
  return no usage data. It does nothing about what the provider actually bills.
- A **provider-side spending control is required** on the dedicated key's organization or
  workspace, and it must be an enforced limit, not a notification. For Anthropic, the Console
  offers organization-level spend limits and per-workspace monthly spend limits (API keys belong
  to a workspace); usage notifications are alerts and do not stop requests. The official pages
  reached for this runbook do not state exactly how requests behave once a workspace limit is
  hit, and provider metering is not instantaneous, so the operator must verify in the Console,
  before the key is used, that the limit is enforced (requests refused) and record the configured
  amount in the authorization. The organization's usage tier is a separate ceiling and is not a
  substitute. If an enforced limit cannot be verified, the run is not authorized.
- `--max-turns <N>` caps turns per agent (default 500) and is a second brake.
- `-m quick` or `-m standard` for routine runs; `deep` (the default) can run for hours and must be
  budgeted explicitly.
- A run that hit the budget or turn cap exits `0` (or `2` if findings exist) with
  `run.json` `status: "stopped"`. `security/strix/verify-run.sh` rejects anything but
  `completed`; do not interpret a clean exit as coverage without it (§8).

## 6. Authorizing and running a first narrowly scoped assessment

Nothing below has been run. Installation and preparation only were authorized. Phase 1 is
additionally blocked by §4.5 until an isolated Linux runner exists.

### 6.1 Phase 1: source-code assessment (no live target)

1. Obtain explicit written authorization from the repository owner naming: the commit to scan,
   the paths in scope, the budget cap and the verified provider-side limit, the model, the runner
   (§4.5), and who receives the findings.
2. On the isolated Linux runner, create the snapshot from the authorized commit into an empty
   directory outside every worktree:

   ```bash
   mkdir -p /srv/strix/snapshot && cd /srv/strix
   git -C <path-to-an-independent-clone> archive --format=tar <commit> | tar -x -C /srv/strix/snapshot
   ```

   The snapshot has no `.git`, so it cannot point at shared metadata; it has no untracked files,
   so no `.env*`, dumps or `node_modules`. Copy `security/strix/preflight.sh`,
   `security/strix/verify-run.sh` and the instruction file next to it, not into it.

3. Create the sandbox network once per run: `docker network create --internal strix-isolated`.
4. Open a clean shell with only the allowed variables:

   ```bash
   env -i PATH="$PATH" HOME="$HOME" \
     STRIX_LLM="<model>" LLM_API_KEY="<dedicated key>" STRIX_TELEMETRY=0 \
     STRIX_IMAGE="ghcr.io/usestrix/strix-sandbox:1.3.0" STRIX_DOCKER_SANDBOX_NETWORK=strix-isolated \
     bash
   ```

5. Inspect what will enter the sandbox: `bash preflight.sh /srv/strix/snapshot`. Every line must
   be `PASS`; `FAIL` lines name the problem (variable names only, never values).
6. Write `instruction.local.md` from `security/strix/instruction.example.md`: tenancy model,
   trust boundaries, attacker-controlled inputs, the priority list from §4.4, and the exclusions.
7. Run from the snapshot's parent directory, with a start marker so the result can be tied to this
   invocation, and capture the exit code without `set -e` swallowing it:

   ```bash
   cd /srv/strix && rm -rf strix_runs && touch .strix-start-marker
   strix -n -t ./snapshot -m standard --scope-mode full \
     --instruction-file ./instruction.local.md \
     --max-budget <authorized USD> --max-turns 300 --fail-on medium
   code=$?
   bash verify-run.sh strix_runs "$code" .strix-start-marker
   ```

   `verify-run.sh` exits `0` only for a single, fresh, `completed` run with exit code `0`; `2` for
   validated findings; `1` for a fatal error, an unexpected exit code, a `stopped`/`failed`/
   `interrupted` run (budget or turn cap included), or missing, stale or malformed output.

8. Copy `strix_runs/<run>/` to the private location agreed in step 1. Destroy the snapshot, the
   network (`docker network rm strix-isolated`) and the runner.

### 6.2 Phase 2: isolated dynamic assessment (later; blocked)

Only after §4.3 is complete for a target, a network design exists that lets the sandbox reach
exactly that target (§4.5), and a second written authorization names that target:

1. Prepare test accounts in the target: organization A with an `OWNER` and a `MEMBER`,
   organization B with an `OWNER`, one user who belongs to no organization, and one API key per
   organization with minimal scopes. Record them in `instruction.local.md` (gitignored), never in
   `--instruction` on the command line (shell history).
2. List the target base URL in `targets.local.txt` (from `security/strix/targets.example.txt`).
   Add the code snapshot as a second target for grey-box depth if the authorization covers it.
3. Run with the same marker and `verify-run.sh` pattern as §6.1:

   ```bash
   strix -n --target-list ./targets.local.txt -t ./snapshot \
     -m standard --instruction-file ./instruction.local.md \
     --max-budget <authorized USD> --max-turns 300 --fail-on medium
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
5. Retest with a focused run under the same isolation as §6.1, from a fresh snapshot of the fix
   branch. Diff scope needs git history, so this is the one case for an independent
   `git clone --no-local` instead of an archive:

   ```bash
   strix -n -t ./snapshot -m quick --scope-mode diff --diff-base origin/main \
     --instruction "Re-test finding <id>: <one-line description>. Confirm the exploit no longer works." \
     --max-budget <authorized USD>
   code=$?
   bash verify-run.sh strix_runs "$code" .strix-start-marker
   ```

   `verify-run.sh` exit `2` means the finding (or a new one) is still present; `0` means nothing
   validated in the analyzed scope in a run that completed. Repeat the manual PoC as well.

6. Record the finding, the fix PR and the retest result in `docs/SECURITY-AUDIT.md`.

## 8. Proposed manual CI workflow (documentation only; INCOMPLETE, BLOCKED)

No workflow file is added. Workflow files are protected configuration under `CLAUDE.md` §9 (CI
policy change) and require their own explicit authorization. Automatic scanning on `push`,
`pull_request` or a schedule is explicitly not proposed: it would expose a paid model key to
every PR and run attacks without an operator.

**Status: incomplete and blocked. Do not activate.** A GitHub-hosted runner does not meet §4.5:
the runner host has unrestricted egress, Strix's restricted-network mode is undocumented and has
not been verified on a Linux runner, and the findings artifact is readable by everyone with read
access to Actions. The proposal below is kept so that the failure handling, input validation and
trust boundaries are reviewed now and do not have to be invented under time pressure later.

Dependencies before it could be added:

1. Authorization for a CI policy change.
2. A GitHub Environment `security-scan` with required reviewers, holding `STRIX_LLM` and
   `LLM_API_KEY` as environment secrets, where the key has a verified provider-side hard limit
   (§5.3).
3. A repository variable `STRIX_MAX_BUDGET_USD` set by an owner: the ceiling any dispatch may
   request. No amount is proposed here.
4. A committed, credential-free `security/strix/instruction.ci.md`.
5. A decision on where findings go (the artifact below is visible to anyone with read access).
6. Proof on a Linux runner that Strix completes a minimal run with `STRIX_DOCKER_SANDBOX_NETWORK`
   set to an `--internal` network (§4.5), or a self-hosted runner that meets §4.5 another way.

Trust boundary: environment approval gates **when** the key is exposed, not **what** runs. The
workflow runs only from `refs/heads/main`, checks out `github.sha` exactly, and takes the
instruction file and the gate scripts from that commit, so the content the key is exposed to has
passed branch protection and review. A `workflow_dispatch` from any other ref is refused in the
first step. Required reviewers must still check the dispatch inputs, since inputs are not
reviewed code.

Failure handling, validated with synthetic fixtures (39 cases, no Strix invocation) against
`security/strix/verify-run.sh` on 2026-10-22: the scanner's exit code is captured with `set +e`
immediately after the command; `1` and any code other than `0` or `2` fail; `2` fails at the
configured `--fail-on` threshold; `0` passes only if exactly one `run.json` newer than the start
marker exists, is a JSON object with `status: "completed"`, a non-empty `end_time`,
`non_interactive: true` and a `run_name` matching its directory, and the report file exists;
stale run directories, missing or malformed output, and `stopped`/`failed`/`interrupted` runs
(budget and turn caps included) all fail. Semantics come from the installed 1.7.0 source
(`interface/main.py`, `report/state.py`).

```yaml
name: Strix source assessment (manual) # PROPOSAL ONLY; blocked by runbook §8 dependencies

# Manual, operator-approved, code-only Strix run. Never on push/pull_request/schedule.
on:
  workflow_dispatch:
    inputs:
      confirm:
        description: "Type SCAN-SOURCE to confirm a budgeted, code-only run"
        required: true
        type: string
      max_budget_usd:
        description: "Estimated-cost stop for this run in USD (must be <= vars.STRIX_MAX_BUDGET_USD)"
        required: true
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

env:
  STRIX_VERSION: "1.7.0"
  STRIX_IMAGE: ghcr.io/usestrix/strix-sandbox:1.3.0
  STRIX_NETWORK: strix-isolated

jobs:
  strix:
    name: Strix code assessment
    if: github.ref == 'refs/heads/main'
    runs-on: ubuntu-latest
    environment: security-scan # required reviewers approve every dispatch
    timeout-minutes: 60
    steps:
      - name: Validate ref and inputs
        shell: bash
        run: |
          set -euo pipefail
          [ "$RUN_REF" = "refs/heads/main" ] || { echo "only main may be scanned"; exit 1; }
          [ "$CONFIRM" = "SCAN-SOURCE" ] || { echo "confirmation missing"; exit 1; }
          [[ "$BUDGET" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "budget must be a decimal number"; exit 1; }
          [[ "$CEILING" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "vars.STRIX_MAX_BUDGET_USD is not set to a number"; exit 1; }
          awk -v b="$BUDGET" -v c="$CEILING" 'BEGIN { exit !(b > 0 && b <= c) }' \
            || { echo "budget must be > 0 and <= the owner-approved ceiling"; exit 1; }
        env:
          RUN_REF: ${{ github.ref }}
          CONFIRM: ${{ inputs.confirm }}
          BUDGET: ${{ inputs.max_budget_usd }}
          CEILING: ${{ vars.STRIX_MAX_BUDGET_USD }}

      - name: Checkout exact main commit
        uses: actions/checkout@v4
        with:
          ref: ${{ github.sha }}
          persist-credentials: false

      - name: Install Strix (pinned)
        run: pipx install "strix-agent==${STRIX_VERSION}" && strix --version

      - name: Pull sandbox image (pinned)
        run: docker pull "$STRIX_IMAGE"

      - name: Create isolated sandbox network
        run: docker network create --internal "$STRIX_NETWORK"

      # The runner shell carries Actions tokens; Strix and the preflight run under
      # env -i with an explicit allowlist so nothing else is inherited.
      - name: Preflight (snapshot, environment, network policy)
        shell: bash
        run: |
          set -euo pipefail
          env -i PATH="$PATH" HOME="$HOME" \
            STRIX_LLM="$STRIX_LLM" LLM_API_KEY="$LLM_API_KEY" STRIX_TELEMETRY=0 \
            STRIX_IMAGE="$STRIX_IMAGE" STRIX_DOCKER_SANDBOX_NETWORK="$STRIX_NETWORK" \
            bash security/strix/preflight.sh "$GITHUB_WORKSPACE"
        env:
          STRIX_LLM: ${{ secrets.STRIX_LLM }}
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}

      - name: Run code-only assessment
        id: scan
        shell: bash
        run: |
          set -uo pipefail
          rm -rf strix_runs
          touch .strix-start-marker
          set +e
          env -i PATH="$PATH" HOME="$HOME" \
            STRIX_LLM="$STRIX_LLM" LLM_API_KEY="$LLM_API_KEY" STRIX_TELEMETRY=0 \
            STRIX_IMAGE="$STRIX_IMAGE" STRIX_DOCKER_SANDBOX_NETWORK="$STRIX_NETWORK" \
            strix -n -t ./ -m "$SCAN_MODE" --scope-mode full \
              --instruction-file security/strix/instruction.ci.md \
              --max-budget "$BUDGET" --max-turns 300 --fail-on medium
          code=$?
          set -e
          echo "strix exit code: $code"
          echo "exit_code=$code" >> "$GITHUB_OUTPUT"
        env:
          STRIX_LLM: ${{ secrets.STRIX_LLM }}
          LLM_API_KEY: ${{ secrets.LLM_API_KEY }}
          SCAN_MODE: ${{ inputs.scan_mode }}
          BUDGET: ${{ inputs.max_budget_usd }}

      # Uploaded before the gate so a failed run keeps its evidence. run.json
      # holds the committed instruction text and usage figures, never the key.
      - name: Upload run output (7-day retention; visible to repository readers)
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: strix-run-${{ github.run_id }}
          path: strix_runs/
          retention-days: 7
          if-no-files-found: ignore

      - name: Gate on exit code and a fresh, completed run.json
        if: always()
        shell: bash
        run: |
          set -euo pipefail
          bash security/strix/verify-run.sh strix_runs "${SCAN_EXIT:-missing}" .strix-start-marker
        env:
          SCAN_EXIT: ${{ steps.scan.outputs.exit_code }}

      - name: Remove sandbox network
        if: always()
        run: docker network rm "$STRIX_NETWORK" || true
```

Notes on the proposal: the gate step runs `if: always()` so a scan step that never produced an
exit code (`missing`) is rejected by `verify-run.sh`'s integer check; SARIF upload to code
scanning (`findings.sarif`, needs `security-events: write`) is left out until dependency 5 is
settled; and the install step pins the same version reviewed here. The workflow as written has
not been executed anywhere.

## 9. Limitations

- Strix is an AI agent. Coverage is non-deterministic, bounded by budget and turns, and shaped by
  the instructions given. Two runs on the same commit can differ.
- Its sandbox is a container with `NET_ADMIN`/`NET_RAW` and, by default, unrestricted egress and
  a route to the host. The isolation in §4.5 is layered around it by the operator; the only
  in-Strix network control is an undocumented setting that is unusable on Docker Desktop and
  unverified on Linux.
- It does not replace the existing gates: the `gitleaks` secret scan and
  `production-dependency-audit` in `ci.yml`, the RLS SQL tests, the unit and E2E suites, and
  human review remain in place and are not weakened by this integration.
- Findings are produced by an LLM reading code and responses; they can be wrong in both
  directions. Validation by a human is part of the process, not an optional step.
- `--max-budget` is an estimate; billing is whatever the provider meters. Only a verified
  provider-side enforced limit bounds spend (§5.3).
- The CLI is pinned to 1.7.0 and the sandbox image to 1.3.0. Newer versions require re-review
  (§3), including of the sandbox facts in §4.5.
- Windows is a supported host for the CLI, but the restricted-network mode is not usable on
  Docker Desktop for Windows (§4.5), so this machine can install and verify Strix but cannot run
  an assessment that meets this runbook.
