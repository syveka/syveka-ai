# S01 — production notes

**What this ad claims, and on what basis.** Assistant answers from profile, documents and CRM; proposes actions that are saved only after confirmation; says when it cannot confirm. Typed chat only: no voice is shown.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.2 s | `aiHook` | fade from black |
| 2 | 4.2–9.8 s | `chatQA` | up |
| 3 | 9.8–14.6 s | `sectors` | side |
| 4 | 14.6–19.8 s | `rowsCard` | up |
| 5 | 19.8–23.4 s | `statement` | fade |
| 6 | 23.4–28.0 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `future`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh S01 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
