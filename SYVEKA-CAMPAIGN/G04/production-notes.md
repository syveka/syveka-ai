# G04 — production notes

**What this ad claims, and on what basis.** Uses the official tagline. Lists pilot modules as available and content creation, automations, voice and websites explicitly as coming soon.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.4 s | `network` | fade from black |
| 2 | 4.4–9.6 s | `sectors` | up |
| 3 | 9.6–14.8 s | `sectors` | side |
| 4 | 14.8–19.4 s | `ecosystem` | zoom |
| 5 | 19.4–24.2 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `luxe`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh G04 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
