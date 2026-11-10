# Sentry staging triage, 2026-11-10

Scope: the seven unresolved issues in the `syveka-staging` Sentry project on 2026-11-10, against
`main` at `8b52850512ce6c4deeedd271d27ea2a1a134acff`. Every issue was read in Sentry; no event
data beyond what is quoted here was copied. Event messages are replaced by
`src/lib/observability/scrub.ts`, so "Error message withheld" means the original text was not in
its allowlist, not that Sentry lost it.

**Don't resolve any issue on the strength of this document.** An issue is resolved only after a
deployed build containing the fix has been exercised on the same route and the issue stops
recurring.

## Summary

| Issue                    | Title                       | Route                                                                  | Classification                                                                                                  | Fix                                                        |
| ------------------------ | --------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| SYVEKA-STAGING-3         | React error #418            | `/[locale]/chat/[conversationId]` (80%)                                | **Application defect**, still present on `main`                                                                 | `fix/chat-hydration-mismatch`                              |
| SYVEKA-STAGING-1, -5, -7 | `AuthError`                 | `GET /[locale]/dashboard`                                              | Expected state (user without an organization), reported because the page throws while its layout redirects      | `fix/page-guards-follow-layout`                            |
| SYVEKA-STAGING-8         | `AuthError`                 | `GET /[locale]/admin/organizations`                                    | Expected state (not a superadmin), same mechanism                                                               | `fix/page-guards-follow-layout`                            |
| SYVEKA-STAGING-4         | `Error` (withheld)          | `GET /[locale]/creator-studio` (25%), `/[locale]/invite/[token]` (75%) | Creator Studio part: expected state (feature off), same mechanism. Invite part: **unclassified**, older release | `fix/page-guards-follow-layout` (Creator Studio part only) |
| SYVEKA-STAGING-6         | `Error` (withheld), handled | `/[locale]/settings/business-dna`                                      | **Unclassified**: one event, 2026-10-20                                                                         | None                                                       |

## SYVEKA-STAGING-3: React error #418

**Evidence (Sentry):**

- Unhandled browser error, `auto.browser.global_handlers.onerror`.
- 12 events in total; the last on 2026-11-04 01:07 EET, from Helsinki.
- 80% on `/[locale]/chat/[conversationId]`. Breadcrumb: a navigation from that route to the same route.
- The events carry no release tag. Staging was last deployed from `b129d41` (2026-11-03), and the
  affected code is identical in `b129d41` and `main`.

**Root cause 1, every reopened conversation with a reply:**

- `useSpeechPlayback` computed `supported` from `window` during render
  (`src/hooks/use-speech-playback.ts`). On the server that is always `false`; in a browser with
  speech synthesis it is `true`.
- `ChatThread` renders the read-aloud control only when `supported` is true
  (`src/components/chat/chat-thread.tsx`, `MessageBubble`). So the browser's first render has a
  button the server HTML doesn't, and hydration fails.
- A new conversation (`/chat`) has no replies, so it isn't affected. That matches the route
  distribution.

**Root cause 2, a task card with a due time:**

- `ActionConfirmation` formatted `dueAt` with no `timeZone`
  (`src/components/chat/action-confirmation.tsx`). That uses the runtime's zone: UTC on Vercel, the
  local zone in the browser (UTC+2 in Finland).
- Example: `Due Thu, Nov 12, 10:30 PM` on the server against `Due Fri, Nov 13, 12:30 AM` in Helsinki.

**Fix:**

- Both values now come from `useSyncExternalStore` with a server snapshot (`false`). The server
  render and the hydration pass therefore match, and the read-aloud control and the due time appear
  right after hydration.
- What users see after hydration is unchanged. The due time is still formatted in the browser's
  zone. This is the same pattern `booking-widget.tsx` already uses for the same class of defect.

**Test:** `tests/unit/chat-thread-hydration.test.tsx`. It server-renders the thread without speech
synthesis in one zone, hydrates it with speech synthesis in another, and requires zero recoverable
hydration errors; then it checks that both browser-only parts appear.

- Before the fix: 3 of 7 tests fail with "Hydration failed because the server rendered HTML didn't
  match the client" (React 19's text for #418).
- After the fix: all 7 pass.

**Remaining risks:**

- `ActionConfirmation`'s initial state and `supersededActions` read `Date.now()` during render.
  - **When it can mismatch:** the page sends an action as pending only if it was unexpired at the
    server's `now`, and actions live 600 seconds (`ACTION_TTL_SECONDS`). A mismatch therefore needs
    the action to expire in the moment between the server render and hydration, or a device clock
    running ahead of the server by more than the action's remaining lifetime.
  - **Effect:** React recovers by re-rendering on the client, the user ends up with the correct
    card, and Sentry gets one #418 event. Nothing is executed or exposed: the server refuses an
    expired confirmation, and the card then shows "expired".
  - **Decision (2026-11-10):** not fixed before merge. A fix means changing the confirmation card's
    initial state machine, which sits in the Preview → Confirm → Execute flow, for one recoverable
    event. It stays a follow-up, worth taking only if Sentry still reports #418 on this route after
    deployment.
- The `bookMeeting` summary is formatted with an explicit zone, but its text comes from the
  runtime's ICU data. A browser with older ICU data than Node could in theory differ. Not observed.
- 20% of this issue's events are on other routes, which Sentry's tag view didn't list. The issue
  was first seen in October, when `/[locale]/book/[org]/[slug]` had a known #418, since fixed (see
  `tests/unit/booking-widget-hydration.test.tsx`).

## SYVEKA-STAGING-1, -5, -7 and -8: `AuthError` on page renders

**Evidence (Sentry):**

- Server-side events, `auto.function.nextjs.on_request_error`, `route_type: render`.
- The releases (`54e28a32ac83`, `40668bf7748e`, `19581f274e87`) are `main` commits, each deployed to
  staging by a `staging-release.yml` run (2026-10-31 and 2026-11-01).
- That workflow's e2e suite signs in a user with no organization
  (`tests/e2e/auth-journeys.spec.ts`, "a genuine new user with no organization lands on
  onboarding"), whose login lands on `/dashboard`.

**Mechanism:**

- Next.js renders a layout and its page in parallel.
- `(app)/layout.tsx` redirects a user without a usable membership to `/onboarding`. That redirect
  is what the user gets (the e2e test passes).
- The dashboard page still ran `requirePermission("crm:read")`, which threw
  `AuthError("No organization membership", 403)` and was reported to Sentry.
- `(superadmin)/layout.tsx` and the admin organization pages behave the same way with
  `requireSuperadmin()`.

**Classification:** an expected state, not an expired session or a deployment error. Users see the
correct redirect; the defect is that an expected state is reported as an unhandled error, which
buries real failures.

**Fix:** `src/server/auth/page-guard.ts`.

- `requirePagePermission` redirects to `/onboarding` exactly when the `(app)` layout does. A missing
  permission still throws an audited 403.
- `requireSuperadminPage` redirects to `/dashboard` on an `AuthError`, as the `(superadmin)` layout
  does. Any other error is rethrown.
- The fix is used by the dashboard and both admin organization pages.
- Sentry reporting itself is unchanged: real failures (database, auth service) still propagate.
- **Auth-service outages stay visible.** Supabase Auth reports both "no valid session" and "the
  service failed" as no user. `isAuthServiceFailure` (`src/server/auth/auth-service-failure.ts`)
  separates them, using auth-js's own error classes:
  - **Outage:** a network failure or timeout, 5xx, 429, or an unreadable response.
  - **Expected:** a missing session, or an invalid, expired or revoked token.
  - **During an outage:** the page guards throw `AuthServiceUnavailableError` instead of
    redirecting, so the outage is reported.
  - **Unchanged:** the layouts still redirect during an outage, as they did before. Middleware
    already sends a signed-out-looking request to `/login`, and logs
    `middleware_session_check_failed`.

## SYVEKA-STAGING-4: `Error` (withheld) on `/creator-studio`

**Evidence:**

- Server render, with a stack through `creator-studio/page.js`.
- Creator Studio is off on staging. The layout then shows its "feature disabled" view without the
  page.
- The page still ran, and its data reads (`listCreatorProfiles`, `listCreatorPosts`) throw
  `FeatureDisabledError`, which sets no `name` and so reports as `Error`.

**Fix:** the overview page returns nothing while the feature is off.

**Not fixed in this change:**

- 75% of this group's events are on `/[locale]/invite/[token]`, from an older release
  (`c0972b01740e`, 2026-10-13). Their origin isn't established from the scrubbed data.
- The other Creator Studio subpages have the same latent behaviour while the feature is off.

## SYVEKA-STAGING-6: handled `Error` on Business DNA settings

**Evidence:**

- One handled browser event, 2026-10-20 17:02 EEST, right after a `POST` to the same page.
- Geography: Boydton, US, a Microsoft data-centre location, consistent with a CI runner rather than
  a person (not proven).

**Classification:** unclassified. There's not enough evidence for a code change; watch for recurrence.

## Latent issues found, not fixed

- Every other page under `(app)` that calls `requirePermission` reports the same `AuthError` for a
  user without an organization who opens its URL directly. It's not observed in Sentry; it's a
  mechanical follow-up with `requirePagePermission`.
- Some pages require a permission their layout doesn't, for example Creator Studio analytics
  (`analytics:view`) and settings pages for MEMBER and VIEWER. A denial there is a genuine 403 and
  is still reported.

## After deployment

1. Deploy staging with both fixes, after separate authorization.
2. Open a conversation with an assistant reply in a browser with speech synthesis, at least one
   with a task that has a due time. The browser console shows no hydration error, and the
   read-aloud control appears.
3. Sign in as the no-organization e2e user; open `/admin/organizations` as a non-superadmin; open
   `/creator-studio` with the feature off. No new events appear in SYVEKA-STAGING-1, -5, -7, -8 or
   the Creator Studio part of -4.
4. Resolve an issue only after it has stayed quiet through such a run, and through at least one
   later `staging-release.yml` e2e run.
