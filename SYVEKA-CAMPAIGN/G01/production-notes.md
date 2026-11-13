# G01 — production notes

**What this ad claims, and on what basis.** Hero line is the product's own landing-page headline in all three languages. Names only pilot modules (chat, CRM, booking, knowledge base).

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.6 s | `aiHook` | fade from black |
| 2 | 4.6–9.6 s | `montage` | cut |
| 3 | 9.6–14.2 s | `ecosystem` | zoom |
| 4 | 14.2–19.8 s | `chatQA` | up |
| 5 | 19.8–23.4 s | `statement` | fade |
| 6 | 23.4–28.2 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `luxe`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh G01 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
