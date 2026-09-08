# Composio Google Calendar PoC — script inventory

Full narrative and live evidence: [`docs/skills/composio-calendar-poc.md`](../../../docs/skills/composio-calendar-poc.md).

## For new work, use the library layer

- `lib/security-contract.ts` — the approved OAuth scopes, the approved
  four-tool execution allowlist, and fail-closed validators
  (`assertAuthConfigContract`, `assertTenantBindingContract`,
  `assertToolApproved`) that reject drift instead of silently tolerating it.
- `lib/response-normalizer.ts` — normalizes CREATE/GET/LIST/DELETE's
  inconsistent response shapes (discovered live - see the doc) into one
  consistent `NormalizedResult`.
- `lib/calendar-service.ts` — `CalendarService`: `listEvents` / `createEvent`
  / `getEvent` / `deleteEvent`, built on `tenant-binding.ts`'s real
  enforcement, the security contract, and the normalizer. This is the
  provider-facing abstraction future callers should use instead of writing
  another one-off script.
- `lib/audit.ts` — `CalendarAuditLog` / `withAudit`: safe, secret-scrubbed
  audit records for Calendar operations.
- Each `lib/*.ts` has a co-located `lib/*.test.ts` (run via
  `npx tsx <file>` - see "Running tests" below).

`../../live-smoke/composio-calendar-smoke.ts` is the reusable, opt-in live
roundtrip harness built on `CalendarService` - see that file's header for its
safety design and required environment variables. It never runs
automatically.

## Historical / evidentiary scripts (kept, not superseded)

These proved each phase of the PoC live, in order, and their results are
already recorded in the doc. They are **not** deleted or marked redundant -
each represents a real, once-only live verification step, and removing them
would remove the evidence trail for how this PoC's conclusions were reached.
New Calendar operations should use `CalendarService` above instead of adding
more scripts in this style.

| Script                                                                                        | What it proved                                                                                                    |
| --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `discover.ts`                                                                                 | Live tool/toolkit discovery against the real Composio API                                                         |
| `create-auth-config.ts`                                                                       | First (broad-scope) auth config creation attempt                                                                  |
| `test-scoped-auth-config.ts`                                                                  | Discovered the `scopes` + `tool_access_config` mutual-exclusivity 400                                             |
| `test-scopes-only-auth-config.ts`                                                             | Proved OAuth-scope least privilege in isolation                                                                   |
| `test-tool-execution-allowlist.ts`                                                            | Proved tool-execution least privilege as a second, independent boundary                                           |
| `tenant-binding.ts` / `tenant-binding.negative-test.ts`                                       | The tenant-binding enforcement design itself and its adversarial test suite (actively maintained, not superseded) |
| `create-oauth-link.ts`                                                                        | Pre-OAuth human-gate link generation (actively maintained - retargeted at the custom auth config)                 |
| `update-auth-config-scope.ts`                                                                 | The minimum-necessary scope expansion (`calendar.events` → `+calendar.calendars.readonly`)                        |
| `post-oauth-verify-and-list.ts`                                                               | Post-OAuth connection verification + one read-only LIST                                                           |
| `event-roundtrip.ts`                                                                          | First CREATE→GET→DELETE attempt (surfaced the `calendars.get` scope gap)                                          |
| `list-events-bounded.ts`, `create-event-only.ts`, `get-event-only.ts`, `delete-event-only.ts` | The final, phase-by-phase custom-OAuth roundtrip (LIST/CREATE/GET/DELETE each independently authorized and run)   |

## Running tests

Every `lib/*.test.ts` and `tenant-binding.negative-test.ts` is a standalone,
dependency-free script (no vitest - root `vitest.config.ts` only discovers
`tests/unit/**`, so these run directly via `tsx`):

```bash
npx tsx scripts/poc/composio-calendar/tenant-binding.negative-test.ts
npx tsx scripts/poc/composio-calendar/lib/security-contract.test.ts
npx tsx scripts/poc/composio-calendar/lib/response-normalizer.test.ts
npx tsx scripts/poc/composio-calendar/lib/calendar-service.test.ts
npx tsx scripts/poc/composio-calendar/lib/audit.test.ts
```

None of these make network calls or require `COMPOSIO_API_KEY`.
