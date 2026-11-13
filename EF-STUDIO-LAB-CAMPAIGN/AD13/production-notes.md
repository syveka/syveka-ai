# AD13 — production notes

**Concept.** Website service explainer: what is included (design, online booking, WhatsApp contact, multilingual), responsive devices, one real active reference and the trades served.

**Storyboard foundation.** Storyboard 2 (see `../STORYBOARDS/`).

**Honest-advertising note.** Facts come from the owner's own portfolio page: Kyytipro Oy is shown there as an active project with website, booking, WhatsApp and responsive tags. Earlier projects are referred to only by trade, because the portfolio marks them as no longer online. The device scene is a concept visual, not the Kyytipro site.

## Scene timeline

| # | Time | Scene module | Transition in | Sound cues |
|---|---|---|---|---|
| 1 | 0.0–4.6 s | `svcHook` | fade from black | — |
| 2 | 4.6–9.8 s | `features` | up | pop@0.25, pop@0.57, pop@0.89, pop@1.21 |
| 3 | 9.8–14.4 s | `responsive` | zoom | — |
| 4 | 14.4–19.8 s | `refCard` | side | tick@1.5, tick@1.75, tick@2.0, tick@2.25 |
| 5 | 19.8–24.4 s | `sectors` | fade | tick@0.35, tick@0.7, tick@1.05, tick@1.4 |
| 6 | 24.4–29.0 s | `end` | fade | — |

**Score.** Mood `bright`: optimistic major progression, light pulse. Synthesized from oscillators and noise by `_PIPELINE/audio.py`; no samples or third-party music, so there are no licensing obligations. Mix normalised to −16 LUFS.

**Production method.** Motion graphics rendered frame-by-frame in headless Chromium and encoded with ffmpeg (H.264 High, yuv420p, AAC 192 kb/s). No generative-AI service and no credits were used. Fonts: Cormorant Garamond, Inter, IBM Plex Sans Arabic, Noto Kufi Arabic (all SIL OFL).

**Logo.** End card uses the supplied logo image as pixels (circular crop, see `../BRAND/README.md`); it is never redrawn.

**Re-render.** `cd _PIPELINE && ./build.sh AD13 fi` (or `en` / `ar`). Edit copy in `_PIPELINE/js/ads.js`.

**Files.** `EF-Studio-Lab_AD13_FI|EN|AR.mp4`, matching `.srt`, `thumbnail_FI|EN|AR.jpg`, `script.md`.
