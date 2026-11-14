# V01 — production notes

**What this ad claims, and on what basis.** Salon use case built only from pilot modules.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.4 s | `setpiece` | fade from black |
| 2 | 4.4–9.2 s | `linkShare` | zoom |
| 3 | 9.2–14.6 s | `contacts` | side |
| 4 | 14.6–20.0 s | `chatQA` | up |
| 5 | 20.0–24.6 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `warm`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh V01 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
