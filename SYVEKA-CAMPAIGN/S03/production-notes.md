# S03 — production notes

**What this ad claims, and on what basis.** Business profile ("Business DNA") holds services, hours and policies; the assistant can propose profile changes that the user confirms.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.2 s | `setpiece` | fade from black |
| 2 | 4.2–9.6 s | `form` | up |
| 3 | 9.6–15.0 s | `chatQA` | zoom |
| 4 | 15.0–20.2 s | `rowsCard` | up |
| 5 | 20.2–25.0 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `warm`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh S03 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
