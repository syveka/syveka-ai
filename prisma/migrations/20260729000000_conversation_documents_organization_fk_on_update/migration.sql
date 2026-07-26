-- conversation_documents_organization_id_fkey predates this project's ON UPDATE
-- CASCADE convention: 20260715000000_ai_chat_production_hardening created it with no
-- ON UPDATE clause (Postgres default NO ACTION), and
-- 20260715230000_security_invariant_corrections upgraded this table's other two
-- foreign keys (conversation_id, document_id) to composite keys with ON UPDATE CASCADE
-- but intentionally left this single-column one untouched. No later migration ever
-- corrected it. NOT VALID + VALIDATE CONSTRAINT avoids a full-table lock/scan while
-- still guaranteeing every existing row satisfies the (unchanged) reference by the end
-- of this migration.

ALTER TABLE "conversation_documents"
  DROP CONSTRAINT "conversation_documents_organization_id_fkey";
ALTER TABLE "conversation_documents"
  ADD CONSTRAINT "conversation_documents_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE NOT VALID;
ALTER TABLE "conversation_documents"
  VALIDATE CONSTRAINT "conversation_documents_organization_id_fkey";
