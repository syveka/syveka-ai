# V04 — production notes

**What this ad claims, and on what basis.** Solo-entrepreneur use case built only from pilot modules.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.2 s | `setpiece` | fade from black |
| 2 | 4.2–9.6 s | `sectors` | up |
| 3 | 9.6–14.8 s | `weekView` | side |
| 4 | 14.8–18.6 s | `statement` | fade |
| 5 | 18.6–23.4 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `tension`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh V04 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
