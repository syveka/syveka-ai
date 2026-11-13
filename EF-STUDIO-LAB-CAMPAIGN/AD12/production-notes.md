# AD12 — production notes

**Concept.** Direct response: three pain questions, one conversation, three simple steps, a tap on the CTA.

**Storyboard foundation.** Storyboard 4 (see `../STORYBOARDS/`).

**Honest-advertising note.** No "free" or "no obligation" promise is made because consultation terms were not verified.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.0 s | `city` | fade from black | — |
| 2 | 4.0–9.2 s | `checklist` | up | pop@0.4, pop@1.5, pop@2.6 |
| 3 | 9.2–13.4 s | `convo` | side | pop@0.5, pop@1.8 |
| 4 | 13.4–18.4 s | `steps` | up | tick@0.4, tick@1.3, tick@2.2 |
| 5 | 18.4–22.2 s | `ctaTap` | zoom | pop@1.7, chime@1.9 |
| 6 | 22.2–26.8 s | `end` | fade | — |

**Score.** Mood `bright`: optimistic major progression, light pulse. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD12 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD12_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
