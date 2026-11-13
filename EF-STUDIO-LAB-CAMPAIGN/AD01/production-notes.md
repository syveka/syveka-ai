# AD01 — production notes

**Concept.** Problem → solution. Notifications pile up, a customer waits in vain, then scattered inquiries converge into one organised workflow.

**Storyboard foundation.** Storyboard 1 (see `../STORYBOARDS/`).

**Honest-advertising note.** No claim that any specific product is live; the workflow screen is labelled as a concept visual.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.6 s | `storm` | fade from black | ding@0.2, ding@0.65, ding@1.1, ding@1.5 |
| 2 | 4.6–9.2 s | `chatWait` | side | pop@0.5, pop@2.3 |
| 3 | 9.2–13.8 s | `funnel` | zoom | rise@0.3, chime@2.1 |
| 4 | 13.8–19.0 s | `sorted` | up | tick@0.3, tick@0.62, tick@0.94, tick@1.26 |
| 5 | 19.0–22.8 s | `calm` | fade | — |
| 6 | 22.8–27.4 s | `end` | fade | — |

**Score.** Mood `tension`: restrained minor pads that lift into a brighter progression at the solution. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD01 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD01_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
