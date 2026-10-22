<!-- PROPOSAL ONLY. Nothing in this document has been applied. It reviews PR #356 (chore/strix-security-integration, head 63e0cb2) and proposes controls; every change it lists touches protected paths (.claude/**, .github/**) and needs the owner's per-instance authorization. Strix was not invoked. -->

# PR #356 (Strix) — remediation proposal, 2026-10-22

Proposal only. Nothing below was applied: `.claude/settings.json`, the hooks and the skills are
protected paths and were not edited; Strix was not invoked; #356 was not merged.

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

- block `strix` and `strix.exe` as a command name unless the invocation carries `STRIX_DOCKER_SANDBOX_NETWORK=` in its environment prefix and the target paths are outside every git worktree and the home directory; block `strix cloud` unconditionally;
- block `curl ... | bash`/`sh` and `wget ... | bash` (install scripts) unconditionally;
- block `uv tool install`, `pipx install`, `pip install` of `strix-agent` outside an explicit human `!` command;
- block `docker run`/`docker create` with `-v`, `--mount` or `--volume` whose source is inside a git worktree, `$HOME`, or a path containing `.env`, `.git`, `supabase/.temp`, `node_modules`;
- keep the existing "human `!` command" escape so the owner can still run an authorized assessment.

D. **Permission deny list in `.claude/settings.json`** as defense in depth for the same commands (`Bash(strix *)`, `Bash(strix.exe *)`, `Bash(curl *| bash*)`, `Bash(uv tool install*)`, `Bash(pipx install*)`), so a guard regression does not reopen the path.

E. **Isolation gate as code.** Move the "phase 1 is blocked" decision out of prose: `preflight.sh` already refuses on a non-Linux host and a missing internal network; wire the proposed CI job (runbook §8) to call it first, and have the guard rule in C require that `preflight.sh` has written a fresh PASS marker file (for example `security/strix/.preflight-ok` with a timestamp under 10 minutes) before `strix` may run. The marker is gitignored.

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
