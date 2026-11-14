# H04 — production notes

**What this ad claims, and on what basis.** Motion-graphics hologram rendition; claims limited to the booking link and calendar.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.4 s | `phoneTag` | fade from black |
| 2 | 4.4–9.8 s | `holo` | zoom |
| 3 | 9.8–14.8 s | `booking` | side |
| 4 | 14.8–19.6 s | `weekView` | up |
| 5 | 19.6–24.2 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `drive`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh H04 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
