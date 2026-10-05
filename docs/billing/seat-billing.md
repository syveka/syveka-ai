# Seat billing: included seats + paid extra seats

**Status (2026-10-05):** the infrastructure is implemented, but **no extra-seat charge is active**. Extra-seat Stripe prices and the proration policy aren't approved yet. Seat limits are still enforced by `PLAN_LIMITS[plan].maxSeats`.

## Decision

- **Model:** included seats + paid extra seats.
- **Formula:** `billable extra seats = max(active seats − included seats, 0)`, and 0 unless the plan's extra seats are `paid`.

| Plan                              | Included seats | Extra seats                        |
| --------------------------------- | -------------- | ---------------------------------- |
| FREE                              | 1              | none: can't be bought              |
| STARTER                           | 2              | paid (price not approved)          |
| PRO (future name "Growth")        | 5              | paid (price not approved)          |
| ENTERPRISE                        | by contract    | custom: not billed by this formula |
| BUSINESS (future plan, not added) | 15             | paid                               |

The source of truth is `SEAT_BILLING_POLICY` in `src/lib/billing/plan-catalog.ts`.

## What a billable seat is

A row in `organization_members` of an organization with `deleted_at IS NULL`.

- Removing a member deletes the row.
- Users have no soft delete.
- Pending invitations aren't members.
- Every count is scoped to one organization.

The count comes from `countActiveSeats(orgId)` in `src/server/services/billing/seats.ts`.

## Implemented now (no Stripe writes)

- **`computeSeatBilling(plan, activeSeats)`:** the pure formula above.
- **Enforcement at join** (`acceptInvitation`):
  - takes a per-organization advisory lock, `pg_advisory_xact_lock(hashtext(orgId), 3)`, in its own key domain apart from the calendar locks;
  - refuses deleted organizations and read-only (long past-due) workspaces;
  - re-counts members in the transaction against the plan's current `maxSeats`.

  Previously only inviting was checked, so pending invitations could be accepted beyond the plan, and concurrent acceptances weren't serialized.

- **Invite check:** counts members plus pending, unexpired invitations to other addresses.
- **Audit:** `member.join` and `member.remove` record `activeSeats`. `billing.extra_seats_synced` (system actor) records each quantity change made by the reconciler.
- **`reconcileSeatBilling(orgId, gateway)`:** provider-neutral convergence through a `SeatBillingGateway`.
  - **Convergence:** read the membership, compare with the provider's extra-seat quantity, write only on a difference, then read again. Of two concurrent runs, the last writer also verifies last.
  - **Idempotency key:** `sha256(orgId | subscriptionId | sorted membership row ids | quantity)`. A repeated event can't double-apply, and an unchanged quantity with a changed member set still writes.
  - **Not billable** (never writes): deleted organization, no paid subscription (`ACTIVE`, `TRIALING` or `PAST_DUE` with a Stripe id), FREE, ENTERPRISE.
  - **Provider failure:** a retryable `failed` result; nothing is assumed written and nothing is granted.

## Remaining integration (needs the Stripe and proration decision)

1. **Stripe prices.** Per plan, a base price at quantity 1, plus an **extra-seat price** at quantity = billable extra seats, monthly and annual. New `STRIPE_PRICE_*_EXTRA_SEAT_*` variables, validated per integration in `src/env.ts`.
2. **Checkout.** Line items become base (quantity 1) plus extra seats (`computeSeatBilling(...).billableExtraSeats`, omitted when 0), replacing today's `quantity = members.length`.
3. **A `StripeSeatBillingGateway`.** It finds the subscription item whose price is the plan's extra-seat price, and reads or updates its quantity:
   - with the idempotency key above;
   - with a `proration_behavior` set to the approved policy;
   - adding the item when the quantity first becomes positive.
4. **Webhook.** `customer.subscription.updated` should store the confirmed extra-seat quantity, for example in a new `Subscription.extraSeats` column, which needs a migration. Today `seats` stores the single item's quantity.
5. **Triggering.** After each membership change commits, run the reconciler from a QStash job (dedupe id `seat-sync:<orgId>`; a 5xx retries). Also run it after plan changes from the webhook, and nightly as a backstop.
6. **The enforcement policy when billing lags** (owner decision). Recommended: a join beyond the included seats is allowed only while the provider has confirmed enough capacity. Otherwise, either attempt the reconciler synchronously and refuse on `failed`, or allow the join and bill on the next successful run. Neither may grant seats beyond `maxSeats`.
7. **`maxSeats`** may then become the hard cap on included plus purchasable seats per plan (also an owner decision).

## Not changed

Prices, `maxSeats`, the `PRO` name, Stripe products or prices, and checkout. Nothing is merged or deployed by this work.
