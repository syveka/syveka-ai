# H02 — production notes

**What this ad claims, and on what basis.** Uses the owner-supplied reference clip, labelled as a dramatization, then the documented free-pilot offer.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.2 s | `footage` | fade from black |
| 2 | 4.2–8.4 s | `footage` | cut |
| 3 | 8.4–13.4 s | `sectors` | side |
| 4 | 13.4–17.2 s | `ctaTap` | zoom |
| 5 | 17.2–21.8 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `bright`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh H02 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
