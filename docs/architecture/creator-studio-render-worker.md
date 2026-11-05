# Creator Studio render worker

For engineers and the owner deciding whether to take template rendering further. This describes a
**development-only proof of concept** in
[experiments/hyperframes-render-worker/](../../experiments/hyperframes-render-worker/). It is not
connected to the product. Measurements are in
[docs/research/hyperframes-pilot-results.md](../research/hyperframes-pilot-results.md).

## The idea

Creator Studio today can only generate footage, through fal and Kling, one paid clip at a time.
Generated footage is a poor way to produce what small businesses mostly need: a correctly spelled
offer, in the right language and format, with their logo.

```
Existing, unchanged                     New, not connected
────────────────────────────            ──────────────────────────────────────────────
prompt → fal/Kling → stored asset  ───► validated media → fixed template + JSON → MP4
                                        (optional)        FI / EN / AR, 9:16 1:1 16:9
```

The two complement each other. A template works without footage, and generated footage can fill a
template's media slot.

## Why these choices

| Decision                | Chosen                                       | Alternatives                                                                                      | Why                                                                                                                                                        |
| ----------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer                | HyperFrames CLI, pinned to `0.8.225`         | Own Chrome + FFmpeg harness; Remotion (already in `syveka-skills`, with its own commercial terms) | Provides capture, encode and a layout, contrast and runtime quality check. A later version is `0.9.13`; it wasn't tested, and 0.9.0 was a breaking release |
| Animation               | Browser Web Animations API                   | GSAP, HyperFrames' primary path                                                                   | **Removes the GSAP licence question** instead of answering it. HyperFrames documents this adapter, and its `check` accepts it                              |
| Templates               | Fixed HTML, shipped in the image             | Customer or AI-written HTML                                                                       | Running arbitrary HTML in a browser on our servers is the largest risk this design avoids                                                                  |
| Fonts                   | Noto Sans and Noto Sans Arabic, in the image | Google Fonts at render time                                                                       | SIL OFL, deterministic, and no network needed                                                                                                              |
| Process boundary        | One container per job                        | Long-running service                                                                              | Simplest isolation, and nothing survives between jobs                                                                                                      |
| Coupling to the product | None; a typed seam only                      | New provider inside `src/server/ai/creator/`                                                      | Vercel functions can't run this anyway. Keeps the existing pipeline untouched. The seam file is typechecked with the repo, and nothing imports it          |

## Security model

**Assume the renderer is compromised.** A decoder or Chrome exploit gives code execution as the
worker's own user, so the controls that matter are enforced by the kernel, the image and the host,
not by environment variables or by the CLI behaving well.

| Threat                                       | Control                                                                                                                                                                                                                                                                      | Enforced by        |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| Telemetry, CDN or font calls, exfiltration   | `--network=none`: only a loopback interface exists                                                                                                                                                                                                                           | Kernel             |
| `usage` reading Claude, Codex or Grok tokens | Those tokens aren't in the container: the only mount is the read-only input, and the host refuses a home directory or a common credentials folder as that mount (a convenience check; production needs a fixed jobs root). The command's code is also deleted from the image | Docker, host       |
| Upsell, auth, publish or cloud paths         | Modules deleted at build time. The build fails if one has moved, so a miss can't go unnoticed                                                                                                                                                                                | Image build        |
| Writing to the host, or filling its disk     | **No writable host mount, and `--log-driver=none`.** Results come back over stdout to a host reader that checks names against one pattern, caps each file at 200 MB and each job at 1 GB, creates files only as new, and computes hashes itself                              | Docker, host       |
| A forged or tampered result                  | The host decides the outcome: a render counts only if its file arrived and its own hash matches, and only known fields are passed on. **A verified file is still attacker-influenced media:** consumers must treat it as untrusted                                           | Host               |
| Arbitrary code through the job               | No field accepts HTML, CSS, JS, a URL or a path. Text is carried as escaped JSON and written with `textContent`. Colors must match `#rrggbb`                                                                                                                                 | Worker, unit tests |
| Shell or command injection                   | `spawn` with no shell and a fixed argument list. Only `check` and `render` exist. No job text reaches argv                                                                                                                                                                   | Worker             |
| Path traversal                               | File names are plain names by regex. Output names come only from validated fields, and are checked again on the host                                                                                                                                                         | Worker, host       |
| Input swapped during validation              | One `open` with `O_NOFOLLOW` and `O_NONBLOCK`, then a capped copy into scratch space. Only the copy is ever validated or encoded, so a symlink or a named pipe can't get through                                                                                             | Worker             |
| Malicious media                              | Type sniffed from content, with SVG impossible. FFmpeg limited to the `file` protocol and to allowlisted formats and codecs. **Everything is re-encoded**, to at most 1920 px and 10 s, so the browser never opens the original                                              | Worker             |
| Privilege escalation                         | Non-root user, no capabilities, `no-new-privileges`, read-only root filesystem, non-executable `/tmp`                                                                                                                                                                        | Docker             |
| Resource exhaustion                          | 4 CPUs, 3 GB with no swap, 512 processes and threads. Scratch space is held in memory and shares that 3 GB, so overflow ends in an out-of-memory kill. Timeouts on each step, and leftovers are swept after every command                                                    | Docker, worker     |
| A worker that stops cooperating              | A 30-minute job deadline enforced from outside with `docker kill`, tested at 8 seconds                                                                                                                                                                                       | Host               |
| Crash dumps filling the host disk            | `--ulimit=core=1`. See the incident below                                                                                                                                                                                                                                    | Docker             |
| Leaking through errors                       | Only stable codes and field paths leave the worker. stderr is dropped, and no submitted value is echoed                                                                                                                                                                      | Worker, unit tests |
| Secrets inherited by the renderer            | The child process gets an allowlisted environment, nothing inherited                                                                                                                                                                                                         | Worker             |

### Known limits

- **Everything inside runs as one user.** A compromised Chrome could tamper with the worker, or with
  a later render in the same job. A job is one tenant's by design, and production should go further
  with one container per render.
- **Chrome's own sandbox isn't active.** It needs privileges this container deliberately lacks, so
  the container is the boundary. Production should add gVisor or Firecracker, or the equivalent
  isolation of its platform.
- **The default seccomp profile applies;** no custom profile was written.
- **Debian packages aren't pinned to a snapshot.** The base image, FFmpeg and Chrome (SHA-256) and the
  npm packages (lockfile) are pinned. Rebuilding on a later day can pick up newer apt security updates.
- **`gsapParser` modules remain.** They read scripts and contain no GSAP. A content scan of the image
  finds no GSAP code.
- **Deleting CLI modules is tied to `0.8.225`.** Upgrading needs the list reviewed, and the build
  fails loudly if a target moved.
- **Docker socket access is the real privilege.** Whatever starts these containers holds it, so it
  must never be reachable from a web process.
- **Template code is duplicated a little.** Each template repeats a short bootstrap, because
  HyperFrames' check looks for the timeline registration in the page itself.

## Lesson from the pilot: the crash-dump incident

During testing, Chrome crashed inside the container with SIGTRAP. On Docker Desktop with WSL 2, crash
dumps go to a handler on the Windows host, which wrote 500–700 MB per crash into
`%TEMP%\wsl-crashes`. `--ulimit=core=0` does not stop this, because the kernel ignores that limit for
piped core handlers. The disk filled and Docker Desktop shut down, which also removed an unrelated
disposable test database started with `--rm`.

The fix is `--ulimit=core=1`, the value at which the kernel skips piped dumps, and a probe asserts it.
The likely cause of the crashes themselves was a thread leak, also fixed. **Container isolation has a
host side: a limit on the container doesn't bound what the host writes on its behalf.** Production
hosts need a disk alert and a core-dump policy of their own.

## How it would join Creator Studio

`integration/creator-template-renderer.ts` is the seam. It imports Creator Studio's real types, so
the root typecheck fails if they drift, and nothing in `src/` imports it (a unit test checks this).

A later, separately approved change would need these. Any asset stager must load files through the
tenant-scoped path, because the seam doesn't validate them:

1. **A separate worker service.** Vercel functions can't run Chrome this way, or hold a Docker socket.
   Likely Cloud Run Jobs or a queue-driven container, in an EU region.
2. **The product's normal flow:** Preview → Confirm → Execute → Verify → Audit, using the existing
   generation, asset and credit services rather than new ones.
3. **Tenant identity from the server session only.** The worker receives no org id. The caller loads
   an asset through the existing tenant-scoped path, then stages it under a generated file name, so a
   storage path never crosses into the worker. An output is stored under the caller's own org path.
4. **Credit reservation before rendering**, and release on failure, like the current pipeline.
5. **The shared rate limiter** on any new route. A render costs real CPU, so it needs a per-org limit
   and a concurrency cap.
6. **4:5 support.** Creator Studio offers it and these templates don't. The adapter refuses it rather
   than cropping.
7. **FI, EN and AR review** of any user-facing strings, by native speakers.

The deprecated Kling 2.1 endpoint is a separate issue; see
[docs/research/hyperframes-pilot-results.md](../research/hyperframes-pilot-results.md).
