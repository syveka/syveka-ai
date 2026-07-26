-- Removes exactly the fixtures tests/rls/isolation-fixtures.sql creates. Run
-- by the administrative connection, via scripts/ci/run-rls-check.sh's exit
-- trap, after the client-side assertions in tests/rls/isolation.sql complete
-- -- whether they passed, failed, or the client connection itself never
-- succeeded.

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
