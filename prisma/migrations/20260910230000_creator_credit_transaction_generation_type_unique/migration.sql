-- P0 crash-recovery hardening: commitCreatorCredits and releaseCreatorCredits
-- currently write a CreatorCreditTransaction row and mutate the balance as two
-- separate, non-transactional statements, with no constraint preventing a
-- second COMMIT or RELEASE for the same generation (e.g. from a future
-- reconciliation pass repairing a COMPLETED/FAILED generation whose credits
-- were left RESERVED after a crash or transient DB error mid-commit).
--
-- This unique index makes the ledger itself the atomic claim: an INSERT
-- attempting a duplicate (generation_id, type) pair fails with a unique
-- violation (Prisma error P2002), which the application already catches and
-- treats as an idempotent no-op elsewhere (see ensureMonthlyCreditGrant's
-- existing CreatorCreditGrant P2002 handling in creator-credits.ts) — the
-- same pattern is reused for commit/release. NULL generation_id (GRANT/
-- ADJUSTMENT rows never tied to a specific generation) is unaffected: SQL
-- treats each NULL as distinct, so multiple such rows remain allowed.
--
-- Purely additive — no existing data violates this (verified against the
-- live table before writing this migration), and no column is altered.
CREATE UNIQUE INDEX "creator_credit_transactions_generation_id_type_key"
  ON "creator_credit_transactions" ("generation_id", "type");
