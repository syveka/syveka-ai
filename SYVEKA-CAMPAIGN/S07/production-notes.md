# S07 — production notes

**What this ad claims, and on what basis.** Public booking link; guests can cancel or reschedule from a manage link. Described as a link to share, not an embeddable widget (embedding is blocked by the product's security headers). Confirmation e-mails are not promised.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.0 s | `setpiece` | fade from black |
| 2 | 4.0–8.4 s | `phoneTag` | side |
| 3 | 8.4–13.2 s | `linkShare` | zoom |
| 4 | 13.2–18.2 s | `booking` | side |
| 5 | 18.2–22.6 s | `quiet` | fade |
| 6 | 22.6–27.2 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `drive`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh S07 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
