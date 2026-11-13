# AD11 — production notes

**Concept.** Brand film: spark → connections → four capability words → one ecosystem → "Your business. Smarter."

**Storyboard foundation.** Storyboard 5 (see `../STORYBOARDS/`).

**Honest-advertising note.** Pure brand statement; no feature, customer or result claims.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–3.8 s | `spark` | fade from black | boom@0.2 |
| 2 | 3.8–8.2 s | `network` | cut | rise@0.2 |
| 3 | 8.2–13.2 s | `montage` | cut | hit@0, hit@1.25, hit@2.5, hit@3.75 |
| 4 | 13.2–18.0 s | `ecosystem` | zoom | — |
| 5 | 18.0–21.6 s | `bigtype` | cut | boom@0.1 |
| 6 | 21.6–26.6 s | `end` | fade | — |

**Score.** Mood `luxe`: slow, deep cinematic pads with sparse bell tones. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD11 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD11_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
