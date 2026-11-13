# S02 — production notes

**What this ad claims, and on what basis.** Knowledge base accepts PDF, DOCX, notes and URLs and answers with citations.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.6 s | `setpiece` | fade from black |
| 2 | 4.6–10.0 s | `docsIn` | zoom |
| 3 | 10.0–15.8 s | `chatQA` | up |
| 4 | 15.8–19.8 s | `statement` | fade |
| 5 | 19.8–24.6 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `bright`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh S02 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
