# H03 — production notes

**What this ad claims, and on what basis.** Motion-graphics hologram rendition; claims limited to the typed assistant and confirm-before-act.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.8 s | `holo` | fade from black |
| 2 | 4.8–10.2 s | `holo` | cut |
| 3 | 10.2–15.8 s | `chatQA` | up |
| 4 | 15.8–21.0 s | `rowsCard` | side |
| 5 | 21.0–25.8 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `future`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh H03 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
