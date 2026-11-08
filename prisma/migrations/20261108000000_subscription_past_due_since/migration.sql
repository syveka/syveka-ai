-- The PAST_DUE read-only grace (14 days, src/server/services/billing/entitlements.ts)
-- was measured from subscriptions.updated_at, which every Stripe dunning
-- webhook write bumps, so the clock restarted on each Smart Retry.
-- past_due_since is set once, when the subscription enters PAST_DUE, and
-- cleared when it leaves it.
--
-- Rows already PAST_DUE are backfilled from updated_at, keeping their current
-- lockout date (measuring from now would grant them 14 extra days). Nullable
-- and additive: the code before this change ignores the column.
ALTER TABLE "subscriptions" ADD COLUMN "past_due_since" TIMESTAMP(3);

UPDATE "subscriptions" SET "past_due_since" = "updated_at"
  WHERE "status" = 'PAST_DUE' AND "past_due_since" IS NULL;
