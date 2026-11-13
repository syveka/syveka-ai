# AD09 — production notes

**Concept.** The owner's time: routine eats the day; repetitive tasks can often be automated.

**Storyboard foundation.** Storyboard 3 (see `../STORYBOARDS/`).

**Honest-advertising note.** Deliberately contains no hour or percentage figures — no quantified time-saving claim is made.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.8 s | `ring24` | fade from black | tick@0.5, tick@1.0, tick@1.5 |
| 2 | 4.8–9.4 s | `repeat` | side | pop@0.3, pop@0.8, pop@1.3, pop@1.8, pop@2.3 |
| 3 | 9.4–14.0 s | `automate` | zoom | rise@0.2, chime@2.6 |
| 4 | 14.0–19.0 s | `blueprint` | up | tick@0.6, tick@1.1, tick@1.6 |
| 5 | 19.0–23.0 s | `ring24` | fade | — |
| 6 | 23.0–27.6 s | `end` | fade | — |

**Score.** Mood `tension`: restrained minor pads that lift into a brighter progression at the solution. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD09 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD09_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
