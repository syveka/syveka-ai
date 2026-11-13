# AD02 — production notes

**Concept.** Before / after. A dated website frustrates a mobile visitor, a gold scan-line transforms it into a modern responsive design.

**Storyboard foundation.** Storyboard 2 (see `../STORYBOARDS/`).

**Honest-advertising note.** Site designs are illustrative concepts with generic words ("Yritys / Company"), not client work.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.4 s | `oldDesk` | fade from black | — |
| 2 | 4.4–9.2 s | `oldPhone` | side | — |
| 3 | 9.2–13.4 s | `morph` | fade | rise@0.6, chime@2.7 |
| 4 | 13.4–18.6 s | `showcase` | zoom | — |
| 5 | 18.6–22.8 s | `siteClose` | up | pop@2.1 |
| 6 | 22.8–27.4 s | `end` | fade | — |

**Score.** Mood `bright`: optimistic major progression, light pulse. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD02 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD02_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
