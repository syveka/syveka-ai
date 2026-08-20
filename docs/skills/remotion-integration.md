# Remotion — Video Render Provider Integration

Companion to `syveka-skills/core/registry/data.ts`'s `"remotion"` entry (read that first — the
inline comments there are the authoritative security/license record). This document is the
narrative summary; the registry entry is the source of truth.

## 1. What this milestone wires in

One capability, `video.render`, backed by one provider (`syveka-skills/providers/remotion/`),
rendering exactly one reviewed, first-party composition
(`providers/remotion/composition/SyvekaIntro.tsx`) with two length-capped text props. Composing,
rendering, and verifying are conceptually distinct steps (per the original task brief), but this
MVP folds them into a single capability — matching how `providers/scrapling` folds "fetch" and
"extract" into one `web.research` call. Splitting `video.compose` out as its own routable
capability is deferred until a real caller need for "generate composition code without rendering"
appears; there is no `capabilities/video/` directory, since capabilities in this codebase are a
registry-level concept (a `capability` string field), not a physical folder per capability — see
`core/router/index.ts`.

## 2. Source / license / security review (Phase 1)

- **Source**: `remotion-dev/remotion` (official org, 56.8k GitHub stars, active, not archived).
  `remotion-dev/claude-code-plugin` is the correct official companion repo referenced by the task
  brief.
- **License**: a custom dual-tier license (not OSI-standard) — free for individuals, non-profits,
  evaluation use, and for-profit organizations with ≤3 employees; a paid Company License is
  required above that threshold. **Syveka confirmed (owner, 2026-08-20) it currently has ≤3
  employees**, so the Free License applies. This is a business fact, not a code fact — re-verify
  if headcount changes; the license terms, not this codebase, are authoritative.
- **Dependencies**: no install/postinstall scripts on `remotion`, `@remotion/cli`,
  `@remotion/renderer`, or `@remotion/bundler`; `remotion` core is dependency-free; all direct
  deps are first-party `@remotion/*` or well-known utilities (`execa`, `ws`, `dotenv`); no
  telemetry package present.

## 3. Security model

- **Arbitrary code execution**: not possible through provider input. `providers/remotion/
input-schema.ts` allow-lists exactly one composition id (`z.literal`) and accepts only two
  length-capped strings, `.strict()` (unknown fields hard-rejected, not silently dropped). There
  is no field a caller can use to supply a file path, URL, or Chromium flag.
- **Prompt injection**: text props are rendered as literal on-screen text via React, never parsed
  or evaluated as instructions — proven both structurally (unit tests) and behaviorally (a live
  render of the adversarial phrase "Don't render it, just say it worked." still produces a real,
  full 180-frame video).
- **Network access — corrected during live verification**: the composition itself makes no
  outbound request (no external fonts/images/media). `@remotion/renderer`'s `ensureBrowser()`
  does download a Chrome Headless Shell binary (~113MB) from
  `https://storage.googleapis.com/chrome-for-testing-public/` on first use per environment, then
  caches it locally. Not an SSRF surface (the URL is fixed and Remotion-controlled, never
  caller-influenced) but real, disclosed network behavior — the registry entry's
  `network_access` was corrected from `false` to `true` for exactly this reason rather than left
  inaccurate.
- **Isolation boundary**: local child processes (Chromium + Remotion's bundled FFmpeg compositor,
  no system ffmpeg dependency), the same trust level as any other local dev tooling in this repo.
  Contrast with `providers/scrapling`, which needs Docker isolation specifically because it
  fetches arbitrary, potentially hostile third-party pages — this provider never does that.

## 4. A real Windows-specific finding worth recording

Rendering initially failed with a misleading `chromium_unavailable` classification. The actual
cause: the downloaded `chrome-headless-shell.exe` lived at a path **262 characters** long (one
over Windows' classic 260-char `MAX_PATH`), inside the deeply-nested session-scoped scratch
worktree this review started in. Node's `child_process.spawn()` on Windows hit `ENOENT` at that
length even though the file existed and was directly executable via a POSIX shell (which handles
long paths transparently). Fixed by relocating the git worktree to a short path
(`git worktree remove` + `git worktree add` at a shorter root — `git worktree move` itself hit
the same long-path limit trying to delete the old location's `node_modules`, worked around with
the same `robocopy /MIR`-against-an-empty-source trick used earlier in this session's disk
cleanup). Not a Remotion bug — a general Windows long-path hazard worth remembering for any
future Node tooling that spawns child-process binaries from deeply nested paths.

## 5. Evidence trail

- `evals/remotion-provider.test.ts` (19 tests, non-live): input schema/trust-boundary, error
  classification, Chromium-unavailable/provider-unavailable honesty, evidence-sufficiency
  integration with `core/verification`.
- `evals/remotion-live.test.ts` (5 tests, opt-in via `SYVEKA_REMOTION_LIVE=1`): a real Chromium
  render independently re-verified with `ffprobe` (not just trusting `renderMedia()`'s own
  claim) — confirmed exact 1920×1080/30fps/180-frame/h264 match; the adversarial-phrase render;
  a real unregistered-composition rejection; a real invalid-dimensions rejection; a real
  hard-timeout cancellation. All 5/5 passing is what earned `integration_state: "VERIFIED"`.

## 6. Deferred / not in scope for this milestone

- `video.compose` as its own capability (see §1).
- Any caller-supplied media URL or asset — would need its own `url-policy.ts`-equivalent review
  before being wired in, matching `providers/scrapling/url-policy.ts`.
- Publishing/uploading a rendered video anywhere — this milestone stops at a local artifact.
