# V03 — production notes

**What this ad claims, and on what basis.** Cleaning-company use case built only from pilot modules.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.4 s | `setpiece` | fade from black |
| 2 | 4.4–8.8 s | `gather` | zoom |
| 3 | 8.8–14.2 s | `pipeline` | up |
| 4 | 14.2–19.8 s | `chatQA` | side |
| 5 | 19.8–24.4 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `bright`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh V03 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
