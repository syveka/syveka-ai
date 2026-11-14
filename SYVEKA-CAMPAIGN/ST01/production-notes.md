# ST01 — production notes

**What this ad claims, and on what basis.** Syveka Studio (Creator Studio in the product): image, video, caption, approval, scheduling and publishing exist in the codebase but the feature is off by default and enabled per organisation, so the CTA is "Ask about early access".

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.4 s | `setpiece` | fade from black |
| 2 | 4.4–10.0 s | `sectors` | up |
| 3 | 10.0–15.6 s | `postCard` | zoom |
| 4 | 15.6–20.6 s | `weekView` | side |
| 5 | 20.6–25.6 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `bright`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh ST01 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
