# AD10 — production notes

**Concept.** Website showcase: business card flips into a site; structure, design, responsive, multilingual.

**Storyboard foundation.** Storyboard 2 (see `../STORYBOARDS/`).

**Honest-advertising note.** All designs are concept visuals. Multilingual claim is supported by this trilingual campaign itself.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.8 s | `bizcard` | fade from black | — |
| 2 | 4.8–8.4 s | `wire` | up | tick@0.3, tick@0.7, tick@1.1, tick@1.5 |
| 3 | 8.4–12.2 s | `wire` | fade | rise@0.2 |
| 4 | 12.2–17.0 s | `responsive` | zoom | — |
| 5 | 17.0–21.6 s | `langSwitch` | side | pop@1.3, pop@2.6 |
| 6 | 21.6–26.2 s | `end` | fade | — |

**Score.** Mood `luxe`: slow, deep cinematic pads with sparse bell tones. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD10 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD10_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
