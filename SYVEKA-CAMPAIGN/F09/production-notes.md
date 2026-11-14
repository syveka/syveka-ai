# F09 — production notes

**What this ad claims, and on what basis.** FUTURE SERVICE. Not available today. Every scene carries a "Coming soon" badge, the end card says "Coming soon — not yet available", and the copy uses conditional wording. Publish only as a teaser; do not target it as a current offer.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.6 s | `calendar` | fade from black |
| 2 | 4.6–10.0 s | `features` | up |
| 3 | 10.0–15.0 s | `weekView` | side |
| 4 | 15.0–19.0 s | `statement` | fade |
| 5 | 19.0–23.6 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `warm`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh F09 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
