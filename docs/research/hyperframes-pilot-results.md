# HyperFrames render worker: pilot results

For the owner and engineers deciding whether to continue. Measured on 2026-11-05. Design and threat
model: [docs/architecture/creator-studio-render-worker.md](../architecture/creator-studio-render-worker.md).

**Recommendation: continue the pilot. Do not adopt yet.** The worker produced every requested
combination, correct in Finnish, English and Arabic, inside an isolated container with no network.
It hasn't been tried with real customer content, on cloud infrastructure, or with real AI footage,
and it isn't connected to Creator Studio.

## Results at a glance

| Question                              | Result                                                                                                         |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Does every combination render?        | **Yes: 27 of 27** (3 templates × 3 languages × 3 aspect ratios), first attempt                                 |
| Largest allowed job?                  | **12 of 12,** first attempt                                                                                    |
| Longest allowed copy, and a 5 s clip? | **8 of 8.** Copy fits, apart from the extreme word noted below, and the clip holds its last frame to fill 10 s |
| How long for a 10-second 1080p video? | **Median 23 s on a quiet machine,** 27–32 s when it was busy, plus about 4–5 s of quality check                |
| Is it deterministic?                  | **Yes.** Three repeat renders were byte-identical (same SHA-256)                                               |
| Does isolation hold?                  | **55 of 55 probes pass** under the real flags                                                                  |
| Is GSAP needed?                       | **No.** Templates use the browser's Web Animations API. A content scan finds no GSAP in the image              |

## Environment

Windows 11 laptop, Docker Desktop on WSL 2, Docker VM with 12 CPUs and 7.9 GB. The container was
limited to 4 CPUs, 3 GB with no swap, and 512 processes. Timings will differ on cloud hardware.
Final image: `sha256:083c7ee5dca8…`, about 1.4 GB on disk.

**Two timing runs, both real.** The quiet run had nothing competing. The final matrix run, on nearly finished
code, ran while the machine was busier for reasons outside this work, which is why its numbers are
worse and more spread. The final code's changes affect how results leave the container, not how
frames are rendered. Treat the quiet figures as the best case and the final ones as a realistic range.

## Measured

### Rendering: full matrix, 30 fps, 10 s

Media was a synthetic 1600×1600 JPEG and a PNG logo.

| Aspect ratio     | Renders | Quiet: median render | Final: median render | Final: range | Final: check | File    |
| ---------------- | ------- | -------------------- | -------------------- | ------------ | ------------ | ------- |
| 9:16 (1080×1920) | 9       | 23.3 s               | 26.9 s               | 23.4–65.1 s  | 4.7 s        | 0.91 MB |
| 1:1 (1080×1080)  | 9       | 15.1 s               | 22.8 s               | 17.1–40.6 s  | 4.3 s        | 0.60 MB |
| 16:9 (1920×1080) | 9       | 22.9 s               | 32.3 s               | 22.7–62.5 s  | 4.7 s        | 0.83 MB |

In the quiet run, the medians by language were 21.7 s (English), 22.7 s (Finnish) and 21.2 s (Arabic),
so language makes no meaningful difference to speed.

**Output:** every file is H.264, yuv420p, 30 fps, exactly 300 frames, at the requested dimensions. The
worker checks this itself and rejects a file that doesn't match, and the host confirms each file's
SHA-256 against the bytes it received. There's no audio track; the templates don't have sound yet.

### Resources

| Workload                          | Wall time | CPU time  | Memory peak  | Thread peak |
| --------------------------------- | --------- | --------- | ------------ | ----------- |
| One render (Arabic, 9:16), quiet  | 34 s      | 114 s     | 1.30 GB      | 273         |
| 9 renders, quiet                  | 209–263 s | 695–907 s | 1.28–1.35 GB | 282         |
| 12 renders, quiet                 | 288 s     | 977 s     | 1.30 GB      | 283         |
| 3 renders with video clips, quiet | 119 s     | 410 s     | **2.63 GB**  | 292         |
| 12 renders, final                 | 322 s     | 1,105 s   | 1.32 GB      | 280         |

Memory and CPU come from the container's own kernel counters. The memory peak includes scratch files
held in memory, which is why video is high: **2.6 GB is close to the 3 GB limit**, so longer or
higher-resolution source clips may need a larger limit. Thread count returned to 12 after every
render, so a long job doesn't accumulate anything.

### Video and edge cases

Viewed as extracted frames, not only checked for status.

| Case                              | Result                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Video clip in each template       | Plays in the media slot                                                                                                   |
| 5 s clip in a 10 s film           | Holds its last frame, then fades out. Kling clips default to 5 s, so this is the main hybrid case                         |
| Arabic shaping and RTL            | Correct letter joining, right-aligned text, and layouts mirrored in all three templates. Text is never split into letters |
| Finnish                           | ä and ö render correctly. Long compounds such as "Hammaslääkäriasemamme" stay whole                                       |
| Longest allowed copy              | Fits at every aspect ratio tested. A single 62-letter word is the exception; see below                                    |
| HTML and script as text           | Shown as literal text: `</script><script>…`, `<img onerror=…>`, `${alert(1)}`, `$& $'`. Nothing ran                       |
| No logo, no media, no description | Layout closes up correctly                                                                                                |
| One missing file in a batch       | That render returns `media_not_found`; the others complete                                                                |
| White text on bright footage      | `check` rejected it at 1.18:1, which led to a top scrim in `product-ad`                                                   |

**Known visual limit.** In the longest-copy test, an extreme word ("Lentokonesuihkuturbiini…", 62
letters) still breaks mid-word in the narrowest layouts, once the headline has reached its minimum
size. Real copy rarely does this, and it's better than a clipped word.

**Not reviewed by a native speaker.** The sample copy is synthetic. Layout and shaping were judged by
looking at frames, which doesn't replace a Finnish or Arabic reader.

### Security probes

`scripts/container-probes.mjs` runs inside the image under the real flags. **55 of 55 passed.**

| Area             | What was tried                                                                                                                                                        | Outcome                                                                   |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Network          | HTTPS, DNS, the telemetry host, a direct IP, the Docker host                                                                                                          | All fail. Only `lo` exists                                                |
| Privileges       | User, capabilities, no-new-privileges                                                                                                                                 | uid 10001, zero capabilities, set                                         |
| Filesystem       | Writing to `/app`, `/etc`, `/usr`, the input directory; running a program from `/tmp`; a `/output` directory                                                          | All refused, and no output directory exists                               |
| Credentials      | A home directory, the Docker socket, secret-like environment variables                                                                                                | None present                                                              |
| Removed tools    | `curl`, `wget`, `npm`, `npx`, `corepack`                                                                                                                              | Absent                                                                    |
| Removed commands | `hyperframes usage`, `auth`, `login`, `publish`, `cloud`, `lambda`, `billing`, `upgrade`, `init`                                                                      | Unavailable                                                               |
| Malicious media  | SVG and HTML named `.png`, HLS playlist named `.mp4`, empty, truncated and fake-header files, a symlink, a named pipe, oversized dimensions, a 70 s clip, wrong kinds | All rejected. A polyglot is accepted, and re-encoding removes its payload |
| Runaway render   | A real render past its deadline                                                                                                                                       | `render_timeout`; Chrome was running, and nothing survived                |
| Leftovers        | Processes and zombies after a finished command                                                                                                                        | None                                                                      |
| Process limit    | Spawning until refused                                                                                                                                                | The kernel refused at about 500                                           |

Separately, on the host:

| Limit        | Test                                | Outcome                                                  |
| ------------ | ----------------------------------- | -------------------------------------------------------- |
| Memory       | The same render with a 400 MB limit | `render_failed`, no crash dump, and the container exited |
| Job deadline | A job given an 8-second deadline    | `job_deadline_exceeded` at 8.3 s; no container left      |

Root unit tests (`tests/unit/hyperframes-render-worker.test.ts`, 107 tests) run without Docker, so CI
enforces the schema, the isolation flags, the pinned versions, the output reader's limits and the
separation from `src/`. **CI does not run the container probes above;** they were run by hand.

## Defects this pilot found and fixed

All were in the worker I wrote. Two independent reviews and the render tests found them.

| Defect                                                               | Consequence                                                                                   | Fix                                                                      |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `--ulimit=core=0` doesn't stop WSL's piped crash dumps               | **Filled the laptop's C: drive and shut down Docker Desktop.** See the overnight report       | `--ulimit=core=1`, with a probe                                          |
| A read-write output mount                                            | A compromised renderer could write to the host or swap a result. Found by the security review | **No output mount.** A capped host reader receives results over stdout   |
| HyperFrames leaves Chrome running after it exits, in its own session | About 80 threads per render, so later renders timed out                                       | Sweep leftovers after each command; `--init` to reap them                |
| No outer deadline, and timeouts that could wait forever              | A stuck job could run indefinitely                                                            | SIGKILL, independent timers, and a host-side deadline with `docker kill` |
| Input checked and used separately                                    | A file swapped by the host could bypass the limits, and a named pipe could hang the worker    | One open, a capped copy, and validation of the copy only                 |
| Chrome pinned by version only, installed with `npx`                  | A compromised release could enter the image                                                   | Direct download with a SHA-256 check                                     |
| A 5 s clip in a 10 s film; odd dimensions; no encode cap             | The main hybrid case was undefined, and odd-sized video failed                                | Hold the last frame, force even dimensions, cap at 1920 px and 10 s      |
| Text fitting measured through animation transforms                   | Headlines could shrink for no reason                                                          | Measure with offsets, which ignore transforms                            |
| Long Finnish copy clipped the button, and words broke mid-word       | One caught by `check`, one only by looking at frames                                          | Text blocks no longer shrink; fit until the longest whole word fits      |
| Tests that passed without proving anything                           | A false sense of safety                                                                       | Rewritten to prove the behaviour                                         |

## Estimated infrastructure cost

**Estimates, not measurements.** The measured input is CPU time: about 75–150 CPU-seconds per render
at about 1.3–2.6 GB.

At assumed serverless rates of $0.000024 per vCPU-second and $0.0000025 per GiB-second (**from memory
of Cloud Run's list price, not re-read tonight**), a render costs about **$0.002–$0.004** in compute.
Storage, egress and any always-on queue or worker are extra. A separate, unverified assumption is
that cloud CPUs perform like this laptop's.

## Licensing and provider review

Not legal advice. Sources were read on 2026-11-05, partly through a summarising fetch tool, so counsel
should read the originals.

| Item                  | Finding                                                                                                                                                                                                                                                        | Status                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| HyperFrames           | Apache-2.0 at repo root and in npm's license field. README: "no per-render fees or commercial-use thresholds"                                                                                                                                                  | Looks clear                                      |
| HyperFrames gaps      | `@hyperframes/producer`, `engine` and `core` have **no license field** on npm, and the `hyperframes` tarball has **no LICENSE or NOTICE file**. `CREDITS.md` says all code is Apache-2.0. Apache-2.0 redistribution requires the licence text                  | **Ask HeyGen, or include the licence ourselves** |
| GSAP                  | Licensor is Webflow. Prohibits use "in tools that allow users to build visual animations without code" where it helps compete with Webflow's animation features. AI-generated code is stated not to be a prohibited use. Server-side rendering isn't addressed | **Uncertain; not used**                          |
| GSAP in the package   | Not a declared dependency, but the tarball vendors `gsap@3.15.0` under `dist/vendor`, and the CLI can fetch it from jsDelivr. This worker deletes the copy and doesn't use it                                                                                  | **Avoided**                                      |
| No-code editor        | A future visual template editor is the use the GSAP clause targets. Web Animations templates carry no such restriction                                                                                                                                         | **Keep to Web Animations**                       |
| Fonts                 | Noto Sans and Noto Sans Arabic are SIL OFL 1.1: may be bundled with software with the notice and licence, and the licence "does not apply to any document created". `@fontsource` packages include them. OFL doesn't name video output or container images     | Low risk; Reserved Font Names not checked        |
| FFmpeg                | The pinned BtbN build is **GPL**. That matters if the image is ever distributed to others; running it as a service is different                                                                                                                                | **Have counsel confirm before production**       |
| Chrome Headless Shell | Downloaded from Chrome for Testing. Its licence wasn't reviewed tonight                                                                                                                                                                                        | Unknown                                          |
| Remotion              | Already used by `syveka-skills`. It wasn't evaluated here; check its company licence before any production use                                                                                                                                                 | Separate question                                |

**The alternative that avoids disputed licensing is what was built:** no GSAP in the templates or the
image. Because the templates use only a browser standard, they could move to a small in-house Chrome
and FFmpeg harness if HyperFrames ever became a problem, which the earlier evaluation showed is
feasible.

### Kling and fal

**Creator Studio's default model is deprecated.** fal's page for
`fal-ai/kling-video/v2.1/standard/image-to-video` says "This endpoint is deprecated" and "This model
is no longer supported", and names no replacement or date. It is the default at
`src/server/ai/creator/fal-provider.ts:27`. **Nothing was changed.** A paid test is needed, and the
choice affects credits.

| Endpoint                  | Price                                  | Compatibility with today's code                                                                                                  |
| ------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `v2.1/standard` (current) | Page conflicts: $0.25 or $0.28 per 5 s | Works today, as far as is known                                                                                                  |
| `v2.5-turbo/standard`     | $0.21 per 5 s + $0.042/s               | **Nearest match:** the same fields were seen. fal doesn't call it the replacement                                                |
| `v3/standard`             | $0.084/s audio off, $0.126 on          | **Breaking:** `start_image_url` replaces `image_url`, and `generate_audio` defaults to true, which would cost more and add audio |

`FAL_IMAGE_TO_VIDEO_MODEL` already overrides the model, so a switch might not need a code change for
the nearest match. `PROVIDER_COST_MULTIPLIER` and the reconciler should be checked first. Also, fal's
terms (§4(a)) describe use "for your own personal or internal business use", while model pages are
tagged "Commercial use". That's worth asking fal about, given customers publish these videos.

## Earlier report: what changed

`docs/research/video-skills-evaluation.md` is preserved unchanged on its own branch. Against current
evidence:

- **Latest `hyperframes` is now `0.9.13`,** and 0.9.0 was a breaking release for distributed rendering.
  This pilot stays on `0.8.225`, as tested. Upgrading needs a re-test and a new deletion list.
- **"Vendored GSAP" is superseded.** The report proposed vendoring it. This pilot removes it.
- **Its `usage` credential finding stands,** and is now blocked at three levels.
- **Newly found:** the npm packages' licence metadata gap, above.

## Not tested

- Real customer content, or real Kling footage. All media was synthetic.
- Cloud Linux, sustained load, or several jobs at once.
- Audio. Voice-over and music aren't implemented.
- An actual exploit from inside Chrome or a decoder. The containment is designed for it, and it wasn't
  attempted.
- A forged output stream end to end, or filling the host through a real container. The reader's rules
  are unit-tested with forged input.

## Remaining work before any production decision

1. Run the same image and probes on the target Linux platform, likely Cloud Run Jobs in the EU.
2. Render real footage from staging, with owner approval for the paid Kling calls.
3. Have native Finnish and Arabic reviewers check real templates.
4. Resolve the licence questions above.
5. Decide whether templates deserve a product surface. This pilot proves it's technically sound, not
   that customers want it.
6. Handle 4:5, audio, and a queue with per-org limits.
