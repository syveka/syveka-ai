-- Repository-wide RLS UPDATE-policy hardening (same class of gap fixed for
-- business_dna/business_dna_services by
-- 20260816000000_business_dna_rls_update_with_check).
--
-- Root cause: every table below carries an UPDATE policy with only a USING
-- clause. USING alone is evaluated against a row's state BEFORE the update,
-- to decide whether the row is even visible to touch -- PostgreSQL does not
-- otherwise verify that the RESULTING row still satisfies the policy.
-- Without WITH CHECK, an authenticated member who is authorized to update a
-- row they currently own could, in principle, also change its tenant-
-- ownership column in the same statement, moving the row to another
-- organization (or, for prompts, "promoting" an org-owned prompt to a
-- global/system one by nulling organization_id, since prompts_select treats
-- a NULL organization_id as globally visible).
--
-- Fix: add WITH CHECK re-validating the same predicate (organization_id, or
-- for notifications the row's real dual ownership) against the row AFTER
-- the write. ALTER POLICY without an explicit USING clause leaves the
-- existing USING clause untouched; only WITH CHECK is added here. DELETE
-- policies are unaffected (no resulting row to check; already role-
-- restricted where applicable).
--
-- Scope notes (see docs/security/RLS_UPDATE_WITH_CHECK_HARDENING.md for the
-- full audit):
--   - 14 mechanically-identical organization-scoped tables get
--     WITH CHECK (organization_id = auth_org_id()).
--   - prompts gets the same predicate: prompts_select already treats a NULL
--     organization_id as a global/system prompt invisible to this policy's
--     USING clause (organization_id = auth_org_id() is NULL, never true,
--     for a NULL row), so global prompts are untouched by this policy
--     either way -- the WITH CHECK only closes the org-owned-prompt
--     reassignment/promotion-to-global gap.
--   - notifications is genuinely dual-owned (organization_id AND user_id
--     are both real, independent columns); its WITH CHECK mirrors its own
--     notifications_select policy's existing predicate exactly, not the
--     generic organization_id-only shape, since a notification's true
--     access boundary is "belongs to this org AND this specific user".
--     Verified against the only app-layer UPDATE path
--     (src/server/services/notifications.ts markRead), which only ever
--     writes read_at and never organization_id/user_id.
--   - users_self_update (id = auth.uid()) is intentionally NOT touched
--     here: it is self-referential identity data, not tenant-owned data;
--     the only app-layer writes to `users` already go through the
--     unscoped/service-role connection (never through this RLS-gated
--     path); and `id` is both this table's primary key and the target of
--     many other tables' foreign keys, so reassigning it to an existing
--     user's id is already blocked by the primary-key constraint, and
--     reassigning it to an unused id is self-orphaning, not a cross-user
--     or cross-tenant attack. Documented as deferred, not silently
--     skipped.

ALTER POLICY activities_update ON public.activities
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY calendar_events_update ON public.calendar_events
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY collections_update ON public.collections
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY companies_update ON public.companies
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY contacts_update ON public.contacts
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY conversations_update ON public.conversations
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY deals_update ON public.deals
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY documents_update ON public.documents
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY pipelines_update ON public.pipelines
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY prompts_update ON public.prompts
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY tags_update ON public.tags
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY teams_update ON public.teams
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY voice_assistants_update ON public.voice_assistants
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY webhook_endpoints_update ON public.webhook_endpoints
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY workflows_update ON public.workflows
  WITH CHECK (organization_id = auth_org_id());

ALTER POLICY notifications_update ON public.notifications
  WITH CHECK (user_id = auth.uid() AND organization_id = auth_org_id());
