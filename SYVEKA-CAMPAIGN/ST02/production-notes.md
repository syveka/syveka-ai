# ST02 — production notes

**What this ad claims, and on what basis.** Approval modes (manual, approval, autopilot with rules) as documented for Creator Studio. Early-access CTA.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.2 s | `setpiece` | fade from black |
| 2 | 4.2–9.8 s | `rowsCard` | up |
| 3 | 9.8–15.0 s | `sectors` | side |
| 4 | 15.0–19.0 s | `statement` | fade |
| 5 | 19.0–24.0 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `luxe`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh ST02 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
