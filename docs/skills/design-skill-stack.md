# Syveka Design Skill Stack — Specification

Status: **specification only**, NOW-classified per the roadmap in `docs/skills/AI-FOUNDATION.md`.
No new dependency was added; every stage below reuses infrastructure that already exists.

## What already exists (do not rebuild)

- **Design tokens**: `tailwind.config.ts` + `src/app/globals.css` — HSL CSS-variable tokens
  (colors, `--radius`, `--font-sans`/`--font-arabic`), plus an ESLint-enforced RTL logical-utility
  convention. This _is_ Syveka's design system today; it has never had a markdown explanation
  before this document.
- **Component provider**: `ui.component.provide` (shadcn-mcp) — registered in
  `syveka-skills/core/registry/data.ts`, status `REVIEW`. shadcn/ui is already the actual component
  library in `src/components/ui/`.
- **Component discovery**: `ui.component.discover` (twentyfirst-dev) — registered, status
  `REVIEW`, requires an API key and owner approval before any use (metered service).
- **Visual/media analysis**: `video.analyze` (claude-video) — registered, status `REVIEW`, not yet
  independently reviewed. The closest existing capability to "image/screenshot understanding";
  static image analysis for a Screenshot-to-UI skill would need its own review, not reuse of this
  entry as-is (different provider, same _class_ of risk — external tool consuming Syveka
  screenshots).
- **Browser QA**: Playwright (`tests/e2e/`) — the mechanism for the Visual QA loop below.

## The six skills

### 1. Brand Kit Skill

**Input**: logo, brand colors, typography, screenshots, existing website URL, or a free-text brand
description. **Output**: a structured token set in the _same shape_ as
`tailwind.config.ts`'s existing token names (never a parallel naming scheme) — colors, typography
scale, spacing scale, border radius, and a short prose "brand consistency rules" block. **Provider**:
none needed for the extraction itself (an LLM call via the existing `routeModel("chat")` or
`routeModel("deep")` task class handles image/description → structured tokens); a website-URL input
reuses `web.research`/Scrapling (already `VERIFIED`) for the fetch stage. **Status**: spec only —
no code in this pass. The output contract (a JSON object matching `tailwind.config.ts`'s token
names) is the one thing a future implementation must not deviate from, so a Brand Kit output can be
applied without a second translation layer.

### 2. Extract Design System Skill

**Input**: the current, approved Syveka UI (i.e., `tailwind.config.ts` + `globals.css` +
`src/components/ui/*`) — not an external reference. **Output**: a human-and-agent-readable summary
of colors, typography, spacing, radius, shadows, button/card/input variants, navigation patterns,
and responsive/RTL rules that a coding agent can cite before writing new UI, instead of re-deriving
Syveka's conventions from scratch on every task (as this session's own Business DNA investigation
had to do). **This is documentation, not a new system** — `docs/skills/design-skill-stack.md`
(this file) §"What already exists" is the first version of that extraction; a fuller one is a NEXT
item, not built here.

### 3. UI/UX Review Skill

**Input**: a route or component to review. **Output**: findings against visual hierarchy, spacing,
typography, readability, responsive behavior, accessibility, mobile, RTL, loading/empty/error
states, CTA clarity, and consistency with the Extract Design System output above. **Provider**:
an LLM call (`routeModel("deep")` — this is exactly the "critical QA/security → independent review
model" task class from Phase 4) given the rendered HTML/screenshot plus the design-system summary
as context. **Relationship to Visual QA (skill 6)**: this skill reviews _design quality_
(subjective, judgment-based); Visual QA (skill 6) checks _conformance_ (expected vs. rendered,
closer to a regression test) — related but distinct jobs, not the same skill twice.

### 4. Web Design Guidelines Skill

A static, reusable checklist (not a runtime skill) for any AI coding agent about to write Syveka
frontend code: use the existing token names, never introduce a new color/spacing scale; check RTL
(`dir="rtl"`, logical properties, not `left`/`right`); check mobile viewport; reuse
`src/components/ui/*` before writing a new primitive; loading/empty/error states are not optional
per the existing `error.tsx` convention (`src/app/[locale]/(app)/dashboard/error.tsx`,
`.../inbox/error.tsx` — and now `.../settings/business-dna/error.tsx`, added on the
`fix/business-dna-onboarding-crash` branch). This list already exists informally as the pattern
this session's own business-dna crash-fix PR followed; formalizing it here means the next agent
doesn't have to rediscover it by reading five existing `error.tsx` files first.

### 5. Image/Screenshot-to-UI Skill

**Input**: a screenshot or reference image. **Output**: a Syveka-native implementation using
`src/components/ui/*` and the existing token system — never a pixel-identical clone of a third-party
interface (explicit non-goal per the mission brief: "Do NOT blindly clone proprietary interfaces").
**Provider**: an LLM call with vision input (`routeModel("deep")`) constrained to reason about
_layout and hierarchy_, then implement using Syveka's own primitives — the constraint belongs in
the skill's system prompt, not in a new piece of infrastructure. No code in this pass — this is a
prompt-engineering + review-gate concern, not an architecture gap.

### 6. Visual QA Skill

```
expected design → rendered page → browser inspection → visual/UX QA → issues → fix → re-test
```

**This loop is Playwright plus an LLM review step, not a new browser automation layer.**
`tests/e2e/business-dna.spec.ts` (added this pass, see `docs/skills/browser-qa.md`) is the
"rendered page" + "browser inspection" half already; a future increment would add a step that
feeds Playwright's screenshot output to an LLM call constrained by the Extract Design System
output (skill 2) and the UI/UX Review Skill (skill 3) — reusing both rather than building a third
review mechanism. Not built in this pass (no concrete feature yet needs the LLM-review half; the
Playwright half is real and running).

## What this pass actually shipped for Design

- This specification document.
- No new registry entries (shadcn-mcp/twentyfirst-dev/claude-video already exist at `REVIEW`
  — nothing new to add until one of them is actually reviewed for live use).
- No new code, no new dependency.

## Explicit non-goals for this pass

Do not build an automated Brand Kit extractor, an automated Screenshot-to-UI generator, or an
automated Visual QA LLM-review step. Each requires either a live component-provider connection
(shadcn-mcp/twentyfirst-dev, currently `REVIEW`) or a concrete product feature to justify the
build, per the mission's own "Do NOT start unrelated product features."
