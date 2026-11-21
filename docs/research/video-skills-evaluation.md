# Video skills evaluation: xilo-opus-video, HyperFrames, mg-styles-15, lemo-opuscar

Research and local-test report for Syveka Creator Studio. **No product code changed. Nothing was
installed globally, deployed, committed or pushed, and no paid API was called.**

|                                |                                                                                                                                                                                                                                    |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Date                           | 2026-11-01                                                                                                                                                                                                                         |
| Repository / worktree          | `syveka/syveka-ai`, worktree `syveka-claude-eng-system`                                                                                                                                                                            |
| Branch / HEAD at start and end | `chore/writer-agents-no-bash` @ `41d766f9984dcd96a5a43c77bfa643828cc20fab` (clean apart from this report)                                                                                                                          |
| Machine                        | Windows 11 Pro, AMD Ryzen 5 PRO 4650U (6C/12T), 15.2 GB RAM, integrated Radeon GPU                                                                                                                                                 |
| Toolchain                      | Node v22.23.2, npm 10.9.8, pnpm not installed, Python 3.11.9 (`python3` not on PATH), Git 2.55, Claude Code 2.1.309, Chrome and Edge installed, Playwright browsers cached. **No FFmpeg on PATH**: a portable build was used (§14) |
| Existing Claude config         | `.claude/` holds 8 agents, 12 skills, 3 guard hooks and `settings.json`. No `.mcp.json`, no plugins in the repo, no video tooling in the repo. Creator Studio's generation path is fal.ai (FLUX images, Kling video)               |

---

## 1. Executive verdict

- **HyperFrames is the only one of the four that is a rendering _platform_ rather than a prompt
  library.** It renders deterministic HTML-to-MP4 from a CLI or Node API. It has typed template
  variables and **batch rendering**: one template plus JSON rows gives one MP4 per row. It has a QA
  gate (lint, runtime errors, WCAG contrast, layout overflow, social first-frame check) and
  self-hostable distributed rendering on AWS Lambda and Google Cloud Run. It is Apache-2.0 and backed
  by HeyGen. It rendered the 9:16 benchmark in EN, AR and FI from **one** template with no code
  changes. **Recommendation: PILOT, with hard containment** (§2, §13). It reads other tools'
  credentials in one command, sends telemetry unless opted out, and fetches GSAP and fonts from the
  network.
- **The other three overlap with HyperFrames.** Each is "Claude writes a web page with `render(t)`,
  headless Chrome screenshots every frame, FFmpeg encodes." What they add is _style knowledge_
  (prompts, art direction), not infrastructure Syveka can build on. None has template variables or
  batch rendering, and none has a scalable rendering story.
- **Economics hold up, but only with templates.** A 10-second 1080×1920 template render cost an
  estimated **< US$0.01 of compute**. A generated clip of the same length costs **US$0.50–4.00**
  (verified list prices, §9). The saving disappears if Claude authors each video from scratch: that
  workflow costs 30–60 minutes and many tokens per film, by lemo-opuscar's own README. The win is
  _author a template once, render it many times_.

## 2. Source verification

All four were checked against GitHub's API, the owner profile, the repository contents and (for npm)
the registry, independently of the identifiers given in the brief.

| Tool            | Canonical source (pinned SHA tested)                                       | Owner                                                                                                                | License                              | Activity                                                 | Install mechanism                                                                                        | SKILL.md                            | Confidence                                                                                                                                  |
| --------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| xilo-opus-video | `github.com/Kianzzz/xilo-opus-video` @ `f2cd828`                           | user "xilo" (17 followers, account from 2023)                                                                        | MIT                                  | Created 2026-09-28; one push that day, nothing since     | Copy `skills/xilo-opus-video` into `~/.claude/skills` or `npx skills add`                                | Yes                                 | **LIKELY**: the repo matches the identifier and its description; it is a single-author, one-day-old project with no independent attestation |
| HyperFrames     | `github.com/heygen-com/hyperframes` @ `8a0b8a9`; npm `hyperframes@0.8.225` | `heygen-com` org ("HeyGen", 2020); npm maintainers include a `@heygen.com` address; docs on `hyperframes.heygen.com` | Apache-2.0                           | Pushed 2026-10-31; 76.5k stars; npm release the same day | Claude plugin (`claude plugin marketplace add heygen-com/hyperframes`), `npx skills add`, or the npm CLI | Yes (7 published + 6 repo-internal) | **VERIFIED**                                                                                                                                |
| mg-styles-15    | `github.com/Vincentwei1021/mg-styles-15` @ `49052d8`                       | user "Yihao" (account from 2016, 691 followers)                                                                      | MIT (third-party assets CC0/OFL/BSD) | Created 2026-10-02, last push 2026-10-05                 | **None.** It is a gallery: prompts, demo sources and a renderer you point an agent at                    | **No**                              | **LIKELY**: no identifier was given; this is the original, and every fork found names it as upstream                                        |
| lemo-opuscar    | `github.com/lemomo-ai/lemo-opuscar` @ `bebbbe1`                            | user "Lemomo" (account from 2022, 513 followers)                                                                     | MIT                                  | Pushed 2026-10-31; 10.1k stars                           | Claude plugin marketplace (`lemolab`), whose `setup.sh` clones the library into `~/lemo-opuscar`         | Yes (plugin skill)                  | **LIKELY**                                                                                                                                  |

## 3. Security audit

The audit method was the same for each repo. It was shallow-cloned into an isolated scratch
directory with nothing executed. I read every script it ships and grepped for network,
subprocess, environment-variable and credential access, deletion, obfuscation, lifecycle scripts and
instruction-override text. Skill and agent documents were treated as untrusted input; none of them
tried to override this mission or Claude's safety rules.

### xilo-opus-video: risk LOW

- 4 small, readable Python scripts (`render.py` is 95 lines). They make no network calls and read no
  environment variables or credentials. Subprocesses are argv lists, with no `shell=True`, running
  only `ffmpeg` and `ffprobe`. Nothing is deleted.
- Chrome launches with `--enable-unsafe-swiftshader` (a software WebGL fallback); the Chrome sandbox
  stays on.
- SKILL.md tells the agent to _ask before installing dependencies_ and _ask before downloading_ a
  reference video. One reference doc tells the agent to `npx skills add heygen-com/hyperframes` if
  the user names HyperFrames.

### HyperFrames: risk MEDIUM (usable only when contained)

The code quality is high and there are no install-time scripts in its own package. The single
lifecycle script in the dependency tree is esbuild's standard `postinstall`, which was skipped with
`--ignore-scripts` and the CLI still worked. Findings, from most to least serious:

1. **It reads other AI tools' credentials.** `hyperframes usage`
   (`dist/usage-*.js`, `readClaudeCandidates`/`readOtherHarness`) reads:
   - the **Claude Code OAuth access token** from `~/.claude/.credentials.json` (or the macOS
     Keychain entry `Claude Code-credentials`);
   - the Codex token from `~/.codex/auth.json`;
   - the Grok token from `~/.grok/auth.json`.

   It sends each token, as a bearer token, to the vendor that issued it, to read your remaining
   subscription quota: `api.anthropic.com/api/oauth/usage`, `chatgpt.com/backend-api/wham/usage`,
   `cli-chat-proxy.grok.com`. Redirects are refused, and the code does not forward tokens or results
   to HeyGen or telemetry. **The core SKILL.md tells agents to run `npx hyperframes usage --json` at
   the start of every new video.** This is not exfiltration, but it is credential access far outside
   a video renderer's job. The command was **not run** in this evaluation.

2. **Telemetry is on by default** (PostHog, opt-out). Each event carries the CLI version, OS, CPU
   model and count, RAM, CI/Docker/WSL flags, the detected agent runtime, an anonymous install ID and,
   if you are signed in, your HeyGen username. It is turned off by `HYPERFRAMES_NO_TELEMETRY=1` or
   `DO_NOT_TRACK=1`; both were set for every command here. Even with telemetry off, the CLI writes
   `~/.hyperframes/config.json` (an anonymous ID, `telemetryEnabled: true` as the stored preference)
   and runs an update check.
3. **It fetches over the network at render time.** The scaffolded template loads GSAP
   `3.15.0` from `cdn.jsdelivr.net` (version-pinned, no SRI hash), and fonts (Inter, Roboto) are
   downloaded into `~/.cache/hyperframes/fonts`. Production rendering must vendor both and run with
   the network off.
4. **Commercial steering and HeyGen cloud paths.** The skills prompt agents to promote the desktop
   app, `publish` (uploads a project to a URL), `cloud` (HeyGen-hosted rendering), `auth` (HeyGen
   sign-in) and `/media-use` (HeyGen avatars and voices, paid). It also includes an "image upsell"
   that drives the user's Codex CLI and ChatGPT subscription. None of these may touch tenant data
   without a DPA and an explicit decision. All of them should be blocked in any Syveka use.
5. **It writes to the home directory and agent configs.** `init` installs skills into agent
   directories unless `--skip-skills` or `HYPERFRAMES_SKIP_SKILLS=1` is set, and drops its own
   `CLAUDE.md`/`AGENTS.md` into each project. The skills lifecycle knows the config locations of
   Claude, Codex and four other agents.
6. **Supply-chain cadence.** The CLI is at `0.8.225` with releases several times a day, and its
   dependencies use caret ranges. Pin an exact version and lockfile, and review upgrades
   deliberately.
7. **GSAP license.** GSAP is free for commercial use under Webflow's "Standard No Charge" license,
   but that license **prohibits** use in tools that let users build visual animations without code
   in competition with Webflow. A future no-code template editor in Creator Studio needs legal
   review against that clause.

### mg-styles-15: risk MEDIUM as a runnable tool, LOW as reading material

- It is not an installable skill. The risk comes only from running its harness (`harness/render.mjs`)
  or the 62 Python asset and audio scripts.
- On every non-macOS platform the harness launches Chrome with **`--no-sandbox`** plus Linux EGL
  flags. It hardcodes a machine-wide lock directory at `/tmp/mg-render-slots`, which is `C:\tmp`
  on Windows. Its static server sends `Access-Control-Allow-Origin: *` with no Host check, but is
  bound to 127.0.0.1.
- npm dependencies are exact-pinned. The full Python requirements include heavy native packages
  (`opencv-python`, `rembg`, `numba`, `librosa`, `pedalboard`), and `rembg` downloads ML models at
  runtime.
- For the benchmark I ran a **copy** of the harness: the lock directory was moved into scratch and
  the default Chrome flags were replaced through its own `MG_GPU_ARGS` variable, so the sandbox
  stayed on (§14).

### lemo-opuscar: risk MEDIUM

- The code is security-conscious:
  - downloads are SHA-256 checked;
  - tar extraction is guarded against path traversal;
  - the static server is localhost-only and checks the Host header against DNS rebinding;
  - it never auto-installs system software;
  - it has a security policy that names exactly what may leave the machine.
- **It updates itself from upstream on every run.** The plugin's `setup.sh` clones the library into
  `~/lemo-opuscar` (outside the project) and, on every later run, does
  `git fetch --depth 1 origin main && git reset --hard FETCH_HEAD`. The code _and the agent
  instructions_ (`AGENTS.md`, `DIRECTOR.md`, every `STYLE.md`) are re-pulled unpinned from `main`
  each time. That is a standing remote-instruction and supply-chain channel.
- Python dependencies are unpinned. The voice tier uses `edge-tts`, which **sends narration text to
  Microsoft's online speech service**, and the `faster-whisper` model download goes to Hugging Face.
- `setup.sh` is POSIX `sh` and uses `.venv/bin/python`, so on Windows it needs Git Bash and breaks on
  the venv path. For the benchmark I skipped `setup.sh` entirely: I ran the pinned clone with its
  lockfile installed via `npm ci --ignore-scripts` and pointed it at the system Chrome.

## 4. Dependency analysis

| Tool            | Runtime                     | Node deps (direct)                                                                                                              | Python deps                                      | Native / binaries                                                   | Browser                                                                             | External services                                                                                                         |
| --------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| xilo-opus-video | Python 3.9+                 | none                                                                                                                            | `numpy`, `playwright` (unpinned)                 | FFmpeg                                                              | Playwright Chromium, or installed Chrome/Edge                                       | none required; optional voice models                                                                                      |
| HyperFrames     | Node ≥ 22                   | 17 runtime deps incl. `puppeteer-core`, `hono`, `esbuild`, `adm-zip`, `giget`, `open`; optional `sharp` (77 packages installed) | none for rendering                               | FFmpeg; esbuild binary                                              | Downloads Chrome via `@puppeteer/browsers` unless `HYPERFRAMES_BROWSER_PATH` is set | GSAP CDN, font downloads, PostHog telemetry, registry on raw.githubusercontent.com; optional HeyGen cloud, auth and media |
| mg-styles-15    | Node ≥ 22.12, Python ≥ 3.11 | 6, exact-pinned (`puppeteer-core`, `three`, `d3`, …)                                                                            | 15 pinned, several heavy/native                  | FFmpeg; Blender for one style                                       | Installed Chrome (`MG_CHROME`)                                                      | none for rendering; `rembg` model download for asset prep                                                                 |
| lemo-opuscar    | Node ≥ 20, Python ≥ 3.11    | 2 (`playwright-core`, `three`; lockfile)                                                                                        | 6 core, unpinned; voice and music tiers optional | FFmpeg ≥ 7; Kokoro ONNX model (350 MB); sample packs (up to 1.4 GB) | Playwright headless-shell (downloaded), or `PLAYWRIGHT_CHROME`                      | GitHub (library and asset packs), Microsoft edge-tts (optional), Hugging Face (optional)                                  |

## 5. Practical benchmark results

**The ad:** fictional, 9:16, 1080×1920, 30 fps, 10 s (300 frames). Copy is
`SYVEKA / Your AI Business Operator / Automate. Create. Grow. / syveka.com`, with the Arabic variant
`مشغّل أعمالك بالذكاء الاصطناعي / أنشئ. أتمت. انمُ.`. Assets are CSS gradients and system or bundled
fonts only. No audio, no paid calls, no customer assets.

**Method:** one deterministic scene (`bench/shared/index.html`) satisfies all three page contracts:
xilo `render(t)`, mg-styles `renderAt(t)`/`__ready`, and lemo `render(t)`/`READY`/`DUR`. So xilo,
mg-styles and lemo are compared on **identical** content, which isolates the render pipeline.
HyperFrames' contract is different (a GSAP timeline plus `data-*` clips), so it got a native port of
the same ad, with the copy and language as typed composition variables.

**Limitation:** I did not run each skill's full agentic _authoring_ workflow end to end. That is
xilo's "three plans → previews → brief", lemo's treatment and director workflow, and HyperFrames'
story/spec/review loop. That costs tens of minutes and many tokens per film, and it would mostly
measure the model, not the tool. Visual style quality across the tools' style libraries is judged
from their published sources and demos, not from new renders.

### Results (all outputs are valid H.264 yuv420p, 1080×1920, 30 fps, 300 frames, 10.000 s)

| Tool                  | Render, 1 worker (EN / AR)                                                       | Parallel                 | Size (EN)       | Capture                      | Encode                         | Setup difficulty                                                              | Result     |
| --------------------- | -------------------------------------------------------------------------------- | ------------------------ | --------------- | ---------------------------- | ------------------------------ | ----------------------------------------------------------------------------- | ---------- |
| xilo-opus-video       | 159.7 s / 156.1 s                                                                | not supported            | 3.48 MB         | PNG, Python Playwright, sync | x264 CRF 16, streamed          | Low (pip ×2 + FFmpeg)                                                         | ✅         |
| mg-styles-15          | 73.2 s / 64.0 s (46 s / 37 s capture)                                            | 4 workers: 46.9 s        | 4.58 MB         | PNG, puppeteer               | x264 CRF 14                    | Medium (Mac-centric; needed 2 env overrides and a lock-path patch on Windows) | ✅         |
| lemo-opuscar          | 26 s / 25 s                                                                      | 4 workers: 17 s          | 6.58 MB         | JPEG q95, Playwright         | x264 CRF 14, parallel segments | Medium (sh setup unusable on Windows; ran the clone directly)                 | ✅ fastest |
| HyperFrames           | 45.5 s / 42.6 s                                                                  | auto (5 workers): 30.9 s | 2.82 MB         | screenshot, hardware GPU     | x264 CRF 16 during capture     | Low (one npm package + FFmpeg; `check` gate built in)                         | ✅         |
| HyperFrames `--batch` | 3 variants (EN, FI, AR) from one template in **94 s** wall, with a JSON manifest |                          | 2.8–2.9 MB each |                              |                                |                                                                               | ✅         |

**CPU and RAM:** 12 threads on a mobile 15 W CPU. I did not profile them; HyperFrames documents
about 256 MB per worker. All renders completed without memory pressure on 15 GB.

**Arabic / RTL:** correct in **all four** pipelines. Glyphs join properly, the shadda (ّ) and
damma (ُ) are positioned correctly, lines run right to left, and the trailing full stop sits at the
visual left. There are two prerequisites, and they apply to every tool:

1. **Never split Arabic into per-letter spans** for letter-stagger animation; it breaks cursive
   joining. Animate words or lines.
2. **Ship the Arabic font.** HyperFrames only resolves bundled fonts by name, so it ignored the
   system Segoe UI and fell back to a different Arabic face. Production needs `@font-face` with a
   bundled Noto Sans/Kufi Arabic (OFL) everywhere. Server renders must not depend on
   Windows-specific fonts.

Finnish (`Tekoälyllä toimiva liiketoimintaoperaattorisi`) wrapped cleanly via the batch row.

### Qualitative scores (1–5)

|                                                           | xilo              | mg-styles-15 | lemo                       | HyperFrames                                                |
| --------------------------------------------------------- | ----------------- | ------------ | -------------------------- | ---------------------------------------------------------- |
| Visual / animation quality ceiling (from published demos) | 4                 | 5            | 5                          | 4                                                          |
| Customization difficulty (lower is easier)                | 3                 | 4            | 4                          | 2                                                          |
| Template reusability                                      | 2                 | 2            | 3 (style library)          | 5 (typed variables, batch, registry)                       |
| Automation potential                                      | 2                 | 2            | 2                          | 5 (CLI and Node API, JSON output, batch, Lambda/Cloud Run) |
| Built-in QA                                               | 1 (manual stills) | 1            | 3 (`readcheck`, ASR check) | 5 (`check`: lint, runtime, layout, WCAG, craft)            |
| Developer complexity (lower is simpler)                   | 1                 | 4            | 4                          | 3                                                          |

## 6. Output locations

These are session scratch files: temporary, but kept as evidence (§15). The base path is
`C:\Users\lenovo\AppData\Local\Temp\claude\c--Users-lenovo-Desktop-syveka-claude-eng-system\211818f8-a0c6-4073-b2e1-f1ea51b60c2c\scratchpad\`.

- `bench\out\sheets\compare_t8.6.png`: a frame at t = 8.6 s from every tool, EN on the top row and
  AR below; columns are xilo, mg-styles-15, lemo, HyperFrames.
- `bench\out\sheets\hf_batch_fi_t8.6.png`: the Finnish batch row.
- `bench\out\sheets\hf_en_timeline.png`: six-frame timeline strip.
- `bench\out\{xilo,mg,lemo,hf}\*.mp4` and `bench\out\hf\batch\syveka-{0,1,2}.mp4` plus
  `manifest.json`: every rendered video.
- `bench\shared\index.html` (the shared scene) and `bench\hf\syveka\index.html` (the HyperFrames
  template), for reproduction.

## 7. Comparison matrix

|                                | xilo-opus-video                                   | HyperFrames                                                              | mg-styles-15                                                     | lemo-opuscar                                                         |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| Source confidence              | LIKELY                                            | VERIFIED                                                                 | LIKELY                                                           | LIKELY                                                               |
| Security risk                  | LOW                                               | MEDIUM (contain)                                                         | MEDIUM (run) / LOW (read)                                        | MEDIUM                                                               |
| Claude Code integration        | Skill                                             | Plugin + 7 skills                                                        | None (prompts to paste)                                          | Plugin + skill                                                       |
| Installation difficulty        | Low                                               | Low                                                                      | Medium–high                                                      | Medium (Windows: high)                                               |
| Rendering approach             | HTML/Canvas/WebGL/Three → Playwright PNG → FFmpeg | HTML + GSAP (plus Lottie/Three/canvas) → puppeteer → FFmpeg              | HTML/SVG/Canvas/WebGL/Three (+ Blender) → puppeteer PNG → FFmpeg | HTML/Canvas/Three → Playwright JPEG → FFmpeg; code-synthesized audio |
| Video quality                  | Good (model-dependent)                            | Good; strong motion library (≈450 registry blocks)                       | Excellent demos (hand-iterated)                                  | Excellent demos (66 styles)                                          |
| Rendering speed (this test)    | Slowest (≈160 s)                                  | Mid (31–46 s)                                                            | Mid (47–73 s)                                                    | Fastest (17–27 s)                                                    |
| Template capability            | Reusable `brief.md` prompt                        | **Typed variables, batch, registry blocks**                              | Prompt template                                                  | Style prompts, "my styles"                                           |
| 9:16 support                   | Yes                                               | Yes (`--resolution portrait`)                                            | Yes (one demo is 9:16)                                           | Yes (`--size`)                                                       |
| Arabic / RTL                   | Correct (via Chrome)                              | Correct; needs bundled font                                              | Correct (via Chrome)                                             | Correct (via Chrome)                                                 |
| External API dependency        | None                                              | None required; telemetry, CDN, fonts and HeyGen upsells must be disabled | None                                                             | None required; edge-tts optional (online)                            |
| Estimated marginal render cost | ≈ $0.01–0.02 compute (slow pipeline)              | < $0.01 compute                                                          | < $0.01 compute                                                  | < $0.01 compute                                                      |
| Automation potential           | Low                                               | **High**                                                                 | Low                                                              | Low–medium                                                           |
| Syveka integration complexity  | n/a (no engine)                                   | Medium (render worker + template registry)                               | n/a                                                              | High (artisanal workflow, home-dir library)                          |
| Maintenance risk               | High (single author, dormant after day 1)         | Medium (very fast releases; vendor upsell drift)                         | High (gallery, dormant since 10-05)                              | Medium (active; self-updating)                                       |
| Best use case                  | The planning pattern: 3 options → preview → brief | Template-driven, multilingual social and ad videos at scale              | Style reference and prompt material                              | Style reference; one-off, high-craft brand films                     |
| **Recommendation**             | **REJECT** (as a dependency)                      | **PILOT**                                                                | **REJECT** (as a tool)                                           | **WATCH**                                                            |

**Overlap.** All four use the same core technique: a deterministic web page drawn at time t, frame
capture, then FFmpeg. Syveka should standardize on **one** engine, and HyperFrames is the only one
built for programmatic use: variables, batch, a Node API, QA, and self-hostable distributed
rendering. xilo itself delegates to HyperFrames when HyperFrames is requested. lemo's and
mg-styles-15's value is their **style prompts and art direction** (MIT). That can be distilled into
Syveka-owned HyperFrames templates without taking a runtime dependency on either repo.

## 8. Syveka Creator Studio fit

| Need                                                        | Deterministic layer (HyperFrames)                    | Needs generative video                                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Captions, kinetic typography, brand intros and outros, CTAs | ✅ Native                                            | ✗                                                                                                            |
| Product / e-commerce creatives from product photos          | ✅ Ken-Burns moves, cut-outs, price cards, carousels | Only for photoreal motion of the product                                                                     |
| Reusable campaign templates, A/B and language variants      | ✅ `--variables` / `--batch`                         | ✗                                                                                                            |
| FI / EN / AR, RTL                                           | ✅ Proven in this test (needs bundled fonts)         | Partial: models garble rendered text                                                                         |
| Persistent brand character                                  | Partial: illustrated or vector mascots               | ✅ Photoreal or 3D characters (Kling image-to-video)                                                         |
| Talking head / avatar                                       | Composition around an existing clip only             | ✅                                                                                                           |
| Image → video, text → video "footage"                       | ✗                                                    | ✅                                                                                                           |
| Automated, scalable, predictable cost                       | ✅ CPU-bound, deterministic, re-renderable           | Per-second vendor pricing, non-deterministic, ~70 s+ latency per clip (measured in `docs/creator-studio.md`) |

The strongest pattern is **hybrid compositing**. Generate one short hero clip with Kling, then
compose it inside a HyperFrames template that carries brand, captions, CTA and language. N language
or format variants then cost **one** generative call plus N cheap renders.

## 9. Cost implications

| Item                                                                        | Cost                                                                                                                                                                                      | Status                                                                              |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Kling 2.1 Standard image-to-video on fal (Creator Studio's current default) | $0.25 per 5 s, +$0.05/s, so **$0.50 per 10 s** (page README); the playground shows $0.28 + $0.056/s. **fal flags this endpoint as deprecated**                                            | VERIFIED (fal model page, 2026-11-01; two figures on the page conflict)             |
| Runway API `gen4_turbo`                                                     | 5 credits/s × $0.01 = **$0.05/s, so $0.50 per 10 s**                                                                                                                                      | VERIFIED (docs.dev.runwayml.com/guides/pricing)                                     |
| Runway API `gen4.5`                                                         | 12 credits/s, so **$1.20 per 10 s**                                                                                                                                                       | VERIFIED (same page)                                                                |
| Veo 3.1 via Runway API                                                      | $0.20/s without audio, $0.40/s with audio, so **$2.00–4.00 per 10 s**; Fast $0.10–0.15/s                                                                                                  | VERIFIED (same page)                                                                |
| Veo direct (Google)                                                         | Google Cloud's page lists Veo 3 per "count" ($0.20–0.40); developer-forum reports conflict on per-second vs per-video billing                                                             | **UNKNOWN**: confirm on the live Gemini API / Vertex pricing pages before budgeting |
| Kling direct (Kling API)                                                    | Unit-based prepaid packages; the published per-unit figures are inconsistent across their pages                                                                                           | **UNKNOWN**                                                                         |
| Deterministic render, 10 s 1080×1920                                        | Measured 31 s on 12 threads, so about 0.1 vCPU-hour. Assuming general-purpose cloud compute at roughly $0.04–0.05 per vCPU-hour, that is **≈ $0.005 per render**, plus storage and egress | ESTIMATED (the compute rate is an assumption, not a quote)                          |
| LLM authoring cost per video                                                | Template reuse: ≈ 0 (the LLM only fills a JSON variable schema). Bespoke per-video authoring with these skills: large (30–60 min of agent time per film, per lemo's README)               | UNKNOWN (not measured)                                                              |

**Conclusion.** For templated content, deterministic rendering is roughly **2 orders of magnitude
cheaper** per clip than generative video, and it gives byte-predictable, re-renderable, text-exact
output. Generative video stays necessary for photoreal footage, characters in motion, avatars and
lip-sync.

| Workload                                                                                                                                                                                        | Engine                                 |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Captions, typography, brand intros and outros, CTA end cards, price and offer cards, product slideshows, data and stat videos, language and format variants, Reels/Shorts/TikTok text-led posts | **Deterministic**                      |
| Photoreal scenes, persistent character in motion, product-in-use footage, talking heads and avatars                                                                                             | **Generative**                         |
| Generated hero clip plus captions, brand and CTA, multilingual versions                                                                                                                         | **Hybrid** (one generation, N renders) |

## 10. Recommended architecture

This is a proposal only. Nothing was implemented, and implementing it needs separate authorization
(charter §2 and §5).

```text
Creator Studio (server-verified org context, §4)
   │
Content Planner (LLM) ── picks template + fills its typed variable schema (validated JSON)
   │                      or requests a generative clip; never writes free-form render code in prod
Render Router (credits via getCreatorGenerationCreditCost — new low-cost "template render" type)
   ├── Deterministic Render Worker   ← NOT a Vercel function (Chrome + FFmpeg, minutes, CPU-heavy)
   │     container: pinned hyperframes, vendored GSAP + fonts (Noto Arabic/Inter), network OFF,
   │     telemetry OFF, `usage|auth|cloud|publish|skills|media-use` unreachable;
   │     inputs via short-lived signed URLs; output re-uploaded to the org's storage path;
   │     queue via existing QStash; scale via self-hosted Cloud Run / Lambda adapters if needed
   │     └── Syveka template registry (versioned in repo, reviewed like code; lint + check in CI)
   └── Generative Video Router (existing CreatorMediaProvider: fal/Kling today; Veo/Runway as adapters)
         └── its clip can be fed back into a template as a <video> layer (hybrid)
```

Why this shape:

- It is **provider-agnostic**. The template contract (HTML plus typed variables) is open, and the
  engine sits behind a `CreatorRenderProvider`-style interface, so HyperFrames can be replaced later
  (by lemo's renderer, Remotion, or an in-house Playwright harness) without touching business logic.
- It **fails closed**. A render failure releases the reserved credits, following the existing
  pattern.
- It **fits the charter's AI rules**. Templates are reviewed, versioned artifacts, not hardcoded
  prompts, and LLM output is constrained to a validated schema.

**Alternatives considered:**

- **Remotion.** A mature React video framework, but it needs a commercial company license above a
  small team size, and it is React-component authoring rather than plain HTML.
- **An in-house Playwright plus FFmpeg harness.** Each of the three smaller tools is effectively
  under 300 lines of this. It is simplest to own, but it lacks variables, batch, QA and the motion
  library.
- **HyperFrames.** It wins the pilot on capabilities, provided its network, credential and upsell
  surfaces are contained.

## 11. What to adopt

Nothing is adopted into production yet.

- **PILOT HyperFrames** as the deterministic engine, in a contained render worker (§10, §17).
- **Borrow, don't install:**
  - xilo's planning UX ("3 distinct options → preview frame → confirmed brief") for the Content
    Planner;
  - lemo's and mg-styles-15's style prompts and art-direction notes (MIT) as source material for
    Syveka-owned templates, with attribution.

## 12. What to reject

- **xilo-opus-video as a dependency.** It duplicates HyperFrames, is the slowest pipeline,
  single-author and dormant, and has no template or batch capability.
- **mg-styles-15 as a tool.** It is not a skill, its harness is Mac-centric and disables the Chrome
  sandbox off macOS, and it is a dormant gallery. It stays useful as reading material.
- **Inside HyperFrames:** `usage`, `auth`, `cloud`, `publish`, `skills`/`init` skill installs,
  `/media-use` HeyGen and Codex paths, the desktop-app "Framey" flows, and CDN or font fetches at
  render time.

## 13. What needs more testing

1. A Linux container render worker: fonts, GPU vs SwiftShader, Chrome version pinning, throughput,
   and peak memory per worker.
2. HyperFrames with **network disabled**: vendored GSAP and fonts, and confirming no other runtime
   fetches happen (registry, update check).
3. A hybrid composition with a real generated clip and an audio track (music, voiceover,
   `normalize-audio`), and caption timing from `transcribe`.
4. 1:1 and 16:9 versions of the same template, and long Finnish compounds and Arabic with mixed
   Latin/numerals (bidi) in narrow layouts.
5. Legal: the GSAP "Prohibited Uses" clause vs a future no-code template editor; HyperFrames
   Apache-2.0 NOTICE obligations; licences of any registry blocks and fonts used.
6. lemo-opuscar (WATCH): re-check in about 3 months whether it gains pinned releases and a
   non-self-updating install. Its renderer was the fastest here.

## 14. Exact changes made to the machine and repository

**Repository:** one new untracked file, this report (`docs/research/video-skills-evaluation.md`).
There were no other changes, no commits, no pushes, no branch changes, and no dependency changes to
`package.json` or the lockfile.

**Home directory** (created during this session):

- `~/.hyperframes/` (config with an anonymous ID, `install-state.json`, `running/`) from the
  HyperFrames CLI.
- `~/.cache/hyperframes/` (2.6 MB of downloaded fonts and render history) from the HyperFrames
  CLI.
- **Not** touched or created: `~/lemo-opuscar`, `~/.lemo-opuscar`, `~/lemo-my-styles`,
  `C:\tmp\mg-render-slots`, `~/.claude/skills/*`, `~/.agents`, `~/.codex`. `~/.cache/puppeteer` and
  `~/.agents` predate this session (August and September 2026). `~/.codex` changed during the
  session, but from the user's running `codex.exe` processes (state DB, WAL, model cache), not from
  this evaluation; the `hyperframes usage` command that reads `~/.codex/auth.json` was never run.

**Session scratch directory** (`…\scratchpad\`, outside the repository):

| Path                                                                | What                                                                                                                                                                                                         | Size     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| `untrusted\{xilo-opus-video,hyperframes,mg-styles-15,lemo-opuscar}` | Shallow clones at the pinned SHAs. Local git config `core.longpaths=true` was set on the HyperFrames clone only. lemo has `npm ci --ignore-scripts` node_modules (`playwright-core` 1.63.0, `three` 0.170.0) | ≈ 2.5 GB |
| `tools\ffmpeg-dl\`                                                  | BtbN FFmpeg n8.1 win64 GPL zip plus `checksums.sha256` (SHA-256 `10f00905…4817`, verified)                                                                                                                   | 194 MB   |
| `tools\ffmpeg\`                                                     | The extracted portable FFmpeg 8.1.3, never added to the system PATH, only to individual commands' environment                                                                                                | ≈ 500 MB |
| `tools\pyvenv\`                                                     | Python venv: numpy 2.4.6, playwright 1.64.1 (uses the installed Chrome)                                                                                                                                      | ≈ 150 MB |
| `tools\hf\`                                                         | `hyperframes@0.8.225`, `npm install --ignore-scripts --save-exact`                                                                                                                                           | ≈ 100 MB |
| `bench\`                                                            | Benchmark sources, the patched copy of mg's `render.mjs`, `puppeteer-core@25.12.0`, the HyperFrames project and all outputs                                                                                  | ≈ 80 MB  |

**System:** no global npm or pip installs, no PATH or registry changes, no services, no downloaded
browsers (system Chrome used throughout).

**Guardrails:** the repo's command guard blocked an attempt to set `core.hooksPath` on a clone,
which was unnecessary anyway since remote hooks are never cloned. It also blocked a broad grep that
matched its environment-dump pattern. Both were handled by using a different, safe command. No
guardrail was bypassed or weakened.

## 15. Cleanup status

| Item                                                                                       | Classification                                                | Status                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `untrusted\*` clones (2.5 GB), `tools\ffmpeg-dl\` zip                                      | REMOVE RECOMMENDED (sources pinned by SHA above; re-clonable) | **Removed**                                                                  |
| `~/.hyperframes/`, `~/.cache/hyperframes/`                                                 | REMOVE RECOMMENDED (created by this test)                     | **Removed**                                                                  |
| `bench\out\**` (videos, contact sheets, batch manifest), `bench\shared`, `bench\hf\syveka` | KEEP (evidence and reproduction)                              | Kept in session scratch (temporary by nature)                                |
| `tools\ffmpeg`, `tools\pyvenv`, `tools\hf`, `bench\mg`, `bench\lemo`                       | TEMPORARY (needed only to re-run the benchmark)               | Kept in session scratch; delete the `scratchpad` folder to remove everything |
| This report                                                                                | KEEP RECOMMENDED                                              | Untracked in the worktree; not committed                                     |

## 16. Blockers requiring human action

There are no blockers. Every phase that could run safely ran. The following decisions belong to you:

1. **Where this report lives.** It is untracked on the unrelated branch
   `chore/writer-agents-no-bash`. If you want it kept, it should be committed on a dedicated
   `docs/` branch from `origin/main` and go through a PR.
2. **Legal review** of the GSAP Standard No Charge license's "Prohibited Uses" clause before any
   user-facing template editor.
3. **Authorization** for the pilot in §17, a new task with its own branch, scope and PR.

## 17. Proposed next implementation step

This needs separate authorization. Run a **time-boxed HyperFrames render-worker spike outside the
product code** (for example `spikes/render-worker/` on its own branch, not wired into Creator
Studio):

- A Linux container with pinned `hyperframes@0.8.225`, vendored GSAP and Noto Sans Arabic/Inter,
  telemetry off, network disabled at render time, and the CLI wrapped so only `check` and `render`
  are callable.
- Three Syveka templates (text-led Reel, product card, hybrid with a placeholder clip), each
  rendered in FI/EN/AR at 9:16, 1:1 and 16:9 from JSON.
- The output is a measured report: per-render time, memory and cost on Linux; a verified "no
  network egress" check; and a proposed `CreatorRenderProvider` interface. Wiring into Creator
  Studio would come only after that report is reviewed.

---

### Sources

- Repositories: [Kianzzz/xilo-opus-video](https://github.com/Kianzzz/xilo-opus-video) ·
  [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes) ·
  [Vincentwei1021/mg-styles-15](https://github.com/Vincentwei1021/mg-styles-15) ·
  [lemomo-ai/lemo-opuscar](https://github.com/lemomo-ai/lemo-opuscar) ·
  [npm: hyperframes](https://www.npmjs.com/package/hyperframes) ·
  [BtbN/FFmpeg-Builds](https://github.com/BtbN/FFmpeg-Builds/releases)
- Pricing: [fal: Kling 2.1 Standard image-to-video](https://fal.ai/models/fal-ai/kling-video/v2.1/standard/image-to-video) ·
  [Runway API pricing](https://docs.dev.runwayml.com/guides/pricing/) ·
  [Google Cloud generative AI pricing](https://cloud.google.com/gemini-enterprise-agent-platform/generative-ai/pricing) ·
  [Gemini API Veo docs](https://ai.google.dev/gemini-api/docs/veo) ·
  [Kling API pricing](https://klingai.com/global/dev/pricing)
- Licensing: [GSAP Standard License](https://gsap.com/licensing/) ·
  [Webflow: GSAP becomes free](https://webflow.com/blog/gsap-becomes-free)
- Discovery (secondary, used only to locate mg-styles-15):
  [explainx.ai article](https://explainx.ai/blog/mg-styles-15-claude-opus-5-5-fifteen-motion-films-code-prompts-mit-2026)
