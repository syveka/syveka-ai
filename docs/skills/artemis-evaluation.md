# Google ARTEMIS — Evaluation & QA Runbook (dev tool, Stage 1)

Same evaluation format as `docs/skills/chrome-devtools-mcp-evaluation.md`. ARTEMIS is a **local
development/QA tool only**: nothing here is wired into Syveka's application code, CI, or
production, and nothing in this document authorizes pointing it at production or real customer
data.

## What it is

[google/artemis](https://github.com/google/artemis) (Apache-2.0, Python ≥ 3.12) is an LLM-driven
Android automation agent. It drives a real device or emulator over ADB from natural-language
instructions, using the accessibility tree plus screenshots sent to a multimodal model (Gemini,
Claude, OpenAI, OpenRouter, xAI, or a local/vLLM endpoint). Interfaces: CLI (`artemis run`), a web
console (`artemis ui`, port 8000), a Python SDK (`artemis-client`), and a stdio **MCP server**
exposing five tools: `mobile_run_task`, `mobile_manage_task`, `mobile_get_device_state`,
`mobile_inspect_trace`, `mobile_diagnose`.

Two profiles: `flash` (fast reactive loop, ~3–5 s/step, no ADB shell) and `pro` (planner /
operator / checker graph, ~15–40 s/step, includes ADB diagnostics).

## Relevance to Syveka

Syveka is a Next.js web app with no native Android client, so ARTEMIS can only exercise it as
**mobile web in Chrome on Android**. Playwright (`playwright.config.ts`, `tests/e2e/`) remains the
regression suite — it is deterministic, needs no LLM, and already runs mobile viewports. ARTEMIS
earns its place only for what Playwright cannot do well:

- Exploratory, real-device mobile UX passes (soft keyboard overlap, touch targets, scroll traps,
  system dialogs, Android Chrome autofill).
- RTL/multilingual rendering checks on a real Android browser.
- Turning a vague bug report ("the booking page breaks on my phone") into a reproduction with
  screenshots and logcat.

It should not replace or duplicate Playwright assertions for flows that are already reproducible.

## Stage 1 verification results

Upstream commit tested: `351ca8422f7b5b54e80a9c1ce03a222e02415b6b` (main, 2026-09-28). Environment:
ephemeral cloud dev container, Ubuntu 24.04, x86_64, no `/dev/kvm`.

| Phase                                 | Result      | Evidence                                                                                                                                                                                                                                           |
| ------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clone from official repo              | PASS        | `git clone https://github.com/google/artemis`                                                                                                                                                                                                      |
| Python install (`uv sync --dev`)      | PASS        | lockfile install, ~2 min                                                                                                                                                                                                                           |
| ADB                                   | PASS        | Ubuntu `adb` 34.0.4 (`apt-get install adb`); `adb devices` works                                                                                                                                                                                   |
| Upstream deterministic tests          | PASS\*      | 2522 passed, 11 skipped, 0 failed with a placeholder `GEMINI_API_KEY`. Without any key set: 80 failed, all at LLM-client construction (key validation / provider lookup) — an upstream test-isolation gap, not a broken install. No network calls. |
| `artemis doctor`                      | PASS (runs) | Reports two blockers: no LLM API key, no device/emulator                                                                                                                                                                                           |
| MCP server stdio handshake            | PASS        | `initialize` → server `artemis 1.29.0`; `list_tools` → 5 tools; `mobile_diagnose` returns a structured verdict                                                                                                                                     |
| Claude Code MCP registration          | PASS        | `claude mcp add artemis -s local …` → `claude mcp list` shows `√ Connected`                                                                                                                                                                        |
| Emulator / device + UI control        | BLOCKED     | No KVM in the container (emulator cannot run accelerated); `dl.google.com` denied by the environment network policy, so no SDK / emulator / system images                                                                                          |
| Standalone smoke task (`artemis run`) | BLOCKED     | Needs a device and an LLM API key                                                                                                                                                                                                                  |
| Syveka staging synthetic flows        | NOT RUN     | Depends on the two blocked phases above                                                                                                                                                                                                            |

No results for the blocked phases were simulated.

## Security & privacy posture

- **Screenshots and UI text go to the configured LLM provider** on every step. Run it only against
  staging with synthetic tenants/accounts — never real customer data, never production
  (CLAUDE.md §1, §7).
- **On-device helper APK.** The first task installs the "Artemis Accessibility Helper" service.
  Use a dedicated test device or emulator; set `ARTEMIS_HELPER_AUTO_INSTALL=false` on any shared
  device and install explicitly with `artemis helper install`. Remove with
  `artemis helper uninstall`.
- **ADB shell access** in the `pro` profile. Prefer `flash` for routine passes.
- **API keys** live in the ARTEMIS checkout's `.env` (git-ignored upstream) or in the MCP server's
  `env` block. Never in this repository, never pasted into chat.
- **Telemetry:** traces/spans are written locally as JSONL under the ARTEMIS checkout; no remote
  telemetry call was found in the core code (`posthog` is a declared dependency but not imported
  there). Re-check this on each upstream update.
- **`start.sh` is not used** in this runbook: it auto-installs system packages and writes global
  MCP configs/rules into every detected IDE. The manual steps below change less and are reversible.

## How to run ARTEMIS for Syveka QA

Prerequisites on the QA machine (macOS/Linux workstation, not a CI runner): Python 3.12+, `uv`,
Android platform-tools (`adb`), and either Android Studio with an x86_64 AVD (hardware
acceleration required) or a dedicated test phone with USB debugging enabled. `scrcpy` + `ffmpeg`
are optional (screen streaming and replay video).

```bash
# 1. Install outside the Syveka repo
git clone https://github.com/google/artemis.git ~/tools/artemis && cd ~/tools/artemis
uv sync --dev

# 2. Credentials: one multimodal provider key, staging-only budget
cp .env.example .env            # then set e.g. GEMINI_API_KEY=... and
                                # ARTEMIS_HELPER_AUTO_INSTALL=false

# 3. Device
emulator -avd <your_avd> &      # or connect the test phone
adb devices
uv run artemis doctor           # must report no blocking issues
uv run artemis helper install   # explicit, once per device

# 4. Standalone smoke test (no Syveka involved)
uv run artemis run "Open Settings, find Battery and tell me current level" --profile flash

# 5. Register with Claude Code (local scope: not committed to the Syveka repo)
claude mcp add artemis -s local \
  -e PYTHONUNBUFFERED=1 -e PYTHONPATH="$HOME/tools/artemis" \
  -- "$HOME/tools/artemis/.venv/bin/python" -m mcp_server
claude mcp list                 # expect: artemis ... Connected
```

Syveka staging pass (synthetic data only). Example prompt to Claude Code with ARTEMIS connected:

> Using ARTEMIS (flash profile), open Chrome on the connected device, go to `<staging URL>`, sign in
> with the synthetic QA account, open the calendar booking page, and report layout problems,
> console-visible errors, and screenshots. Do not submit payments or send messages to real
> contacts.

Keep tasks read-mostly; anything that sends email/SMS/WhatsApp, charges Stripe, or calls a paid AI
provider from staging still needs a human to approve that specific run.

## Rollback

- Claude Code: `claude mcp remove artemis -s local`
- Device: `uv run artemis helper uninstall`
- Tool: delete the ARTEMIS checkout directory (its `.venv` and traces live inside it).

## Stage 2 readiness

Ready: install path, test baseline, MCP integration, and this runbook. Needed before Stage 2
(device control and staging flows):

1. A machine with Android emulator acceleration (KVM / Hypervisor.framework) or a dedicated test
   phone. A cloud dev container without `/dev/kvm` cannot do this; allowing `dl.google.com` in the
   environment network policy would fix SDK downloads but not the missing KVM.
2. A staging-only LLM provider key with a spend cap.
3. A synthetic QA tenant and account on staging, and the staging URL/access method (including any
   Vercel deployment-protection bypass) supplied to the operator outside this repo.
4. A decision on whether ARTEMIS gets a `syveka-skills` registry entry (not done here — out of
   scope for Stage 1).
