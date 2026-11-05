# Video licensing review

For the owner and counsel. This records what the sources say, read on 2026-11-05, and it isn't legal
advice. Legal judgements are in [legal-questions-for-counsel.md](legal-questions-for-counsel.md). Some
vendor pages were read through a summarising tool, so counsel should read the originals.

**Summary:** nothing found forbids running the worker internally. **Before production or any distribution
of the image,** the notices below must be fixed and counsel must answer the open questions, above all on
fal output rights and on H.264 encoding.

**Correction to the earlier pilot report:** it said the `@hyperframes/*` packages lacked a licence. Only
the npm metadata field is missing. Their tarballs hold an Apache-2.0 LICENSE.

## HyperFrames `0.8.225`

| Item                      | Finding                                                                                                                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Licence                   | Apache-2.0 in `package.json` and at repo tag `v0.8.225` (`b687d06`, matching npm's `gitHead`). README: "no per-render fees or commercial-use thresholds"                                           |
| Trademarks                | Apache-2.0 §6 grants none, so HeyGen and HyperFrames names can't be used to endorse Syveka                                                                                                         |
| `hyperframes` tarball     | **No LICENSE, NOTICE or third-party file.** Apache-2.0 §4 requires passing on a copy of the licence when redistributing                                                                            |
| `@hyperframes/*` packages | No npm `license` field. Tarballs hold an Apache-2.0 LICENSE, "Copyright 2026 HeyGen, Inc." (read for `core` and `lint`; file seen for the others)                                                  |
| Code bundled in `dist`    | Sampled 26 packages: MIT, ISC, BSD and 0BSD (`linkedom`, `ajv`, `recast`, `citty` and others). **Their notices aren't kept in the bundles.** `@google/genai` and `onnxruntime-node` aren't bundled |
| Removed from the image    | `dist/vendor` (GSAP), `dist/studio` (React, Tailwind, mediabunny MPL-2.0), `dist/skills` (fonts, sound effects under a Pixabay licence)                                                            |
| Unclear assets            | `CREDITS.md` says some catalog assets have "Origin to be confirmed with the author". The worker uses none of them                                                                                  |

## Worker dependencies

Census of all 128 lockfile entries: MIT 82, Apache-2.0 20, ISC 6, BSD-3 2, 0BSD 1, OFL-1.1 2 (Noto fonts),
CC0 1. The LGPL entries (15) are optional `sharp` and `libvips` binaries, which `--omit=optional` leaves
out. **None is missing a licence.** The lockfile can't see code bundled inside `hyperframes`, as above.

## GSAP

**Not used.** No GSAP in the templates or worker source, and the build deletes the vendored copy. The
content scan probe finds none. If this ever changes, two points need review:

- Prohibited Uses cover visual no-code tools that compete with Webflow.
- The licence page says "as long as end users are not charged a fee of any kind", and to take a Business
  membership otherwise, while its banner says "GSAP is now free for everyone". These conflict.

**Keep customers from supplying templates that load GSAP.** Today no job can supply a template at all.

## FFmpeg

| Item                   | Finding                                                                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Build used             | BtbN `linux64-gpl-8.0`, built with `--enable-gpl --enable-version3`, so **GPLv3**. It includes libx264 (GPLv2 or later), and VideoLAN says x264 "is also available under a commercial license"                                       |
| Running as a service   | GPLv3 §0: "Mere interaction with a user through a computer network, with no transfer of a copy, is not conveying", and §2 allows running without conditions                                                                          |
| Distributing the image | Conveying object code requires the Corresponding Source (§6). Copying between our own systems versus giving the image to anyone else is a question for counsel                                                                       |
| **Gap in the image**   | **The Dockerfile extracts only `ffmpeg` and `ffprobe`, dropping BtbN's `LICENSE.txt`.** To fix before any distribution. Not fixed yet: it needs a full image rebuild, which C: can't safely hold today                               |
| LGPL alternative       | BtbN publishes an `lgpl` build without libx264. HyperFrames has no fallback to OpenH264, only to GPU encoders, and the worker's `media.mjs` also hardcodes `libx264`. **It isn't a drop-in change**: it needs code changes, or a GPU |
| Patents                | ffmpeg.org warns of H.264 patents: "MPEG LA is vigilant and diligent about collecting". This applies to H.264 encoding whichever encoder is used. Current Via LA terms weren't read                                                  |

## Chrome for Testing

The official zip matches the Dockerfile's SHA-256 and includes `LICENSE.headless_shell`, 2.1 MB of notices,
which stays in the image. Its `ABOUT` file refers to the Chrome terms. **No official statement was found
that permits or forbids redistributing it in an image.**

## Fonts

Noto Sans and Noto Sans Arabic are OFL-1.1 and may be bundled with software with their notice. The
`@fontsource` packages keep their licences in the image. OFL's condition 5 says it doesn't apply to
documents created with the font. Video isn't named. Reserved Font Names weren't checked.

## fal

Terms last updated 2026-09-08. Section letters are inferred, because the page numbers them by CSS.

| Topic               | What it says                                                                                                                                                                                                                           |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ownership of output | **No clause assigns it.** §6(b) covers input only. §4(c): output is not warranted to "be original, will not infringe rights of any third party". "Output Content may not be unique across users"                                       |
| Risk                | §16: "USE OF SUCH OUTPUT CONTENT IS AT CUSTOMER'S SOLE RISK"                                                                                                                                                                           |
| End users           | §4(b) permits it: "allow End Users to access and use the Services through the Customer Solution", but "Client will not expose any of the Services APIs directly to any End Users"                                                      |
| Conflicting limits  | §4(a) "personal or internal business use". Also barred: "resell… service bureau, or similar arrangement… or to provide the Services for the benefit of any third party", and integrating software "unless first authorized in writing" |
| API terms           | Requires "legally enforceable agreements with its End Users", and the client indemnifies for them                                                                                                                                      |
| Upstream            | §14(b): "may be subject to additional terms". The terms don't name Kling or Kuaishou, and Kling's own terms couldn't be read                                                                                                           |
| Model licence       | FAQ: "Each model has its own license… marked with a `Commercial use` badge". Both pages show the badge, with no licence text                                                                                                           |
| Conduct             | Bars likeness and deepfake impersonation. Administrators answer for end users' compliance. Relevant to Creator Studio's character features                                                                                             |

## Blockers before production

| Blocker                                                    | Owner                             |
| ---------------------------------------------------------- | --------------------------------- |
| fal: output rights, and SaaS use by end customers          | Counsel, then fal in writing      |
| H.264 encoding at commercial scale                         | Counsel                           |
| GPL build: what counts as distribution for the chosen host | Counsel                           |
| Include FFmpeg and Apache-2.0 licence texts in the image   | Engineering, after disk space     |
| A third-party notices file for code bundled by HyperFrames | Engineering, confirmed by counsel |
