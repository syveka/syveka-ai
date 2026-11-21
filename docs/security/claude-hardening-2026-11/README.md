# Claude Code hardening, November 2026

Findings, prepared patches and operating guidance for this repository's Claude Code setup. This
covers development tooling only; nothing here changes the product, staging or production.

**Status: nothing in `patches/` is applied.** `.claude/**`, `.github/**` and
`tests/unit/hook-*.test.ts` are protected, so an agent can't change them unless the owner starts
the session with the override set. Each patch is an owner decision.

## Apply

Review each patch first, then from a checkout of this branch, in your own terminal:

```
git apply docs/security/claude-hardening-2026-11/patches/01-guard-hardening.patch
npx vitest run tests/unit/hook-path-hardening.test.ts tests/unit/hook-command-guard.test.ts tests/unit/hook-config-protection.test.ts tests/unit/hook-block-no-verify.test.ts
git apply docs/security/claude-hardening-2026-11/patches/02-project-settings.patch
git apply docs/security/claude-hardening-2026-11/patches/03-codeql-workflow.patch
```

Then commit and push from your own shell, or from a session started with
`SYVEKA_ALLOW_PROTECTED_CONFIG_EDIT=1`. Start a new session afterwards so the hooks and settings
load, and check `/hooks` and `/plugin`: neither Shopify nor CLI-Anything should be listed as active.

| Patch                       | What it does                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------ |
| `01-guard-hardening.patch`  | Closes the guard gaps below, adds `tests/unit/hook-path-hardening.test.ts`, updates guard docs   |
| `02-project-settings.patch` | Disables Shopify and CLI-Anything for this repository; adds Read and Edit deny rules for secrets |
| `03-codeql-workflow.patch`  | Adds CodeQL for JavaScript/TypeScript and Actions, outside `ci-required`                         |

Patch 02 touches the same `enabledPlugins` key as open PR #251, so whichever merges second needs a
small conflict resolution. It leaves the `PostToolUse` Prettier hook alone; the unmerged
`chore/writer-agents-no-bash` branch removes it.

## Rollback

| Change                 | How to undo it                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------- |
| A patch, not committed | `git apply -R <patch>`                                                                         |
| A patch, committed     | `git revert <commit>`                                                                          |
| User settings script   | Copy the timestamped `settings.json.<time>.bak` it printed back over `~/.claude/settings.json` |
| Shopify opt-out file   | Delete `%APPDATA%\shopify-ai-toolkit\opt-out`                                                  |
| CodeQL                 | Revert the workflow commit; existing results stay in the Security tab until dismissed          |
| Playwright CLI pilot   | Nothing in the repository to undo; it ran from a temporary folder                              |

## Confirmed guard gaps

Evaluated with synthetic payloads against the hooks at `origin/main` `40f71ae7`; the guards classify
text and nothing in a payload runs.

| Gap                                                                                                                            | Example                                    | Current | Patched |
| ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ | ------- | ------- |
| git options that run a program, which a `git fetch *` allow rule would approve without a prompt                                | `git fetch --upload-pack=<cmd> origin`     | allow   | deny    |
| Read-style git commands that overwrite protected files                                                                         | `git log --output=.claude/settings.json`   | allow   | deny    |
| Other git writes                                                                                                               | `git archive -o vitest.config.ts HEAD`     | allow   | deny    |
| Script written by a heredoc and run in the same command (this is how the audit's first inventory script read `~/.claude.json`) | `cat > x.js <<EOF … node x.js`             | allow   | deny    |
| Home-relative wildcards                                                                                                        | `cat ~/.claude.j*`                         | allow   | deny    |
| PowerShell variables holding a home path                                                                                       | `$p = "$HOME\.claude.json"; gc $p`         | allow   | deny    |
| Credential stores missing from the MCP pre-filter                                                                              | `.pgpass`, `.npmrc`, `.docker/config.json` | allow   | deny    |
| Claude Code's own copies of its config                                                                                         | `.claude.json.tmp`, `.corrupted.*`         | allow   | deny    |
| Device prefixes and file URLs                                                                                                  | `\\.\C:\…`, `file:///…?x`, `view-source:`  | allow   | deny    |
| Protected files in a sibling worktree of the same repository                                                                   | `<other worktree>/vitest.config.ts`        | allow   | deny    |
| File-tool writes to credential stores                                                                                          | Write `~/.ssh/authorized_keys`             | allow   | deny    |
| npm or Vitest runs that replace their registry, config or runner module                                                        | `npm ci --registry=<url>`                  | allow   | ask     |

### Evidence for patch 01

The patches could only be tested on scratch copies of the hooks, so run the commands under "Apply"
to confirm the same results in the repository.

| Check                                                                    | Result                                                                                   |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Existing hook suites plus the new regression file, against patched hooks | 338 passed                                                                               |
| The regression file against unpatched hooks                              | 116 of 174 fail, as intended; the rest are allow and pin cases                           |
| Old and new hooks over 2,372 payloads from the existing suites           | 0 weaker, 3 stricter                                                                     |
| Independent reviews                                                      | Four rounds; regressions and bypasses they found were fixed; the last found no weakening |

The last review found no weakening, but it recorded decision changes that are safe only because an
equally short spelling was already allowed, or because the new reading names no real file:

- In Bash, `env=.env; cat "$env::\$DATA"` is no longer denied, because the `$env:` exception ignores
  the dialect. `export e=.env; cat "$e"` was already allowed.
- `'$APPDATA/../ci.yml'` from inside a protected directory resolves away from it, like the existing
  `'$HOME/../ci.yml'` form.
- A command word named after a JavaScript prototype key, such as `constructor`, can crash the
  inspection and fail open on non-sensitive text. The base code has the same crash at another
  lookup; `Object.hasOwn` at both would close it.

### Remaining after the patches

The guards are pattern analysis, not a sandbox, and Claude Code has no OS sandbox on native Windows.
These stay open:

- Scripts written by `printf`, `cp`, a PowerShell here-string, a multi-line `{ … } > file` group or
  an earlier tool call, then run. Runners the guard doesn't recognize, such as `uv run` or `awk -f`.
- Code piped into an interpreter is judged by keywords, not inspected, and a heredoc elsewhere in
  the same command can suppress that check.
- Obfuscation such as splitting a file name across strings.
- Hard links to a credential file, because a path can't reveal them.
- `git --ext-diff`, which needs a config write that is already blocked.
- `npx`'s own options, and `pnpm vitest` or `yarn vitest` overrides.
- Worktrees nested in a session root outside `.claude/worktrees` and `.worktrees`.

Patch 01 also adds a few stricter results to know about: `Edit` of any `*.pem` fixture is denied,
`cat ~/*` is denied because the guard's glob matches dotfiles, `git clone --template` and
`git config remote.x.url <value>` are denied, and `npm --prefix app ci` prompts.

The stronger control for secrets is keeping them out of files an agent's account can read, or running
sessions under WSL2 with the sandbox enabled.

## Shopify telemetry

Tested on a sandboxed copy of `track-telemetry.sh` (plugin 2.1.2) with synthetic prompts, its test
mode on and a loopback endpoint, so nothing was transmitted.

| Condition                        | Prompt saved locally  | Event on a Shopify skill    | Event on another skill |
| -------------------------------- | --------------------- | --------------------------- | ---------------------- |
| No `jq` on PATH (this machine)   | No                    | Yes, without the prompt     | No                     |
| `jq` on PATH (stand-in used)     | Yes, base64, 0600     | Yes, with up to 2,000 chars | No                     |
| `OPT_OUT_INSTRUMENTATION=true`   | No                    | No                          | Not tested             |
| `DO_NOT_TRACK=1`                 | No                    | Not tested                  | Not tested             |
| `opt-out` file under `%APPDATA%` | No                    | Not tested                  | Not tested             |
| `OPT_OUT_INSTRUMENTATION=1`      | **Yes: not honoured** | Not tested                  | Not tested             |

The opt-out check runs before the script reads its input, so the untested opt-out cells follow from
the code. The only destination in the hook is `https://shopify.dev/mcp/usage`. Installing `jq` for
any reason would turn prompt capture on without further notice.

- **This repository:** patch 02 disables the plugin. The docs state project scope overrides user
  scope and that hooks run where a plugin is enabled, but don't explicitly say a disabled plugin's
  hooks stop. Confirm with `/hooks` after applying. The `env` opt-out is a backstop, and the docs
  don't explicitly say project `env` reaches plugin hooks.
- **Every project, Shopify skills still working:** create an empty `%APPDATA%\shopify-ai-toolkit\opt-out`.
  This is the most reliable option because the script reads it directly. It is user-level, so it is
  left to the owner.

## User-level permissions

`user-settings-hardening.mjs` is a proposal for `~/.claude/settings.json`. It prints the change by
default; `--apply` writes it after saving a backup. Run it only when no other session is open, and
after patch 01, because permission rules match command text and are not a boundary.

```
node docs/security/claude-hardening-2026-11/user-settings-hardening.mjs
node docs/security/claude-hardening-2026-11/user-settings-hardening.mjs --apply
```

It removes stale one-off rules and temporary-folder reads, removes the Stitch `create_project`
allow, and replaces `npm test *`, `npm ci *` and `git fetch *` with narrower forms. It adds nothing
new and doesn't touch `ask` rules. The user level has no `deny` rules at all; patch 02 adds them for
this repository.

## MCP inventory and recommendations

Usage counts come from retained local transcripts, so older use may not appear.

| Server              | Scope     | Tool calls  | Recommendation                                                                                                                |
| ------------------- | --------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Claude in Chrome    | Session   | 1,072       | Keep. It acts with real sign-ins and reads untrusted pages: no production changes, and use an isolated browser for preview QA |
| Stitch              | User      | 0           | Limit it to design work with `/mcp` per project, or remove it. Check how its key is stored; rotation is an owner action       |
| Artifacts           | Session   | 0           | Keep; artifacts start private. Publishing is the external step                                                                |
| Claude Docs         | Connector | Not counted | Keep. Only used when a document is requested                                                                                  |
| VS Code diagnostics | Session   | Not counted | Keep; local                                                                                                                   |
| Shopify plugin      | User      | n/a         | Declares no MCP servers (`.mcp.json` is empty); telemetry above is its only network path found in the hook                    |

No new MCP server was installed. GitHub and PostgreSQL MCPs are not recommended: `gh` and `psql` are
already gated by ask rules, a GitHub server adds a second credential, and anyone can post to this
public repository's issues, which is a prompt-injection route. Avoid the catalog's
`postgresql-integration` and `github-integration` entries in particular: both run packages npm marks
as archived, with no security guarantees.

## Browser testing strategy

| Need                                      | Use                                             |
| ----------------------------------------- | ----------------------------------------------- |
| Regression coverage and CI evidence       | `@playwright/test` and `tests/e2e/`             |
| Agent exploration on local or preview     | Playwright CLI, pinned, from a temporary folder |
| A problem needing the owner's own session | Claude in Chrome, supervised                    |

Pilot of `@playwright/cli` 0.1.23 against a synthetic local page. It has SLSA provenance, and
`npm audit signatures` verified its 3 packages. Installation was 19 MB, with `--ignore-scripts`.

| Check                           | Result                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| Navigation, snapshot            | Pass; about 3.7 s to open                                                                |
| Fill and click                  | Pass; read back "Hello Synthetic User"                                                   |
| Console errors, failed requests | Pass; synthetic error and 404 reported                                                   |
| Screenshot, resize to 375 px    | Pass; mobile layout visible in the screenshot                                            |
| Isolation between sessions      | Pass; a second session could not see the first session's localStorage; profile in memory |
| Resources                       | +8 `chrome.exe` processes and about 460 MB while open; all released on close             |

Three things to know:

- It launches the **installed Chrome** in headless mode by default, not a bundled browser.
- It writes `cli-update-check.json`, `daemon/` and `b/` to the shared `%LOCALAPPDATA%\ms-playwright`
  folder, despite a scratch browser path, and it checks for updates.
- It is pre-1.0, depends on an alpha `playwright-core`, and no guard rule limits which URL it visits.
  Its `run-code`, `cookie-list` and `state-save` commands can read session data.

It complements `@playwright/test` (1.61.1 in this repository) and shouldn't replace it, or be added
to `package.json`. Not tested: an authorized preview deployment, because the pilot used a local page.

## Static analysis decision

| Control                     | Current state (read 2026-11-06)                         |
| --------------------------- | ------------------------------------------------------- |
| Code scanning               | `not-configured`; no analyses                           |
| Dependabot alerts           | Disabled                                                |
| Dependabot security updates | Disabled                                                |
| Dependency update config    | None                                                    |
| Secret scanning             | Enabled, with push protection; gitleaks also runs in CI |
| Dependency audit            | Blocking for production; full report is non-blocking    |
| RLS testing                 | Two CI jobs                                             |

**Choice: CodeQL.** It is GitHub's own tool, needs no new credential or vendor, and its JavaScript/TypeScript and
Actions queries fit this repository. Semgrep CE would add a second rule set and result pipeline with no
gap left to fill at this stage. Patch 03 pins both actions to commit SHAs and runs outside `ci-required`
until its false-positive rate has been reviewed. Fork pull requests are skipped; the push to `main`
covers merged code. Enabling Dependabot alerts is a repository setting, so it is left to the owner.

## Maintenance

- Re-review any version bump before adopting it, as `docs/skills/SKILLS_REGISTRY.md` requires.
- Add a test to `hook-path-hardening.test.ts` for each new guard gap, and confirm that it fails first.
- Don't install from catalogs. Read what a template runs and install from the vendor, pinned.
- Re-check GitHub security settings and the MCP list when this repository's tooling changes.
