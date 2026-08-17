-- 0030_report_compare.sql
--
-- Comparing one period against another one you choose.
--
-- ===========================================================================
-- THE ASK
--
--   "A period is 7 days for our sake. A period begins on Monday and ends on
--    Sunday evening. So in reporting this must be defined in the context tabs
--    and reflected in the period. Additionally I would like a compare feature
--    added to reporting. That way we can compare a previous period year over
--    year, or by week."
--
-- WHAT WAS ALREADY RIGHT, AND IS WORTH NOT BREAKING
--
-- report_series already buckets by ISO week, and Postgres's date_trunc('week')
-- starts on MONDAY. So weekly buckets were already Monday-to-Sunday. The part
-- that was wrong lives in the app: the window itself was "the last 28 days
-- counting back from today", which starts on whatever day of the week it
-- happens to be. Snapping the window to Monday is done there, in
-- report-metrics.ts, because that is where the period is chosen.
--
-- WHAT CHANGES HERE
--
-- The comparison window stops being implied and starts being an argument.
--
-- report_window computed its own comparison: the same number of days ending the
-- day before the period started. That is one of the three comparisons Alex
-- asked for and there is no way to ask it for either of the others. Year over
-- year in particular cannot be derived from a span -- it is a different window
-- entirely, and for a business that runs Monday to Sunday it is 364 days back,
-- not 365, because 364 is the one that lands on a Monday again.
--
-- Both functions keep their old behaviour when the comparison window is not
-- given, so every existing caller is unaffected.
--
-- WHY DROP AND CREATE RATHER THAN REPLACE
--
-- `create or replace function` matches on the argument list. Adding parameters
-- creates an OVERLOAD instead of replacing, and then a three-argument call is
-- ambiguous between the old function and the new one's defaults -- which fails
-- at runtime, on the reports screen, with an error nobody would connect to this
-- file. Dropping first is the only version of this that works.
--
-- WHY BOTH SIGNATURES ARE DROPPED
--
-- Setup re-runs every migration every time -- people re-run it when confused,
-- and it has to be safe to. On the second run 0019 and 0028 recreate the
-- three-argument function, so dropping only that one leaves the FIVE-argument
-- one from the first run still standing, and the create below fails with
-- "function already exists with same argument types". The whole setup then
-- stops at this file.
--
-- This project has now hit the re-run trap three times, in 0021, in 0024 and
-- here. The rule that would have prevented all three: a migration that changes
-- a function's signature must drop EVERY signature that function has ever had,
-- not merely the one it is replacing. setup/run.test.ts runs the whole set
-- twice for exactly this reason and is the only thing that catches it.
-- ===========================================================================

drop function if exists report_window(date, date, text);
drop function if exists report_window(date, date, text, date, date);

create function report_window(
  p_from date,
  p_to date,
  p_scope text default 'team',
  /* Null means "the period immediately before this one, same length" -- the
     behaviour every caller had before this file existed. */
  p_prev_from date default null,
  p_prev_to date default null
) returns table (
  metric text,
  value numeric,
  previous numeric
) as $$
declare
  span int := greatest(1, (p_to - p_from) + 1);
  prev_from date := coalesce(p_prev_from, p_from - span);
  prev_to date := coalesce(p_prev_to, p_from - 1);
begin
  return query
  with bounds as (
    select p_from::timestamptz as cur_from,
           (p_to + 1)::timestamptz as cur_to,
           prev_from::timestamptz as pre_from,
           (prev_to + 1)::timestamptz as pre_to
  ),
  act as (
    select a.occurred_at, a.type, a.qualifies
      from activities a
      join accounts ac on ac.id = a.account_id
     where (case p_scope when 'mine' then ac.owner_id = (select current_user_id()) else ac.owner_id in (select visible_user_ids()) end)
  ),
  clm as (
    select c.claimed_at, c.released_at, c.release_reason
      from account_claims c
      join accounts ac on ac.id = c.account_id
     where (case p_scope when 'mine' then c.user_id = (select current_user_id()) else c.user_id in (select visible_user_ids()) end)
  ),
  con as (
    select c.created_at
      from contacts c
      join accounts ac on ac.id = c.account_id
     where (case p_scope when 'mine' then ac.owner_id = (select current_user_id()) else ac.owner_id in (select visible_user_ids()) end)
  ),
  held as (
    select count(*) as n
      from accounts ac
     where ac.owner_id is not null
       and (case p_scope when 'mine' then ac.owner_id = (select current_user_id()) else ac.owner_id in (select visible_user_ids()) end)
  )
  select * from (
    select 'calls'::text,
           (select count(*) from act, bounds
             where type = 'call' and occurred_at >= cur_from and occurred_at < cur_to)::numeric,
           (select count(*) from act, bounds
             where type = 'call' and occurred_at >= pre_from and occurred_at < pre_to)::numeric
    union all
    select 'approved',
           (select count(*) from act, bounds
             where report_is_counted(qualifies) and occurred_at >= cur_from and occurred_at < cur_to)::numeric,
           (select count(*) from act, bounds
             where report_is_counted(qualifies) and occurred_at >= pre_from and occurred_at < pre_to)::numeric
    union all
    select 'emails',
           (select count(*) from act, bounds
             where type = 'email' and occurred_at >= cur_from and occurred_at < cur_to)::numeric,
           (select count(*) from act, bounds
             where type = 'email' and occurred_at >= pre_from and occurred_at < pre_to)::numeric
    union all
    select 'claimed',
           (select count(*) from clm, bounds
             where claimed_at >= cur_from and claimed_at < cur_to)::numeric,
           (select count(*) from clm, bounds
             where claimed_at >= pre_from and claimed_at < pre_to)::numeric
    union all
    select 'released',
           (select count(*) from clm, bounds
             where released_at >= cur_from and released_at < cur_to)::numeric,
           (select count(*) from clm, bounds
             where released_at >= pre_from and released_at < pre_to)::numeric
    union all
    -- Lost to the clock, as distinct from handed back. The difference between
    -- these two is the difference between a process problem and a choice.
    select 'lost',
           (select count(*) from clm, bounds
             where released_at >= cur_from and released_at < cur_to and release_reason = 'expired')::numeric,
           (select count(*) from clm, bounds
             where released_at >= pre_from and released_at < pre_to and release_reason = 'expired')::numeric
    union all
    select 'contacts_added',
           (select count(*) from con, bounds
             where created_at >= cur_from and created_at < cur_to)::numeric,
           (select count(*) from con, bounds
             where created_at >= pre_from and created_at < pre_to)::numeric
    union all
    -- A snapshot, not a window figure. Shown without a delta on the screen for
    -- exactly that reason: "accounts held last week" is not a thing this can
    -- know without a history table, and inventing it would be worse than
    -- leaving the comparison off.
    select 'accounts_held', (select n from held)::numeric, null::numeric
  ) as t(metric, value, previous);
end $$ language plpgsql stable;

comment on function report_window(date, date, text, date, date) is
  'Totals for a window, each against a comparison window. Omit the last two '
  'arguments for the period immediately before, same length.';

-- ---------------------------------------------------------------------------
-- The breakdown gets the comparison too.
--
-- This is the half of "compare" a manager actually acts on. A scorecard saying
-- the team is down 12% tells you to go looking; a table saying WHICH broker is
-- down 12% tells you who to talk to. Without it the compare feature answers the
-- question and then refuses to say who it is about.
--
-- Body copied from 0028 rather than retyped. Only the two prev_ aggregates and
-- the columns carrying them are new -- everything else, including the nine
-- scope predicates 0028 fixed, is character for character the same, so the two
-- cannot drift apart.
-- ---------------------------------------------------------------------------
-- Both signatures, for the reason in the header.
drop function if exists report_breakdown(date, date, text, text, text, int, int);
drop function if exists report_breakdown(date, date, text, text, text, int, int, date, date);

create function report_breakdown(
  p_from date,
  p_to date,
  p_scope text default 'team',
  p_dimension text default 'broker',
  p_search text default '',
  p_limit int default 25,
  p_offset int default 0,
  p_prev_from date default null,
  p_prev_to date default null
) returns table (
  key text,
  label text,
  calls bigint,
  approved bigint,
  hit_rate numeric,
  accounts bigint,
  claimed bigint,
  lost bigint,
  prev_calls bigint,
  prev_approved bigint,
  total_rows bigint
) as $$
  with span as (
    select coalesce(p_prev_from, p_from - greatest(1, (p_to - p_from) + 1)) as pf,
           coalesce(p_prev_to, p_from - 1) as pt
  ),
  act as (
    select
      case p_dimension
        when 'broker'   then coalesce(au.full_name, 'Unattributed')
        when 'branch'   then coalesce(au.location, 'No branch set')
        when 'industry' then coalesce(ac.industry, 'Not set')
        when 'state'    then coalesce(upper(ac.billing_state), 'Not set')
        when 'status'   then coalesce(ac.status, 'Not set')
        when 'stage'    then coalesce(ac.stage, 'Not set')
        when 'type'     then coalesce(a.type, 'Not set')
        when 'direction' then coalesce(a.direction, 'Not set')
        else 'All'
      end as k,
      a.type, a.qualifies, a.occurred_at,
      -- Carried as plain columns rather than looked up inside the aggregate
      -- filters below. A scalar subquery in a FILTER clause is legal but
      -- re-planned per aggregate; this is one join and reads as arithmetic.
      s.pf, s.pt
    from activities a
    join accounts ac on ac.id = a.account_id
    left join users au on au.id = a.user_id
    cross join span s
   where (case p_scope when 'mine' then ac.owner_id = (select current_user_id()) else ac.owner_id in (select visible_user_ids()) end)
  ),
  act_agg as (
    select k,
           count(*) filter (
             where type = 'call'
               and occurred_at >= p_from::timestamptz and occurred_at < (p_to + 1)::timestamptz
           ) as calls,
           count(*) filter (
             where report_is_counted(qualifies)
               and occurred_at >= p_from::timestamptz and occurred_at < (p_to + 1)::timestamptz
           ) as approved,
           count(*) filter (
             where type = 'call'
               and occurred_at >= pf::timestamptz and occurred_at < (pt + 1)::timestamptz
           ) as prev_calls,
           count(*) filter (
             where report_is_counted(qualifies)
               and occurred_at >= pf::timestamptz and occurred_at < (pt + 1)::timestamptz
           ) as prev_approved
      from act group by k
  ),
  acc as (
    select
      case p_dimension
        when 'broker'   then coalesce(ou.full_name, 'Unclaimed')
        when 'branch'   then coalesce(ou.location, 'No branch set')
        when 'industry' then coalesce(ac.industry, 'Not set')
        when 'state'    then coalesce(upper(ac.billing_state), 'Not set')
        when 'status'   then coalesce(ac.status, 'Not set')
        when 'stage'    then coalesce(ac.stage, 'Not set')
        when 'release_reason' then coalesce(ac.last_release_reason, 'Never released')
        else 'All'
      end as k,
      ac.id
    from accounts ac
    left join users ou on ou.id = ac.owner_id
   where (case p_scope when 'mine' then ac.owner_id = (select current_user_id()) else ac.owner_id in (select visible_user_ids()) end)
  ),
  acc_agg as (
    select k, count(*) as accounts from acc group by k
  ),
  clm as (
    select
      case p_dimension
        when 'broker'   then coalesce(cu.full_name, 'Unattributed')
        when 'branch'   then coalesce(cu.location, 'No branch set')
        when 'industry' then coalesce(ac.industry, 'Not set')
        when 'state'    then coalesce(upper(ac.billing_state), 'Not set')
        when 'status'   then coalesce(ac.status, 'Not set')
        when 'stage'    then coalesce(ac.stage, 'Not set')
        when 'release_reason' then coalesce(c.release_reason, 'Still held')
        else 'All'
      end as k,
      c.claimed_at, c.released_at, c.release_reason
    from account_claims c
    join accounts ac on ac.id = c.account_id
    left join users cu on cu.id = c.user_id
   where (case p_scope when 'mine' then c.user_id = (select current_user_id()) else c.user_id in (select visible_user_ids()) end)
  ),
  clm_agg as (
    select k,
           count(*) filter (
             where claimed_at >= p_from::timestamptz and claimed_at < (p_to + 1)::timestamptz
           ) as claimed,
           count(*) filter (
             where released_at >= p_from::timestamptz and released_at < (p_to + 1)::timestamptz
               and release_reason = 'expired'
           ) as lost
      from clm group by k
  ),
  merged as (
    select coalesce(a.k, b.k, c.k) as k,
           coalesce(a.calls, 0) as calls,
           coalesce(a.approved, 0) as approved,
           coalesce(a.prev_calls, 0) as prev_calls,
           coalesce(a.prev_approved, 0) as prev_approved,
           coalesce(b.accounts, 0) as accounts,
           coalesce(c.claimed, 0) as claimed,
           coalesce(c.lost, 0) as lost
      from act_agg a
      full join acc_agg b on b.k = a.k
      full join clm_agg c on c.k = coalesce(a.k, b.k)
  ),
  filtered as (
    select * from merged
     where coalesce(p_search, '') = '' or k ilike '%' || p_search || '%'
  ),
  counted as (
    select *, count(*) over () as total_rows from filtered
  )
  select k,
         k as label,
         calls,
         approved,
         case when calls = 0 then 0 else round(approved::numeric * 100 / calls, 1) end,
         accounts,
         claimed,
         lost,
         prev_calls,
         prev_approved,
         total_rows
    from counted
   -- Ordered by counted calls rather than raw volume. Volume rewards short
   -- calls; this rewards the ones that moved a clock. Accounts break the tie so
   -- a broker with no calls this period still appears in a sensible place.
   order by approved desc, calls desc, accounts desc, k
   limit greatest(1, least(p_limit, 200))
  offset greatest(0, p_offset)
$$ language sql stable;

comment on function report_breakdown(date, date, text, text, text, int, int, date, date) is
  'One row per value of a dimension, with the same two figures from a '
  'comparison window. Omit the last two arguments for the period immediately '
  'before, same length.';

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function report_window(date, date, text, date, date) to %I', r);
      execute format('grant execute on function report_breakdown(date, date, text, text, text, int, int, date, date) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
