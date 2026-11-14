# V02 — production notes

**What this ad claims, and on what basis.** Workshop use case built only from pilot modules.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.4 s | `ringing` | fade from black |
| 2 | 4.4–9.4 s | `booking` | side |
| 3 | 9.4–14.8 s | `pipeline` | up |
| 4 | 14.8–19.8 s | `weekView` | side |
| 5 | 19.8–24.4 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `drive`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh V02 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
