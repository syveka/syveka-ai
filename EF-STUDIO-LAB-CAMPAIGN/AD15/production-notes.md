# AD15 — production notes

**Concept.** Growth service explainer: growth starts with being easy to reach; three questions, the customer path, three steps, CTA.

**Storyboard foundation.** Storyboard 4 (see `../STORYBOARDS/`).

**Honest-advertising note.** Growth appears in the business header but its scope was not specified. The ad makes no traffic, ranking, lead or revenue promise and names no channel (no SEO or advertising claim); the bar graphic carries no figures.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.6 s | `growHook` | fade from black | tick@0.5, tick@0.72, tick@0.94, tick@1.16, tick@1.38 |
| 2 | 4.6–10.0 s | `checklist` | up | pop@0.4, pop@1.5, pop@2.6 |
| 3 | 10.0–15.0 s | `sectors` | side | tick@0.35, tick@0.7, tick@1.05, tick@1.4 |
| 4 | 15.0–20.2 s | `steps` | up | tick@0.4, tick@1.3, tick@2.2 |
| 5 | 20.2–24.0 s | `ctaTap` | zoom | pop@1.7, chime@1.9 |
| 6 | 24.0–28.6 s | `end` | fade | — |

**Score.** Mood `drive`: steady driving pulse with soft kick. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD15 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD15_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
