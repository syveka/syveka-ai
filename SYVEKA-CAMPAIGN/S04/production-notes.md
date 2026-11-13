# S04 — production notes

**What this ad claims, and on what basis.** Contacts, notes and timelines. CSV import is not claimed because it does not exist.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.4 s | `setpiece` | fade from black |
| 2 | 4.4–10.0 s | `contacts` | side |
| 3 | 10.0–15.0 s | `rowsCard` | up |
| 4 | 15.0–18.8 s | `statement` | fade |
| 5 | 18.8–23.6 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `bright`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh S04 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
