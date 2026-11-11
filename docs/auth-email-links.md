# Auth email links that work on any device

## Why

Supabase's default email templates link through Supabase and back to
`/api/auth/callback?code=…` (PKCE). Exchanging that `code` needs the code verifier
that Supabase stored in the browser that _requested_ the email. A link opened anywhere
else (a phone's mail app, another browser) has no verifier, the exchange fails, and the
user lands on `/login?error=auth_callback_failed`. For password reset that makes the
journey impossible across devices; sign-up confirmation and magic links fail the same way.

The fix Supabase documents for server-side apps is a token-hash link: the email links
straight to the app with `token_hash` and `type`, and the server calls
`supabase.auth.verifyOtp({ token_hash, type })`. No verifier is needed, so it works in
any browser.

## What the app does

`src/app/api/auth/callback/route.ts` now accepts both:

| Query                     | Handling                                                               |
| ------------------------- | ---------------------------------------------------------------------- |
| `code` (present)          | `exchangeCodeForSession(code)`, exactly as before                      |
| `token_hash` + `type`     | `verifyOtp({ token_hash, type })`, session cookies set on the redirect |
| anything else / any error | `/<locale>/login?error=auth_callback_failed` (keeps an invitation)     |

- `type` must be one of `email`, `signup`, `magiclink`, `recovery`. `invite` and
  `email_change` are refused: invitations are sent by the app (Resend), not Supabase,
  and the app does not change email addresses through Supabase.
- `next` goes through `safeInternalNext` as before (internal paths only, default
  `/dashboard`).
- `type=recovery` always lands on `/<locale>/reset-password`, whatever `next` says; the
  locale comes from `next`.
- The token hash is never logged and never put into a redirect URL.

**Until the templates below are changed, nothing changes for users**: Supabase keeps
sending `code` links, which take the unchanged code path. The code can therefore be
deployed before the templates are edited.

## Owner action: change the email templates

Supabase dashboard → Authentication → Emails → Templates (for each project: Staging,
then Production). Replace only the link `href`; keep the rest of each template.

The server actions pass a full callback URL as `redirectTo` / `emailRedirectTo`
(`authCallbackUrl` in `src/actions/auth.ts`), and it always already carries the locale
and, for invitations, the continuation, for example
`https://<app-host>/api/auth/callback?next=%2Fen%2Freset-password`. Supabase exposes that
value as `{{ .RedirectTo }}`, so the templates append to it instead of hard-coding a
`next`. Because it already contains `?next=…`, the extra parameters start with `&`.

| Template       | Link (`href`)                                                 |
| -------------- | ------------------------------------------------------------- |
| Confirm signup | `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email`    |
| Reset password | `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery` |
| Magic link     | `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email`    |

Example: `<a href="{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=recovery">Reset password</a>`

Do not change the Invite user or Change email address templates (not used by the app).

### Redirect allow-list (required)

Supabase only uses `redirectTo` if it matches Authentication → URL Configuration →
Redirect URLs. Otherwise it silently substitutes the Site URL, and the links above would
become `https://<site>&token_hash=…`, which does not work. Make sure the list has, per
environment:

- `https://<app-host>/api/auth/callback**`

(`<app-host>` is the `NEXT_PUBLIC_APP_URL` host of that environment.) The current `code`
links depend on the same entry, so it should already exist; check it anyway.

A fallback that does not depend on `redirectTo` is
`{{ .SiteURL }}/api/auth/callback?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`,
but it loses the user's locale (falls back to Finnish) and the invitation continuation,
and only works if the Site URL is the app URL. Use it only if the recommended links
cannot be made to work.

## Verify (owner)

On Staging first, after deploying this change and editing the templates:

1. On a laptop, open `/en/forgot-password` and request a reset for a test account.
2. Open the email **on a phone** (not the laptop browser). The link should start with
   the app host and contain `/api/auth/callback?next=…&token_hash=…&type=recovery`.
3. Tap it: the phone shows the English reset-password form, not the login page. Set a
   new password and confirm you reach the dashboard.
4. Tap the same link again: it is single-use, so you land on the login page with the
   "link could not be completed" notice.
5. Repeat with a new registration (Confirm signup) and, if used, a magic link: opened on
   the phone, each lands signed in on onboarding / the dashboard.
6. Register from an invitation link in Arabic, open the confirmation on another device:
   it lands on `/ar/invite/<id>`.

If step 2 shows a link starting with the Site URL followed by `&token_hash`, the
redirect allow-list entry is missing or does not match. Don't tap such a link: the browser
reads everything up to the first `/` as a host name and sends it, hash included, to the DNS
resolver. Fix the allow-list, request a new email, and only then change Production's templates.

## Known limits

- Email security scanners that pre-open links can consume a single-use link before the
  user does. This was already true of `code` links and is not changed here.
- The login page's failure notice says to log in with email and password; for someone
  resetting a password that is misleading (the "Forgot password" link is on the same
  page). With token-hash links this notice should appear only for expired or reused
  links.
