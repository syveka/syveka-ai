# AD07 — production notes

**Concept.** Moving company: phone tag replaced by a from/to/when booking request.

**Storyboard foundation.** Storyboard 4 (see `../STORYBOARDS/`).

**Honest-advertising note.** Cities are illustrative. Booking request is a concept visual.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.6 s | `calendar` | fade from black | tick@1.4 |
| 2 | 4.6–9.2 s | `phoneTag` | side | ring@0.3, ring@1.5, ring@2.7 |
| 3 | 9.2–14.4 s | `stepper` | up | type@0.5, type@1.5, type@2.5 |
| 4 | 14.4–19.2 s | `requestCard` | zoom | pop@2.6, chime@2.9 |
| 5 | 19.2–23.2 s | `route` | fade | — |
| 6 | 23.2–27.8 s | `end` | fade | — |

**Score.** Mood `drive`: steady driving pulse with soft kick. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD07 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD07_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
