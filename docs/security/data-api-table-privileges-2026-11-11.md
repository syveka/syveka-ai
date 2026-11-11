# Data API table privileges (2026-11-11)

**Summary.** The application never uses Supabase's Data API (PostgREST) for tables. Hosted
Supabase still grants `anon` and `authenticated` every privilege on each table the `postgres` role
creates in `public`. Because of that, a signed-in user holding the public anon key can write to
their own `public.users` row directly, `email` included.

The application trusts that column. A new sign-up whose email matches a `public.users` row
inherits that row and all its memberships (`handle_new_user`, migration `20260902000000`).
Migration `20261111000000_revoke_data_api_table_privileges` removes the grants. It needs one line
of owner-authorized change before CI can pass (section 4).

## 1. What a user can do today

This works with no other precondition, assuming the platform's default grants are live (check D1
below).

1. User A calls `PATCH /rest/v1/users?id=eq.<A>` with `{"email": "b@example.com"}`. The
   `users_update` policy checks only `id = auth.uid()`.
2. Later, B signs up with `b@example.com`. `handle_new_user()` finds A's row by email and moves it
   to B's new id. Every foreign key cascades, so B is now a member, possibly OWNER, of A's
   organizations. A's own account has no profile left.
3. Separately, A can make "already a member" and owner-notification lookups resolve to the wrong
   person, or block B's invitation by occupying B's address.

The other policy gaps on record need the `org_id` claim from the custom access token hook, which
is not registered:

- writes by any member with no role check;
- organization-wide reads of conversations, invitation tokens, webhook secrets and API key
  hashes.

**Do not register the hook as written.** It overwrites the JWT `role` claim, which PostgREST and
Realtime use to choose the database role. It would also switch those gaps on.

No cross-tenant path was found. Every policy predicate is `organization_id = auth_org_id()` or
`user_id/id = auth.uid()`.

## 2. The change

| File                                                                              | Change                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prisma/migrations/20261111000000_revoke_data_api_table_privileges/migration.sql` | Revokes from `anon` and `authenticated` every table and sequence privilege in `public`, and the migration role's defaults for new tables. Re-grants `SELECT` on `notifications` to `authenticated` (Realtime; rows still filtered by `notifications_select`). Revokes `EXECUTE` on `custom_access_token_hook` from everyone but `supabase_auth_admin` |
| `tests/staging/release-invariants.sql`                                            | Requires the migration. Fails the release if `anon` or `authenticated` holds any `public` table or sequence privilege other than `authenticated SELECT notifications`, or if the migration role's defaults grant them any                                                                                                                             |
| `tests/migrations/supabase-compatibility.sql`                                     | CI's empty database now starts with the hosted DML defaults, so CI tests the migration history against the grants that are live, not a narrower set                                                                                                                                                                                                   |

**Not affected:**

- Prisma: connects as the table owner.
- `service_role`: storage calls and the `gdpr-erasure` function.
- The `storage` and `auth` schemas.
- `handle_new_user`: SECURITY DEFINER.
- RLS policies: they stay in place as defense in depth.

## 3. Read-only diagnostics (run on staging first, then production)

Supabase → Project → SQL Editor. Save each output: it is also the rollback reference.

```sql
-- D1 table and sequence privileges of the Data API roles
select c.relname, c.relkind, coalesce(g.rolname, 'PUBLIC') grantee, gr.rolname grantor,
       string_agg(a.privilege_type, ',' order by a.privilege_type) privileges
from pg_class c join pg_namespace n on n.oid = c.relnamespace
cross join lateral aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
left join pg_roles g on g.oid = a.grantee join pg_roles gr on gr.oid = a.grantor
where n.nspname = 'public' and c.relkind in ('r','p','v','m','f','S')
  and (a.grantee = 0 or g.rolname in ('anon', 'authenticated'))
group by 1, 2, 3, 4 order by 1, 3;

-- D2 default privileges that apply to new objects in public
select r.rolname owner, d.defaclobjtype, a.privilege_type, coalesce(g.rolname, 'PUBLIC') grantee
from pg_default_acl d join pg_roles r on r.oid = d.defaclrole
left join pg_namespace n on n.oid = d.defaclnamespace
cross join lateral aclexplode(d.defaclacl) a left join pg_roles g on g.oid = a.grantee
where n.nspname = 'public' and coalesce(g.rolname, 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC')
order by 1, 2, 4, 3;

-- D3 tables without RLS (expected: none)
select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity;

-- D4 functions in public: definer, and who may execute them
select p.oid::regprocedure fn, p.prosecdef definer,
       has_function_privilege('anon', p.oid, 'EXECUTE') anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') auth_exec
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' order by 2 desc, 1;

-- D5 Realtime publication
select * from pg_publication_tables where pubname = 'supabase_realtime';

-- D6 has anyone already changed their profile email away from their sign-in email?
select count(*) as mismatched_profile_emails
from public.users u join auth.users a on a.id = u.id
where lower(u.email) <> lower(a.email);
```

**Reading the results:**

- **D1:** `INSERT`/`UPDATE`/`DELETE` for `authenticated` on `users` means the path in section 1
  is open.
- **D6:** expected `0`. Anything else needs a look before the migration: no row values are
  printed, but each mismatch is either a stale copy or a deliberate change.
- Also check: Authentication → Hooks → "Customize Access Token (JWT) Claims" should be **off**.

## 4. Owner authorization needed

`npm run migrations:check` pins the migration list in `scripts/check-migration-history.mjs`,
which is protected configuration. CI on this PR fails at that check until this one line is added
after `"20261014000000_secure_prisma_migrations_table",` in `expectedOrder`:

```js
  "20261111000000_revoke_data_api_table_privileges",
```

No published migration is edited, and the legacy schema contract has no ACLs, so nothing else
needs regenerating.

## 5. Deployment and rollback

- **Order:** merge, then the next staging release applies it (`prisma migrate deploy`), then the
  release invariants verify it. Confirm a recent backup or PITR first (staging release checklist).
- **Restore drill first.** The drill scripts (`scripts/recovery-drill/s6-*.sh`, `s7-*.sh`,
  `rehearsal/rehearse.sh`) expect exactly `20261014000000_secure_prisma_migrations_table` to be
  pending on a restored production copy. With this migration in the tree they stop with "pending
  migrations … are not exactly …". Either run the drill from a commit before this merge (it is
  needed before the pilot anyway, and proves backups before a migration ships), or update
  `EXPECT_PENDING` there to the list actually pending at that time.
- **Locking:** catalog-only changes with brief locks; no table rewrite.
- **Browser effect:** none expected. The only browser path is the Realtime subscription on
  `notifications`, which keeps `SELECT`. Today it receives nothing anyway, because
  `notifications_select` needs the `org_id` claim.
- **After staging:** D1 shows only `authenticated SELECT` on `notifications`. A sign-in, a chat and
  a booking work as before.
- **Rollback:** a new forward migration that restores the D1 and D2 snapshots. This reopens the
  issue, so do it only to unblock something specific. The blunt version:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
REVOKE ALL ON TABLE public._prisma_migrations FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
```

## 6. Not covered here

- **Redesigning the access token hook:** use a custom `org_role` claim, keep `role`, and add a
  SELECT grant and policy for `supabase_auth_admin`. Needed before any browser path to tenant
  tables is added.
- **Removing the trust in `public.users.email`:** compare with `auth.users.email` in the
  invitation and notification paths. With the grants gone, only the server can write that column,
  so this is now defense in depth.
- **`storage_avatar_write`:** lets any signed-in user upload to the public `avatars` bucket.
