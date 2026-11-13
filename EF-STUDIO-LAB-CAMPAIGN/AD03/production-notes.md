# AD03 — production notes

**Concept.** After-hours inquiry handled by an AI assistant concept, ready for the owner in the morning.

**Storyboard foundation.** Storyboard 3 (see `../STORYBOARDS/`).

**Honest-advertising note.** AI assistant is shown strictly as a concept ("can", "what if"); end card states solutions are designed case by case.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–5.0 s | `closing` | fade from black | tick@2.4 |
| 2 | 5.0–9.2 s | `nightMsg` | down | ding@1.5 |
| 3 | 9.2–14.4 s | `aiOrb` | iris | rise@0.1, pop@0.5 |
| 4 | 14.4–19.0 s | `ticket` | up | tick@0.8, tick@1.08, tick@1.36, tick@1.64 |
| 5 | 19.0–23.0 s | `morning` | fade | chime@0.3 |
| 6 | 23.0–27.8 s | `end` | fade | — |

**Score.** Mood `future`: cool suspended chords with a glassy arpeggio. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD03 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD03_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
