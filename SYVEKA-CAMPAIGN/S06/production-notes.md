# S06 — production notes

**What this ad claims, and on what basis.** Day/week/month views and availability schedules. External calendar sync (Google/Microsoft) is not claimed.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.6 s | `calendar` | fade from black |
| 2 | 4.6–10.2 s | `weekView` | up |
| 3 | 10.2–15.2 s | `rowsCard` | side |
| 4 | 15.2–19.0 s | `statement` | fade |
| 5 | 19.0–23.8 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `warm`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh S06 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
