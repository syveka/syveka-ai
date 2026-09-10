-- P1 correctness hardening: a duplicate/retried Creator Studio generation
-- HTTP request (e.g. a client network retry) could previously create a
-- second, independent CreatorGeneration row, reserve credits a second
-- time, and potentially trigger a second paid provider call, since nothing
-- tied a request to a stable client-supplied identity.
--
-- Adds two nullable columns and a scoped unique constraint that makes the
-- database itself the concurrency authority for "same logical request":
-- two concurrent inserts for the same (organization_id, generation_type,
-- idempotency_key) can never both succeed — the loser gets a unique
-- violation and fetches the winner's row instead of creating its own.
--
-- Purely additive and backward compatible: a request that never sends an
-- Idempotency-Key stores NULL, and Postgres treats every NULL in a unique
-- index as distinct from every other NULL, so unlimited no-key generations
-- remain completely unrestricted by this constraint — verified against the
-- live table before writing this migration (idempotency_key does not yet
-- exist anywhere, so every existing row is unaffected).
ALTER TABLE "creator_generations" ADD COLUMN "idempotency_key" TEXT;
ALTER TABLE "creator_generations" ADD COLUMN "request_fingerprint" TEXT;

CREATE UNIQUE INDEX "creator_generations_organization_id_generation_type_idempot_key"
  ON "creator_generations" ("organization_id", "generation_type", "idempotency_key");
