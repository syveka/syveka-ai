-- Removes exactly the fixtures tests/rls/inbox-dna-fixtures.sql creates, then
-- verifies they are actually gone -- this file fails loudly (raises an
-- exception, giving scripts/ci/run-rls-check.sh a non-zero exit) rather than
-- merely reporting that its DELETE statements executed without error. Run by
-- the administrative connection, via the harness's exit trap, after the
-- client-side assertions in tests/rls/inbox-dna-isolation.sql complete --
-- whether they passed, failed, or the client connection itself never
-- succeeded. Deleting the two organizations cascades to business_dna (which
-- itself cascades to business_dna_services), inbox_mailboxes, and
-- inbox_threads (which itself cascades to inbox_messages), so verifying the
-- two organizations are gone is sufficient to verify the whole fixture set
-- is gone.

delete from organizations
where id in (
  '51111111-0000-4000-8000-000000000000',
  '52222222-0000-4000-8000-000000000000'
);
delete from users
where id in (
  'e0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  'e0000000-0000-4000-8000-000000000001',
  'f0000000-0000-4000-8000-000000000002'
);

do $$
declare remaining int;
begin
  select count(*) into remaining
  from organizations
  where id in (
    '51111111-0000-4000-8000-000000000000',
    '52222222-0000-4000-8000-000000000000'
  );
  if remaining <> 0 then
    raise exception 'INBOX-DNA CLEANUP FAIL: % organization fixture row(s) remain', remaining;
  end if;

  select count(*) into remaining
  from users
  where id in (
    'e0000000-0000-4000-8000-000000000001',
    'f0000000-0000-4000-8000-000000000002'
  );
  if remaining <> 0 then
    raise exception 'INBOX-DNA CLEANUP FAIL: % user fixture row(s) remain', remaining;
  end if;

  select count(*) into remaining
  from business_dna
  where organization_id in (
    '51111111-0000-4000-8000-000000000000',
    '52222222-0000-4000-8000-000000000000'
  );
  if remaining <> 0 then
    raise exception 'INBOX-DNA CLEANUP FAIL: % business_dna fixture row(s) remain (cascade did not run)', remaining;
  end if;

  select count(*) into remaining
  from inbox_threads
  where organization_id in (
    '51111111-0000-4000-8000-000000000000',
    '52222222-0000-4000-8000-000000000000'
  );
  if remaining <> 0 then
    raise exception 'INBOX-DNA CLEANUP FAIL: % inbox_threads fixture row(s) remain (cascade did not run)', remaining;
  end if;

  select count(*) into remaining
  from business_dna_services
  where organization_id in (
    '51111111-0000-4000-8000-000000000000',
    '52222222-0000-4000-8000-000000000000'
  );
  if remaining <> 0 then
    raise exception 'INBOX-DNA CLEANUP FAIL: % business_dna_services fixture row(s) remain (cascade did not run)', remaining;
  end if;
end $$;
