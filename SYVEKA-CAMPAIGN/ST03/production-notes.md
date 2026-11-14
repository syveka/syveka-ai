# ST03 — production notes

**What this ad claims, and on what basis.** Captions in FI/EN/AR and publishing to Instagram and Facebook as documented; TikTok and YouTube are not mentioned because they are not implemented. Early-access CTA.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–5.0 s | `montage` | fade from black |
| 2 | 5.0–11.0 s | `triLang` | zoom |
| 3 | 11.0–16.0 s | `sectors` | side |
| 4 | 16.0–20.0 s | `ctaTap` | zoom |
| 5 | 20.0–25.0 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `drive`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh ST03 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
