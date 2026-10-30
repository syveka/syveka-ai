# Plan: `Subscription.pastDueSince` (the PAST_DUE read-only grace clock)

Status: **proposed, not implemented**. It adds a column, which CLAUDE.md §9 lists as a protected
change; implementation waits for explicit authorization. Written during the 2026-10-29/30
release-readiness sprint; the root cause was verified in code, nothing below was run.

## Root cause

`src/server/services/billing/entitlements.ts` turns an organization read-only when its
subscription has been `PAST_DUE` for 14 days, measured from `subscription.updatedAt`:

```ts
status === "PAST_DUE" &&
  sub?.updatedAt !== undefined &&
  Date.now() - sub.updatedAt.getTime() > 14 * 24 * 60 * 60 * 1000;
```

`updatedAt` is `@updatedAt`, so every write bumps it. During dunning Stripe emits
`invoice.payment_failed` **and** `customer.subscription.updated` on every Smart Retry (several a
week, for up to about four weeks), and both are written by `src/app/api/v1/webhooks/stripe/route.ts`:

- `applySubscriptionUpsert` (reached from `checkout.session.completed`,
  `customer.subscription.created/updated`, `invoice.paid`) upserts the row;
- `invoice.payment_failed` does an unconditional `updateMany({ data: { status: "PAST_DUE" } })`;
- `customer.subscription.deleted` does an `updateMany`.

So the 14-day clock restarts on every retry and the lockout lands about 14 days after the **last**
retry: an organization keeps paid limits for roughly five to six weeks after its last successful
charge. A transition-only `where` on the `payment_failed` write alone would not fix it, because
`customer.subscription.updated` rewrites the row too.

## Change

1. **Migration** `prisma/migrations/<timestamp>_subscription_past_due_since/migration.sql`:

   ```sql
   ALTER TABLE "subscriptions" ADD COLUMN "past_due_since" TIMESTAMP(3);
   UPDATE "subscriptions" SET "past_due_since" = "updated_at"
     WHERE "status" = 'PAST_DUE' AND "past_due_since" IS NULL;
   ```

   The backfill keeps today's exact behavior for rows already past due (measuring from "now"
   would grant them 14 extra days). Additive and nullable: the old code tolerates the column.

2. **Schema** (`prisma/schema.prisma`, model `Subscription`): `pastDueSince DateTime?
@map("past_due_since")` next to `trialEndsAt`. Run `npm run migrations:check`.

3. **Webhook** (`src/app/api/v1/webhooks/stripe/route.ts`):
   - `mayBecomeCurrent` also selects `pastDueSince` and hands it to `applySubscriptionUpsert`.
   - In the upsert: `const pastDue = SUB_STATUS_MAP[sub.status] === "PAST_DUE"`;
     `create: { pastDueSince: pastDue ? eventTime : null }`;
     `update: { pastDueSince: pastDue ? (current?.pastDueSince ?? eventTime) : null }`.
     `eventTime = new Date(event.created * 1000)`, so a late retry of an old event doesn't
     extend the grace. Clears on ACTIVE, TRIALING, CANCELED, INCOMPLETE and PAUSED.
   - `invoice.payment_failed`: `updateMany({ where: { organizationId, stripeSubscriptionId,
status: { not: "PAST_DUE" } }, data: { status: "PAST_DUE", pastDueSince: eventTime } })`,
     so an already past-due row is not touched at all.
   - `customer.subscription.deleted`: add `pastDueSince: null`.

4. **Entitlements** (`entitlements.ts`): `const since = sub.pastDueSince ?? sub.updatedAt;` and
   measure the 14 days from `since`. The fallback keeps a partially backfilled table safe.
   Update the comments at the `readOnly` field and the lockout, and optionally expose
   `pastDueSince` on `Entitlements` for the billing banner.

5. **Tests**:
   - `tests/unit/stripe-webhook.test.ts`: the first `payment_failed` sets `pastDueSince`; a second
     leaves it unchanged (and writes nothing); `customer.subscription.updated` with `past_due`
     preserves it; `invoice.paid` → ACTIVE clears it; `deleted` clears it; a checkout-created
     `past_due` subscription sets it.
   - `tests/unit/entitlement-grants.test.ts` (the lockout cases): `pastDueSince` 15 days old with
     `updatedAt` now → read-only (the bug); `pastDueSince` null with `updatedAt` 15 days old →
     read-only (fallback); `pastDueSince` 1 day old → not read-only.
   - Add `pastDueSince: null` to the subscription fixtures in the scoping tests.

6. **Rollout**: migrate before deploying the code (Prisma selects the new column). Rollback is
   the code revert; the column may stay, or be dropped in a later migration.

## Related decisions (not part of this change)

- `unpaid` (dunning exhausted) maps to `PAST_DUE`, which `PAYING_STATUSES` treats as paying.
  Mapping it to a non-paying status is a contract change for existing customers: separate
  approval.
- `pause_collection` (Portal "pause payment collection") is not read: the status stays `active`
  and the organization keeps paid limits while nothing is billed. Reading it in the upsert would
  be a small follow-up once the product decides what a paused customer may do.
- `Subscription.seats` is written from the checkout quantity and the Portal but never read:
  `maxSeats` comes from the plan table. Per-seat billing is displayed but not enforced.
