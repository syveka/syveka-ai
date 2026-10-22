<!-- PROPOSAL ONLY. Nothing in this document has been applied. It reviews PR #356 (chore/strix-security-integration, head 63e0cb2) and proposes controls; every change it lists touches protected paths (.claude/**, .github/**) and needs the owner's per-instance authorization. Strix was not invoked. -->

# PR #356 (Strix) — remediation proposal, 2026-10-22

Proposal only. Nothing below was applied: `.claude/settings.json`, the hooks and the skills are
protected paths and were not edited; Strix was not invoked; #356 was not merged.

## Status: what is enforced today versus what this document proposes

| Control                                                                                                           | Status                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `command-guard.mjs` and `config-protection.mjs` hooks (git, gh, vercel, supabase, rm, redirects, protected paths) | **Implemented and tested** on main. None of their rules names Strix, Docker bind mounts, `uv tool`, `pipx` or `curl \| bash`.                                                                    |
| `security/strix/preflight.sh`, `security/strix/verify-run.sh`                                                     | **Exist on the #356 branch** (not on main). Run only when a person runs them; no hook calls them; their result binds nothing.                                                                    |
| Runbook §4.5 isolation requirements and §6 procedure                                                              | **Documentation.** Correct, not enforced.                                                                                                                                                        |
| Every item under "Proposed changes" and "Target enforcement" below (A–G, 1–4)                                     | **Proposed. Not implemented, not tested, not authorized.** Where an item says "block", "require" or "refuse", read "would, once implemented, reviewed and tested like the existing guard rules". |

Two corrections from the 2026-10-22 review are folded into the items below: an environment-variable
prefix on the command line does not prove network isolation (C), and a writable marker file is
neither authorization nor trustworthy proof (E).

## What was verified (head `63e0cb2`, read from the branch and the installed hook)

| Fact                                                                                                                                                                                                                                                                                                                                                                                                                       | Where                                                                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Five skills are installed with upstream frontmatter only (`name`, `description`, `license`, `metadata`). None sets `disable-model-invocation`, so Claude Code may invoke any of them on its own when a request sounds like "scan", "pentest", "audit" or "find vulnerabilities".                                                                                                                                           | `.claude/skills/*/SKILL.md` lines 1–8                                 |
| The skills themselves tell the agent to run `curl -sSL https://strix.ai/install \| bash`, `strix -n -t ./ ...` (bind-mounts the current tree writable), `strix cloud login`, `strix cloud scans start --source .` (uploads the working tree), to ask the user for `LLM_API_KEY`, and to put credentials in `--instruction`. The runbook says these are superseded by §6, but the skill text is what the model reads first. | `penetration-testing-with-strix/SKILL.md` lines 43–53, 59–83, 130–152 |
| The command guard has no rule for `strix`, `uv tool`, `pipx`, or `docker run` with a bind mount. `docker` is handled only as an `exec` wrapper so the inner command is inspected; `curl` is handled for output-file paths. A Bash call `strix -n -t ./ --max-budget 10` passes the guard today.                                                                                                                            | `.claude/hooks/command-guard.mjs` 919, 1332–1340, 2776–2811           |
| `.claude/settings.json` registers the two hooks and a Prettier post-hook; it has no `permissions.deny` list, so nothing denies `strix`, `strix cloud`, or `curl ... \| bash` at the permission layer either.                                                                                                                                                                                                               | `.claude/settings.json`                                               |
| The runbook's isolation requirements (sanitized `git archive` snapshot, `env -i`, `--internal` network, Linux host, `preflight.sh`, `verify-run.sh`) are correct and honest about the Docker Desktop for Windows blocker, but they are prose plus two scripts; no mechanism prevents a run that skips them.                                                                                                                | `docs/strix-security-testing-runbook.md` §4.5, §6                     |
| Pushing the branch created two Vercel Preview deployments (production and staging projects). The runbook records this.                                                                                                                                                                                                                                                                                                     | runbook §1.3                                                          |

## Gaps, by severity

1. **Invocation control (high).** The skills are model-invocable and contain live run instructions. The runbook's conditions 2, 3, 7, 8, 11 and 12 (written authorization, allowlist, preflight, internal network, no cloud, no upstream install commands) depend on the agent reading and obeying a different document.
2. **Guard coverage (high).** No hook rule covers `strix`, `strix cloud`, `uv tool install`, `pipx install`, `curl | bash`, or `docker run -v`/`--mount` of a repository or home path. The guard would not stop a bind mount of a worktree (which contains `.env*` and `.git`) into the sandbox.
3. **Isolation (medium, documented).** Requirement 5 (sandbox on an `--internal` network) is unmeetable on the setup machine; the runbook says so and blocks phase 1. The gap is that nothing enforces the block.
4. **Credential surface (medium).** `OPENAI_API_KEY` is accepted by Strix as a fallback for `LLM_API_KEY`; the application's own `.env*` files carry it. `preflight.sh` checks names in the shell, but only when it is run.
5. **Egress and telemetry (low).** PostHog/Scarf beacons from the host process unless `STRIX_TELEMETRY=0`; sandbox has unrestricted egress on the default bridge. Covered by the runbook's env recipe; not enforced.

## Proposed changes (each is a protected-path change; separate authorization per item)

A. **Make every Strix skill user-only.** Add `disable-model-invocation: true` to the frontmatter of the five skills so they load only on an explicit `/skill-name` from a person. This is a one-line change per file, keeps the upstream content byte-comparable below the frontmatter, and is the single most effective control. Re-record `skills-lock.json` only if the installer's hash covers frontmatter (verify first).

B. **Prepend a Syveka preamble to each skill** (above the upstream text, clearly delimited): "Do not run any command from this file. In this repository Strix runs only through `docs/strix-security-testing-runbook.md` §6, on an isolated Linux runner, after written authorization. `strix cloud` is not authorized." The runbook already states this in §1.1; the skill is where the agent reads.

C. **Guard rules in `command-guard.mjs`** (unit-tested like the existing rules):

- block `strix` and `strix.exe` as a command name for the agent, full stop; block `strix cloud` unconditionally. A `STRIX_DOCKER_SANDBOX_NETWORK=…` prefix on the command line proves nothing about isolation (the variable can name a network that does not exist, is not `--internal`, or has other members, and the hook only sees text). If an agent-run assessment is ever wanted, the hook would have to verify the live Docker state itself at invocation time (`docker network inspect <name>`: `Internal: true`, zero attached containers, Linux engine) from the hook process, which the scanner cannot write to, and still only after a human `!` command carried the authorization. Until that exists, the only permitted invocation is the owner's own `!` command;
- block `curl ... | bash`/`sh` and `wget ... | bash` (install scripts) unconditionally;
- block `uv tool install`, `pipx install`, `pip install` of `strix-agent` outside an explicit human `!` command;
- block `docker run`/`docker create` with `-v`, `--mount` or `--volume` whose source is inside a git worktree, `$HOME`, or a path containing `.env`, `.git`, `supabase/.temp`, `node_modules`;
- keep the existing "human `!` command" escape so the owner can still run an authorized assessment.

D. **Permission deny list in `.claude/settings.json`** as defense in depth for the same commands (`Bash(strix *)`, `Bash(strix.exe *)`, `Bash(curl *| bash*)`, `Bash(uv tool install*)`, `Bash(pipx install*)`), so a guard regression does not reopen the path.

E. **Isolation gate as code, with the verifier outside the scanner-writable tree.** Move the "phase 1 is blocked" decision out of prose. `preflight.sh` already refuses on a non-Linux host and a missing internal network; wire the proposed CI job (runbook §8) to call it first. What must **not** be done: have the guard trust a marker file such as `security/strix/.preflight-ok`. A file the agent (or the scanner, whose `-t` path is mounted writable) can create is neither authorization nor proof; the review is right that it would be forged by a single `Write`. The checks have to run inside the hook process at invocation time, reading live state (`uname`, `docker network inspect`, the environment of the command being inspected, the snapshot path's location outside every worktree and `$HOME`), and `preflight.sh` and `verify-run.sh` have to be executed from a copy that lives outside the snapshot and outside any path handed to Strix, as the runbook §6 step 2 already says ("next to it, not into it"). Authorization stays a human `!` command; no file stands in for it.

F. **Credential hygiene.** Add `OPENAI_API_KEY` and all `STRIPE_*`, `SUPABASE_*`, `DATABASE_URL`, `DIRECT_URL`, `RESEND_*`, `QSTASH_*`, `VAPI_*`, `ANTHROPIC_*` names to the names `preflight.sh` refuses (verify the current list; some are present), and document that Strix must run from a shell started with `env -i` only.

G. **Review conditions as PR checks.** The `SECURITY_REVIEW.md` conditions 1 (pins) and 12 (no upstream install commands executed) can be asserted by a small unit test that reads `skills-lock.json` and the skill frontmatter (A and B above) so a future `npx skills update` cannot silently re-enable model invocation.

## Order and ownership

1. A + B (skills frontmatter and preamble) and D (settings deny list): owner-applied or owner-authorized, since both paths are protected (`.claude/**`). Lowest effort, closes gap 1.
2. C + G (guard rules with tests): a normal PR, but the hooks directory is protected, so it needs per-instance authorization before the branch is pushed.
3. E + F: follow-ups to `security/strix/*.sh` (not protected) once the Linux runner exists.

Until A–D land, #356 should stay a draft: merging it as is adds model-invocable skills whose instructions, if followed, install software, mount the working tree writable into a sandbox with unrestricted egress, and can upload the source to a third-party cloud.

## Target enforcement (added 2026-10-22, second pass)

Today the only target control is prose plus `security/strix/targets.example.txt`: the runbook says
targets come from `targets.local.txt`, but `strix -t <anything>` accepts any URL, host or path and
nothing checks it. Proposed, in order of effort:

1. **Guard rule:** a `strix` invocation may carry `-t`/`--target` only as a path under an allowlisted
   snapshot root (for example `/srv/strix/snapshot`) or `--target-list` pointing at
   `security/strix/targets.local.txt`; any other `-t` value (URL, host, IP, worktree path, `./`) is
   refused. Production hostnames (`syveka.com`, the production Supabase and Vercel hosts) are a
   hard deny even inside the list.
2. **`preflight.sh` reads the target list** and refuses when any entry is not on the committed
   allowlist pattern (`security/strix/targets.example.txt` documents the allowed shapes: the
   isolated staging-like test host and the snapshot path only), when a production host appears,
   or when the list contains credentials.
3. **Instruction-file check:** `preflight.sh` refuses an instruction file that contains a URL or
   host not present in the target list, so "scope hints" cannot widen the scope.
4. **Network as the backstop:** on the isolated runner the sandbox sits on an `--internal` network
   whose only other member is the authorized test target (phase 2) or nothing (phase 1), so even a
   wrong `-t` cannot reach anything else. This is requirement 5 in the runbook, restated as the
   control that holds when the others are bypassed.
