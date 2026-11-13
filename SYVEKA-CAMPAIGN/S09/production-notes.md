# S09 — production notes

**What this ad claims, and on what basis.** Interface in Finnish, English and Arabic with right-to-left layout.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–5.0 s | `montage` | fade from black |
| 2 | 5.0–11.0 s | `triLang` | zoom |
| 3 | 11.0–15.2 s | `statement` | fade |
| 4 | 15.2–19.2 s | `ctaTap` | zoom |
| 5 | 19.2–24.0 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `future`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh S09 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
