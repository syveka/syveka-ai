# F07 — production notes

**What this ad claims, and on what basis.** FUTURE SERVICE. Not available today. Every scene carries a "Coming soon" badge, the end card says "Coming soon — not yet available", and the copy uses conditional wording. Publish only as a teaser; do not target it as a current offer.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.6 s | `svcHook` | fade from black |
| 2 | 4.6–8.4 s | `wire` | up |
| 3 | 8.4–12.4 s | `wire` | fade |
| 4 | 12.4–17.2 s | `responsive` | zoom |
| 5 | 17.2–21.2 s | `statement` | fade |
| 6 | 21.2–25.8 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `bright`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh F07 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
