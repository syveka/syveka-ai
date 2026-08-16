-- Removes exactly the fixtures tests/rls/isolation-fixtures.sql creates, then
-- verifies they are actually gone -- this file fails loudly (raises an
-- exception, giving scripts/ci/run-rls-check.sh a non-zero exit) rather than
-- merely reporting that its DELETE statements executed without error. Run by
-- the administrative connection, via the harness's exit trap, after the
-- client-side assertions in tests/rls/isolation.sql complete -- whether they
-- passed, failed, or the client connection itself never succeeded.

delete from notifications
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from prompts
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from webhook_endpoints
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from voice_assistants
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from workflows
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from documents
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from collections
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from conversations
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from calendar_events
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from activities
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from deals
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from pipeline_stages
where pipeline_id in (
  select id from pipelines where organization_id in (
    '11111111-0000-4000-8000-000000000000',
    '22222222-0000-4000-8000-000000000000'
  )
);
delete from pipelines
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from tags
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from companies
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from teams
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from contacts
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from subscriptions
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from organization_members
where organization_id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from organizations
where id in (
  '11111111-0000-4000-8000-000000000000',
  '22222222-0000-4000-8000-000000000000'
);
delete from users
where id in (
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  'a0000000-0000-4000-8000-000000000001',
  'b0000000-0000-4000-8000-000000000002'
);

do $$
declare remaining int;
begin
  select count(*) into remaining
  from organizations
  where id in (
    '11111111-0000-4000-8000-000000000000',
    '22222222-0000-4000-8000-000000000000'
  );
  if remaining <> 0 then
    raise exception 'ISOLATION CLEANUP FAIL: % organization fixture row(s) remain', remaining;
  end if;

  select count(*) into remaining
  from users
  where id in (
    'a0000000-0000-4000-8000-000000000001',
    'b0000000-0000-4000-8000-000000000002'
  );
  if remaining <> 0 then
    raise exception 'ISOLATION CLEANUP FAIL: % user fixture row(s) remain', remaining;
  end if;

  select count(*) into remaining
  from contacts
  where organization_id in (
    '11111111-0000-4000-8000-000000000000',
    '22222222-0000-4000-8000-000000000000'
  );
  if remaining <> 0 then
    raise exception 'ISOLATION CLEANUP FAIL: % contact fixture row(s) remain', remaining;
  end if;

  -- Every table hardened by 20260817000000_tenant_update_rls_with_check_
  -- hardening cascades from organizations (ON DELETE CASCADE), so the
  -- delete above already removed them; this proves the cascade actually
  -- held rather than merely assuming it.
  select
    (select count(*) from teams where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from companies where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from pipelines where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from tags where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from deals where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from activities where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from calendar_events where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from conversations where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from collections where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from documents where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from workflows where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from voice_assistants where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from webhook_endpoints where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from prompts where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
    + (select count(*) from notifications where organization_id in ('11111111-0000-4000-8000-000000000000', '22222222-0000-4000-8000-000000000000'))
  into remaining;
  if remaining <> 0 then
    raise exception 'ISOLATION CLEANUP FAIL: % tenant-update-hardening fixture row(s) remain across teams/companies/pipelines/tags/deals/activities/calendar_events/conversations/collections/documents/workflows/voice_assistants/webhook_endpoints/prompts/notifications', remaining;
  end if;
end $$;
