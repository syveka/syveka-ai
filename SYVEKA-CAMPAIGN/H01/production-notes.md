# H01 — production notes

**What this ad claims, and on what basis.** Uses the owner-supplied reference clip, labelled as a dramatization, followed by pilot-module scenes.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–3.6 s | `footage` | fade from black |
| 2 | 3.6–8.4 s | `footage` | cut |
| 3 | 8.4–14.0 s | `holo` | zoom |
| 4 | 14.0–19.4 s | `chatQA` | up |
| 5 | 19.4–24.2 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `tension`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh H01 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
