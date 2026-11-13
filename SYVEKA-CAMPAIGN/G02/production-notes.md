# G02 — production notes

**What this ad claims, and on what basis.** Describes the pilot package as one workspace. No outcome is quantified.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.6 s | `storm` | fade from black |
| 2 | 4.6–9.2 s | `scatter` | fade |
| 3 | 9.2–13.8 s | `gather` | zoom |
| 4 | 13.8–19.0 s | `features` | up |
| 5 | 19.0–22.8 s | `calm` | fade |
| 6 | 22.8–27.4 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `tension`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh G02 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
