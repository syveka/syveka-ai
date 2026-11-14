# F02 — production notes

**What this ad claims, and on what basis.** FUTURE SERVICE. Not available today. Every scene carries a "Coming soon" badge, the end card says "Coming soon — not yet available", and the copy uses conditional wording. Publish only as a teaser; do not target it as a current offer.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.0 s | `setpiece` | fade from black |
| 2 | 4.0–8.6 s | `repeat` | side |
| 3 | 8.6–13.4 s | `automate` | zoom |
| 4 | 13.4–18.4 s | `blueprint` | up |
| 5 | 18.4–22.4 s | `statement` | fade |
| 6 | 22.4–27.0 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `drive`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh F02 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
