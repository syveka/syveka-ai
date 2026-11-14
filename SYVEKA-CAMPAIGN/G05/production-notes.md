# G05 — production notes

**What this ad claims, and on what basis.** A day built only from pilot modules (calendar, booking link, assistant, CRM). No figures.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.4 s | `ring24` | fade from black |
| 2 | 4.4–9.2 s | `rowsCard` | up |
| 3 | 9.2–14.6 s | `chatQA` | zoom |
| 4 | 14.6–19.0 s | `quiet` | fade |
| 5 | 19.0–22.6 s | `calm` | fade |
| 6 | 22.6–27.2 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `warm`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh G05 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
