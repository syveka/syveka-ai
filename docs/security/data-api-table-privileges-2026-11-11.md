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
   `users_self_update` policy checks only `id = auth.uid()`.
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

**Also removed by this change.** Before it, `anon` and `authenticated` hold `TRUNCATE` on every
table except `business_dna` and `business_dna_services`, and `TRUNCATE` ignores RLS. PostgREST
has no truncate operation, so this is not reachable through the Data API, but it is a real grant
on any other path that reaches the database as those roles.

**Independent reproduction** (separate context, own scripts, two `supabase/postgres:17.6.1.167`
databases, migrations applied by `prisma migrate deploy` as `postgres`, PostgREST's request
settings simulated):

- **Main:** the email update returns `UPDATE 1`. After B's sign-up, B is OWNER of A's
  organization.
- **This change:** the update is refused, and A keeps their row and membership.
- **Also checked:**
  - `notifications` is still readable;
  - the invariants pass;
  - re-applying the migration is a no-op;
  - the section 5 rollback reopens the path and makes the invariants fail.
- **As `anon` on main:** reads and writes are blocked by RLS.
- **Not tested:** real PostgREST, Auth or Realtime over HTTP.

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

-- D2 default privileges that apply to new objects in public (schema '(all)' = every schema)
select r.rolname owner, coalesce(n.nspname, '(all)') schema, d.defaclobjtype, a.privilege_type,
       coalesce(g.rolname, 'PUBLIC') grantee
from pg_default_acl d join pg_roles r on r.oid = d.defaclrole
left join pg_namespace n on n.oid = d.defaclnamespace
cross join lateral aclexplode(d.defaclacl) a left join pg_roles g on g.oid = a.grantee
where (d.defaclnamespace = 0 or n.nspname = 'public')
  and coalesce(g.rolname, 'PUBLIC') in ('anon', 'authenticated', 'PUBLIC')
order by 1, 2, 3, 5, 4;

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
select count(*) as mismatched_profile_emails,
       count(*) filter (where not exists (select 1 from auth.users x where lower(x.email) = lower(u.email)))
         as pointing_at_unregistered_address
from public.users u join auth.users a on a.id = u.id
where lower(u.email) <> lower(a.email);

-- D7 which migrations this database has (decides the restore drill's commit; see section 5)
select migration_name, finished_at is not null as finished
from public._prisma_migrations order by migration_name desc limit 3;
```

**Expected results and what they mean:**

| Query | Expected before #443                                                                                                                                         | Expected after #443                                                                         | If different                                                                                                                                                                                            |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1    | Rows for nearly every table, `anon` and `authenticated` with `DELETE,INSERT,…,SELECT,…,UPDATE` (platform defaults); none on `_prisma_migrations`             | Exactly one row: `notifications`, `authenticated`, `SELECT`                                 | **Before:** `UPDATE` for `authenticated` on `users` = the takeover is **open** on that database. No such row = not open there (say so in the PR). **After:** any other row fails the release invariants |
| D2    | `postgres` / `public` rows granting `anon` and `authenticated` on `r` (tables), `S` (sequences), `f` (functions); `supabase_admin` rows too                  | No `postgres` rows of type `r` or `S`. `f` rows and `supabase_admin` rows remain (expected) | A `postgres` `r`/`S` row after #443 fails the invariants                                                                                                                                                |
| D3    | No rows                                                                                                                                                      | No rows                                                                                     | Any row is a separate P0 (a table with no RLS, served by the Data API); stop and report                                                                                                                 |
| D4    | `custom_access_token_hook` executable by `anon`/`authenticated`; `handle_new_user` shows `definer = true` (a trigger function: not callable through the API) | The hook no longer executable by either                                                     | Any other `definer = true` function executable by `anon`/`authenticated` needs review                                                                                                                   |
| D5    | Lists the tables Realtime publishes; `notifications` may or may not be there                                                                                 | Unchanged                                                                                   | Information only: live notifications don't work today either way (the `org_id` claim is missing)                                                                                                        |
| D6    | `0`, `0`                                                                                                                                                     | Unchanged by #443 (it doesn't touch data)                                                   | A non-zero `pointing_at_unregistered_address` is the attack's set-up state: **don't let that address sign up** until it is reviewed. A non-zero first count alone may be an old copy                    |
| D7    | The newest applied names                                                                                                                                     | Includes `20261111000000_…` once released                                                   | See section 5 (drill)                                                                                                                                                                                   |

- **Also check:** Authentication → Hooks → "Customize Access Token (JWT) Claims" is **off**.

### Can the staging database be used for internal testing before #443 is applied there?

**No, unless D1 on staging shows no `UPDATE` for `authenticated` on `users`.** Staging's anon key
ships in its browser bundle, so any account that can sign in there can use the path in section 1.
The fastest safe route is to release #443 with the first staging release (section 5): the release
applies it and its invariants prove it before anyone tests. Until then, test only with throwaway
accounts and synthetic data, and treat anything on staging as readable and alterable by any other
tester.

## 4. Owner authorization needed

`npm run migrations:check` pins the migration list in `scripts/check-migration-history.mjs`,
which is protected configuration. CI on this PR fails at that check until this one line is added
after `"20261014000000_secure_prisma_migrations_table",` in `expectedOrder`:

```js
  "20261111000000_revoke_data_api_table_privileges",
```

No published migration is edited, and the legacy schema contract has no ACLs, so nothing else
needs regenerating.

**Verified:** a copy of the script with exactly this line added, run in this branch's tree,
prints `Migration history is ordered and 8 published checksums match.` and exits 0; without the
line it fails with `Migration order mismatch`. No checksum entry is needed: only eight migrations
from before the staging-release branch are pinned.

## 5. Deployment and rollback

- **Order:** merge, then the next staging release applies it (`prisma migrate deploy`), then the
  release invariants verify it. Confirm a recent backup or PITR first (staging release checklist).
- **The restore drill and this migration.** The drill restores a read-only dump of
  **production** into a disposable project. Its scripts (`scripts/recovery-drill/s6-*.sh`,
  `s7-*.sh`, `rehearsal/rehearse.sh`) require that exactly
  `20261014000000_secure_prisma_migrations_table` is pending, comparing the restored history with
  the migrations of the commit the scripts run from. So:
  - **Merging and releasing #443 to staging doesn't block the drill and isn't blocked by it.**
    Staging and the drill project are separate databases.
  - **Until production has #443,** run the drill from a commit before #443's merge (for example
    `aaf36c47`; rows 1–9 of the merge order change nothing under `prisma/` or the drill scripts).
    From a later commit, `s6` stops, safely and before writing, with "pending migrations … are not
    exactly …".
  - **Once production has #443,** update `EXPECT_PENDING` in the three scripts before the next drill.
  - D7 on production says which case applies. A restore never touches production; the only
    production access is the owner's read-only dump.
- **Production.** `deploy.yml` applies migrations separately and needs its own authorization.
  Apply #443 to production after it has passed on staging and after one drill, so backups are proven
  before production's grants change.
- **Locking:** catalog-only changes with brief locks; no table rewrite.
- **Browser effect:** none expected. The only browser path is the Realtime subscription on
  `notifications`, which keeps `SELECT`. Today it receives nothing anyway, because
  `notifications_select` needs the `org_id` claim.
- **After staging:** D1 shows only `authenticated SELECT` on `notifications`. A sign-in, a chat and
  a booking work as before.
- **Rollback:** a new forward migration that restores the D1 and D2 snapshots, with the Data API
  checks removed from `tests/staging/release-invariants.sql` in the same change (otherwise every
  later release fails at them). This reopens the issue, so do it only to unblock something
  specific. The blunt version:

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO anon, authenticated;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO anon, authenticated;
REVOKE ALL ON TABLE public._prisma_migrations FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO anon, authenticated;
```

## 6. Not covered here

- **Function defaults.** `postgres`'s and `supabase_admin`'s default privileges still give `anon`
  and `authenticated` `EXECUTE` on future functions in `public`. Today the only SECURITY DEFINER
  function there is the trigger function `handle_new_user()`, which can't be called directly.
  - **Rule for future migrations:** a new SECURITY DEFINER function must `REVOKE EXECUTE … FROM
PUBLIC, anon, authenticated`.
  - Revoking the function defaults here could break RLS helper functions added later, so it isn't
    done.
- **`supabase_admin`'s table defaults.** They still grant both roles everything on tables
  `supabase_admin` creates in `public`. The application never creates tables as that role, and the
  release invariants fail on any such grant whoever made it.

- **Redesigning the access token hook:** use a custom `org_role` claim, keep `role`, and add a
  SELECT grant and policy for `supabase_auth_admin`. Needed before any browser path to tenant
  tables is added.
- **Removing the trust in `public.users.email`:** compare with `auth.users.email` in the
  invitation and notification paths. With the grants gone, only the server can write that column,
  so this is now defense in depth.
- **`storage_avatar_write`:** lets any signed-in user upload to the public `avatars` bucket.
