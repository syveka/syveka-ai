# AD08 — production notes

**Concept.** Restaurant: a hungry guest asks three questions; a good site answers all of them at once.

**Storyboard foundation.** Storyboard 4 (see `../STORYBOARDS/`).

**Honest-advertising note.** Opening hours shown are placeholder UI text inside a concept visual.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.2 s | `setpiece` | fade from black | — |
| 2 | 4.2–9.0 s | `questions` | fade | pop@0.3, pop@1.2, pop@2.1 |
| 3 | 9.0–13.6 s | `sitePhone` | zoom | — |
| 4 | 13.6–18.6 s | `trio` | up | tick@0.4, tick@1.3, tick@2.2 |
| 5 | 18.6–22.8 s | `evening` | fade | — |
| 6 | 22.8–27.4 s | `end` | fade | — |

**Score.** Mood `warm`: slow warm major-seventh pads, soft plucks. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD08 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD08_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
