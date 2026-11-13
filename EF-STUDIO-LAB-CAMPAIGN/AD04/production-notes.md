# AD04 — production notes

**Concept.** Salon: the first impression happens on the phone — search, a beautiful site, a booking request.

**Storyboard foundation.** Storyboard 4 (see `../STORYBOARDS/`).

**Honest-advertising note.** Booking flow is a concept visual; wording is "booking request", not a promise of a specific booking engine.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.4 s | `setpiece` | fade from black | — |
| 2 | 4.4–8.8 s | `search` | up | type@0.7 |
| 3 | 8.8–13.8 s | `sitePhone` | zoom | — |
| 4 | 13.8–18.8 s | `booking` | side | pop@1.6, pop@2.9, chime@3.3 |
| 5 | 18.8–22.8 s | `quiet` | fade | ding@1.2 |
| 6 | 22.8–27.4 s | `end` | fade | — |

**Score.** Mood `warm`: slow warm major-seventh pads, soft plucks. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD04 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD04_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
