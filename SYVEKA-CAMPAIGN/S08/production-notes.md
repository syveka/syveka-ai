# S08 — production notes

**What this ad claims, and on what basis.** Five roles (Owner, Admin, Manager, Member, Viewer), audit log, per-organisation data isolation. No compliance claim ("GDPR compliant") is made.

## Scene timeline

| # | Time | Scene module | Transition in |
|---|---|---|---|
| 1 | 0.0–4.2 s | `setpiece` | fade from black |
| 2 | 4.2–9.8 s | `sectors` | up |
| 3 | 9.8–14.8 s | `rowsCard` | side |
| 4 | 14.8–18.8 s | `statement` | fade |
| 5 | 18.8–23.6 s | `end` | fade |

**Screens are illustrations.** Interface scenes are motion-graphics mock-ups labelled *Havainnekuva / Concept visual / صورة توضيحية*, not screenshots of the product.

**Score.** Mood `luxe`, synthesized in code by `_PIPELINE/audio.py`; no third-party audio.

**Brand.** Syveka has no logo file, so the end card sets the name "Syveka AI" in type, as the product's own navigation does. Colours follow the product's primary blue.

**Re-render.** `cd _PIPELINE && ./build.sh S08 fi` (or `en` / `ar`). Copy lives in `_PIPELINE/js/ads.js`.
