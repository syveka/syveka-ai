# G03 — production notes

**What this ad claims, and on what basis.** States the documented offer: a free, controlled pilot for a limited number of Finnish businesses. No price or upgrade path is mentioned.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.2 s | `setpiece` | fade from black |
| 2 | 4.2–9.4 s | `checklist` | up |
| 3 | 9.4–14.4 s | `sectors` | side |
| 4 | 14.4–19.4 s | `steps` | up |
| 5 | 19.4–23.2 s | `ctaTap` | zoom |
| 6 | 23.2–27.8 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `bright`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh G03 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
