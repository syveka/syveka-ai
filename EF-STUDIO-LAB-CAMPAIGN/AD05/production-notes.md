# AD05 — production notes

**Concept.** Workshop: the phone interrupts the work; one online form and a simple queue bring order.

**Storyboard foundation.** Storyboard 4 (see `../STORYBOARDS/`).

**Honest-advertising note.** Registration numbers are obvious placeholders (ABC-123). Automation shown as concept.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.4 s | `ringing` | fade from black | ring@0.9, ring@2.3 |
| 2 | 4.4–9.2 s | `channels` | diag | pop@0.3, pop@0.8, pop@1.3 |
| 3 | 9.2–14.2 s | `form` | up | type@0.6, type@1.5, type@2.4, pop@3.5 |
| 4 | 14.2–19.2 s | `queue` | side | tick@0.5, tick@0.9, tick@1.3, ding@2.8 |
| 5 | 19.2–23.0 s | `statement` | zoom | — |
| 6 | 23.0–27.6 s | `end` | fade | — |

**Score.** Mood `drive`: steady driving pulse with soft kick. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD05 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD05_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
