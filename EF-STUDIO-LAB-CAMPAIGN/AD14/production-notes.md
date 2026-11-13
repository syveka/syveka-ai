# AD14 — production notes

**Concept.** AI service explainer: what can be built (assistant, automation, organisation, reminders), an automation visual, a three-step way of working, and the owner staying in charge.

**Storyboard foundation.** Storyboard 3 (see `../STORYBOARDS/`).

**Honest-advertising note.** AI appears in the business header ("Web · AI · Growth") but no AI project is shown in the portfolio, so every capability is phrased as something that can be built, screens are concept visuals, and the end card says solutions are designed case by case.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.6 s | `aiHook` | fade from black | rise@0.1 |
| 2 | 4.6–10.0 s | `features` | up | pop@0.25, pop@0.57, pop@0.89, pop@1.21 |
| 3 | 10.0–14.6 s | `automate` | zoom | rise@0.2, chime@2.6 |
| 4 | 14.6–19.8 s | `steps` | up | tick@0.4, tick@1.3, tick@2.2 |
| 5 | 19.8–23.6 s | `statement` | fade | — |
| 6 | 23.6–28.4 s | `end` | fade | — |

**Score.** Mood `future`: cool suspended chords with a glassy arpeggio. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD14 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD14_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
