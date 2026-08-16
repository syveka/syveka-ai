-- Hardens the business_dna and business_dna_services UPDATE RLS policies
-- with an explicit WITH CHECK clause.
--
-- Root cause: both policies were created with only a USING clause
-- (organization_id = auth_org_id()). USING alone is evaluated against the
-- row's state BEFORE the update to decide whether the row is even visible
-- for the UPDATE to touch; PostgreSQL does not otherwise verify that the
-- RESULTING row still satisfies the policy. Without WITH CHECK, a member
-- of organization A who is authorized to update a row they currently own
-- could, in principle, execute an UPDATE that also changes organization_id
-- to organization B -- moving the row out of their own tenant into
-- another one they have no authorization for. Every other tenant-scoped
-- write path in this schema (INSERT ... WITH CHECK, and now this) already
-- prevents the equivalent smuggling attempt at INSERT time; this migration
-- closes the same gap for UPDATE.
--
-- Fix: add WITH CHECK (organization_id = auth_org_id()) so PostgreSQL also
-- validates the row AFTER the update -- a write that would leave the row
-- under any organization_id other than the caller's own is rejected by the
-- database itself, independent of application-layer validation.
--
-- ALTER POLICY without an explicit USING clause leaves the existing USING
-- clause untouched; only WITH CHECK is added here. DELETE policies on both
-- tables are unaffected (already role-restricted, no reassignment risk
-- since DELETE has no resulting row to check).
ALTER POLICY business_dna_update ON public.business_dna
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY business_dna_services_update ON public.business_dna_services
  WITH CHECK (organization_id = auth_org_id());
