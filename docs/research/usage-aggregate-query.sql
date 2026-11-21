-- Aggregate AI usage for the economics decision. Read-only, and returns no identifiers.
--
-- Where and how to run it: Supabase dashboard > SQL Editor, against production. Paste the whole
-- script with nothing selected, and run it once, as in docs/release-runbook.md's read-only
-- preflight. It then runs as one transaction, so the read-only setting and timeouts apply to
-- every statement. Don't run it statement by statement.
--
-- Trust the output only if the first rows show transaction_read_only = on, statement_timeout = 15s
-- and lock_timeout = 2s. If it times out, change '30 days' in both places to '7 days'.
--
-- It selects no conversation text, names, emails, phone numbers, or organization, user or customer
-- ids. Results contain only plan, billing class, organization type, model and feature labels,
-- with counts and sums. Labels that come from JSON pass an allowlist pattern, so anything else
-- shows as "other". Very small groups could still hint at a specific customer, so treat the
-- output as internal.

set transaction read only;
set local statement_timeout = '15s';
set local lock_timeout = '2s';
set local idle_in_transaction_session_timeout = '30s';

with
window_start as (
  select now() - interval '30 days' as t
),
org_class as (
  select
    o.id,
    o.type::text as org_type,
    coalesce(s.plan::text, 'NONE') as plan,
    -- Billing state only. This says nothing about revenue actually collected.
    case
      when s.id is null then 'no_subscription'
      when s.status = 'TRIALING' then 'trialing'
      when s.status = 'ACTIVE' and s.stripe_subscription_id is not null then 'active_stripe'
      when s.status = 'ACTIVE' then 'active_no_stripe'
      else lower(s.status::text)
    end as billing_class
  from organizations o
  left join subscriptions s on s.organization_id = o.id
),
usage_rows as (
  select
    u.organization_id,
    u.metric::text as metric,
    u.quantity,
    u.metadata,
    u.created_at,
    case when u.metadata->>'model' ~ '^[A-Za-z0-9._-]{1,64}$' then u.metadata->>'model'
         when u.metadata ? 'model' then 'other' else 'not_recorded' end as model,
    case when coalesce(u.metadata->>'feature', u.metadata->>'task') ~ '^[A-Za-z0-9._:-]{1,40}$'
           then coalesce(u.metadata->>'feature', u.metadata->>'task')
         when u.metadata ? 'feature' or u.metadata ? 'task' then 'other'
         else 'no_feature_label' end as feature
  from usage_records u, window_start w
  where u.created_at >= w.t
),
replies as (
  select
    c.organization_id,
    case when m.model ~ '^[A-Za-z0-9._-]{1,64}$' then m.model
         when m.model is null then 'not_recorded' else 'other' end as model,
    m.tokens_in,
    m.tokens_out,
    m.estimated_cost_usd,
    m.tool_calls
  from messages m
  join conversations c on c.id = m.conversation_id
  cross join window_start w
  where m.created_at >= w.t and m.role = 'ASSISTANT'
),
grid as (
  select 0 as ord, 'settings' as section, 'transaction_read_only' as grp,
         current_setting('transaction_read_only') as result
  union all
  select 0, 'settings', 'statement_timeout', current_setting('statement_timeout')
  union all
  select 0, 'settings', 'lock_timeout', current_setting('lock_timeout')
  union all
  select 1, 'coverage', 'window',
    jsonb_build_object(
      'window_start', (select t from window_start),
      'earliest_usage_row_ever', (select min(created_at) from usage_records),
      'first_row_in_window', (select min(created_at) from usage_rows),
      'last_row_in_window', (select max(created_at) from usage_rows),
      'days_with_rows', (select count(distinct created_at::date) from usage_rows),
      'rows_in_window', (select count(*) from usage_rows),
      'orgs_with_usage', (select count(distinct organization_id) from usage_rows),
      'orgs_total', (select count(*) from organizations),
      'orgs_deleted', (select count(*) from organizations where deleted_at is not null)
    )::text
  union all
  -- How many organizations sit in each class, whether or not they used anything.
  select 2, 'orgs_by_class', oc.plan || '|' || oc.billing_class || '|' || oc.org_type,
    count(*)::text
  from org_class oc
  group by oc.plan, oc.billing_class, oc.org_type
  union all
  -- Every recorded metric, by class, model and feature. Metadata keys tell us what's missing.
  select 3, 'usage',
    oc.plan || '|' || oc.billing_class || '|' || u.metric || '|' || u.model || '|' || u.feature,
    jsonb_build_object(
      'orgs', count(distinct u.organization_id),
      'rows', count(*),
      'quantity', sum(u.quantity),
      'aborted', count(*) filter (where u.metadata->>'aborted' = 'true'),
      'moderated', count(*) filter (where u.metadata->>'blockedByModeration' = 'true'),
      'partial_voice_context', count(*) filter (where u.metadata->>'stoppedBy' = 'voice_context_too_large')
    )::text
  from usage_rows u
  join org_class oc on oc.id = u.organization_id
  group by oc.plan, oc.billing_class, u.metric, u.model, u.feature
  union all
  -- Saved chat replies: tool rounds are already summed into each reply's tokens.
  select 4, 'chat_replies', oc.plan || '|' || oc.billing_class || '|' || r.model,
    jsonb_build_object(
      'orgs', count(distinct r.organization_id),
      'replies', count(*),
      'missing_tokens', count(*) filter (where r.tokens_in is null or r.tokens_out is null),
      'with_tool_calls', count(*) filter (where r.tool_calls is not null and r.tool_calls <> '[]'::jsonb),
      'tokens_in', sum(r.tokens_in),
      'tokens_out', sum(r.tokens_out),
      'recorded_estimated_usd', sum(r.estimated_cost_usd),
      'in_p50', percentile_disc(0.5) within group (order by r.tokens_in),
      'in_p90', percentile_disc(0.9) within group (order by r.tokens_in),
      'in_max', max(r.tokens_in),
      'out_p50', percentile_disc(0.5) within group (order by r.tokens_out),
      'out_p90', percentile_disc(0.9) within group (order by r.tokens_out),
      'out_max', max(r.tokens_out)
    )::text
  from replies r
  join org_class oc on oc.id = r.organization_id
  group by oc.plan, oc.billing_class, r.model
)
select section, grp, result
from grid
order by ord, section, grp;
