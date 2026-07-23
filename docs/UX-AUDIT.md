# Syveka AI — UX/UI Audit

Snapshot date: **2026-07-23**. This pass is **static code analysis only** — the dev server was
not launched and no browser/visual verification was performed. Findings below are precise about
what was verified vs. what remains unverified; do not treat the "unverified" items as passing.

## Route-by-route summary

| Route area | Localization | Loading/error UX | Notes |
|---|---|---|---|
| Landing (`(marketing)/page.tsx`) | Localized | Default only | Content not deep-read; no placeholder markers (`TODO`/`Coming soon`) found repo-wide |
| Auth (login/register/forgot/reset/verify) | Localized | Default only | Functionally complete per architecture audit |
| Onboarding | **Hardcoded English, no Arabic string at all** | Default only | `onboarding-form.tsx` uses `locale === "fi" ? ... : ...` ternaries instead of `useTranslations` for most copy |
| Dashboard | Localized (2 usages) | **Only route with `loading.tsx`/`error.tsx`** | `DashboardSkeleton` fallback, localized retry-error card — this is the reference pattern to replicate elsewhere |
| CRM (contacts/companies/deals) | Localized (12 usages) | Default only | Functionally complete |
| Calendar / Booking | Localized (6 usages) | Default only | Public booking pages localized; RTL logical-property discipline confirmed in at least one related file |
| AI Chat | Localized (per-component, in leaf components not route files) | Default only | SSE UI, error alert rendered via i18n key with generic fallback |
| Knowledge Base | Localized | Default only | Upload dropzone + document table |
| Voice | Localized (6 usages) | Default only | Confirmed explicit empty-state UI |
| Settings — Organization | **Partially hardcoded** | Default only | Only `common.save/error/loading` translated; all field labels/descriptions/placeholders are literal English (e.g. "Company name", "AI instructions") |
| Settings — Profile | **Partially hardcoded** | Default only | Same pattern — "Name", "Language", "Timezone" hardcoded |
| Settings — Members | **Fully hardcoded (0 `useTranslations` calls)** | Default only | `members-table.tsx`, `invite-form.tsx` — role labels rendered as raw enum strings (`ADMIN`, `MANAGER`) |
| Settings — API keys | **Fully hardcoded (0 `useTranslations` calls)** | Default only | `api-keys-manager.tsx` |
| Settings — Billing | Localized (part of 8 settings usages) | Default only | Plan cards + usage meters |
| Superadmin | **Fully hardcoded English** | Default only | Arguably acceptable for an internal ops-only surface, but inconsistent with the rest of the app's localization discipline |

## Localization infrastructure vs. coverage

**Infrastructure is complete and rigorously guarded**: `messages/{en,fi,ar}.json` at 488/488/488
keys, zero parity drift, enforced by `npm run i18n:check` in CI on every PR. `RTL_LOCALES`
correctly includes Arabic; the root locale layout sets `<html dir="rtl">` globally for Arabic.

**Coverage is inconsistent**: the components listed above bypass the (complete) message catalog
entirely with hardcoded English. This is the clearest, most actionable UX gap in the codebase —
the infrastructure to fix it already exists, it's a matter of routing these components through
it. See `FEATURE-INVENTORY.md` for the per-feature next-step and `NEXT-STEPS.md` for sequencing.

## RTL (Arabic) findings

- Global mechanism verified: `dir` attribute correctly toggles at the root layout.
- At least one component (`superadmin/layout.tsx`) uses Tailwind logical properties
  (`ms-auto`) correctly.
- **Unverified**: whether dense, fixed-horizontal-layout views — the deal Kanban board
  (`deal-board.tsx`) and the calendar week/day grid (`calendar-view.tsx`) — actually mirror
  correctly under `dir="rtl"`. No component-level RTL override or systematic logical-property
  audit was found or performed. This needs either a live-app visual check in Arabic or a closer
  line-by-line CSS read of those two components specifically.

## Finnish localization findings

Finnish is the default locale (`Locale.FI` default throughout the schema, `defaultLocale`
default on `Organization`) and appears to have the deepest coverage — the onboarding form's
hardcoded ternaries default to Finnish-or-English, meaning **Finnish users see reasonable
copy even where the component bypasses the catalog; Arabic users do not** (no Arabic branch in
those ternaries at all). This makes the Arabic gap strictly worse than the general "hardcoded
English" framing suggests — Arabic users hit raw English text more often than Finnish users hit
raw English text, on the exact same unlocalized components.

## Accessibility findings — Unverified

No automated accessibility audit (axe, Lighthouse, or manual screen-reader pass) was performed
in this static-analysis-only pass. Recommend running one before production launch. No obvious
anti-patterns (e.g., missing `alt` text conventions, `role="alert"` on chat errors is present)
were incidentally noticed, but this is not a substitute for a real audit.

## Mobile responsiveness findings — Unverified

Not visually tested. Tailwind is used throughout, which supports responsive utilities, but no
systematic verification of breakpoint behavior on the calendar grid, deal Kanban board, or chat
composer was performed. Recommend a manual pass at common mobile widths before launch.

## Incomplete workflows

- **Organization self-serve deletion**: the settings UI has no delete-organization control at
  all (see `FEATURE-INVENTORY.md`) — a UI gap paired with a real backend gap, not just a UX
  polish item.
- No other UI-elements-not-connected-to-backend or backend-features-lacking-UI were found; the
  architecture audit's feature-by-feature review found consistent UI↔backend wiring everywhere
  else checked.

## Priority improvements (ordered)

1. Localize `members-table.tsx`, `invite-form.tsx`, `api-keys-manager.tsx` (zero-effort wins —
   catalog keys likely already exist or are trivial to add; these are the most visibly
   unfinished-looking surfaces to any non-English user).
2. Localize `organization-form.tsx` and `profile-form.tsx` field labels/placeholders.
3. Add Arabic (and complete Finnish) branches to `onboarding-form.tsx`, or better, migrate it to
   `useTranslations` entirely rather than inline ternaries.
4. Add `loading.tsx`/`error.tsx` to at least the highest-traffic routes (chat, CRM list views,
   calendar) using the existing `/dashboard` pattern as the template.
5. Run a real RTL visual check on the deal Kanban board and calendar grid.
6. Run an automated accessibility pass and a mobile-breakpoint pass before production launch.
