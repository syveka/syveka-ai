-- Removes exactly the fixtures tests/rls/creator-studio-fixtures.sql
-- creates, then verifies they are actually gone -- fails loudly (raises an
-- exception) rather than merely reporting that its DELETE statements
-- executed without error. Run by the administrative connection, via the
-- harness's exit trap, after tests/rls/creator-studio-isolation.sql
-- completes -- whether it passed, failed, or the client connection itself
-- never succeeded.

delete from creator_posts
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from creator_templates
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from creator_generations
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from creator_campaigns
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from creator_profiles
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from organization_members
where organization_id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from organizations
where id in (
  '71111111-0000-4000-8000-000000000000',
  '72222222-0000-4000-8000-000000000000'
);
delete from users
where id in (
  '71000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002'
);
delete from auth.users
where id in (
  '71000000-0000-4000-8000-000000000001',
  '72000000-0000-4000-8000-000000000002'
);

do $$
declare remaining int;
begin
  select count(*) into remaining
  from organizations
  where id in (
    '71111111-0000-4000-8000-000000000000',
    '72222222-0000-4000-8000-000000000000'
  );
  if remaining <> 0 then
    raise exception 'CS CLEANUP FAIL: % organization fixture row(s) remain', remaining;
  end if;

  select count(*) into remaining
  from users
  where id in (
    '71000000-0000-4000-8000-000000000001',
    '72000000-0000-4000-8000-000000000002'
  );
  if remaining <> 0 then
    raise exception 'CS CLEANUP FAIL: % user fixture row(s) remain', remaining;
  end if;

  -- Every Creator Studio table cascades from organizations (ON DELETE
  -- CASCADE), so the delete above already removed them; this proves the
  -- cascade actually held rather than merely assuming it. creator_templates'
  -- global row (organization_id null) is deliberately excluded -- it was
  -- never scoped to either fixture org and cascade never applies to it.
  select
    (select count(*) from creator_profiles where organization_id in ('71111111-0000-4000-8000-000000000000', '72222222-0000-4000-8000-000000000000'))
    + (select count(*) from creator_campaigns where organization_id in ('71111111-0000-4000-8000-000000000000', '72222222-0000-4000-8000-000000000000'))
    + (select count(*) from creator_generations where organization_id in ('71111111-0000-4000-8000-000000000000', '72222222-0000-4000-8000-000000000000'))
    + (select count(*) from creator_templates where organization_id in ('71111111-0000-4000-8000-000000000000', '72222222-0000-4000-8000-000000000000'))
    + (select count(*) from creator_posts where organization_id in ('71111111-0000-4000-8000-000000000000', '72222222-0000-4000-8000-000000000000'))
  into remaining;
  if remaining <> 0 then
    raise exception 'CS CLEANUP FAIL: % Creator Studio fixture row(s) remain across creator_profiles/creator_campaigns/creator_generations/creator_templates/creator_posts', remaining;
  end if;
end $$;

-- The global template fixture is not organization-scoped and does not
-- cascade from either fixture org; remove it explicitly by its own fixture id.
delete from creator_templates where id = 'd4000000-0000-4000-8000-000000000000';
do $$
declare remaining int;
begin
  select count(*) into remaining from creator_templates where id = 'd4000000-0000-4000-8000-000000000000';
  if remaining <> 0 then
    raise exception 'CS CLEANUP FAIL: global creator_templates fixture row remains';
  end if;
end $$;
