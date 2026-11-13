# AD06 — production notes

**Concept.** Cleaning company: leads live in email, sticky notes and memory — gathered into one board.

**Storyboard foundation.** Storyboard 4 (see `../STORYBOARDS/`).

**Honest-advertising note.** Kanban board is a concept visual; no customer names or results are shown.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.6 s | `notes` | fade from black | — |
| 2 | 4.6–9.4 s | `scatter` | fade | — |
| 3 | 9.4–13.6 s | `gather` | zoom | rise@0.2, chime@2.2 |
| 4 | 13.6–18.8 s | `kanban` | up | tick@1.6, tick@2.6 |
| 5 | 18.8–22.6 s | `statement` | fade | — |
| 6 | 22.6–27.2 s | `end` | fade | — |

**Score.** Mood `bright`: optimistic major progression, light pulse. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD06 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD06_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
