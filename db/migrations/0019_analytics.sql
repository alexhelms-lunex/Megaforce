-- 0019_analytics.sql
--
-- The reporting engine.
--
-- ===========================================================================
-- WHY THIS IS THREE FUNCTIONS AND NOT TWELVE
--
-- The screens so far each had their own query: dashboard_leaderboard,
-- dashboard_by_branch, dashboard_state_mix, dashboard_industry_mix. Every new
-- question meant a new function, every function computed "counted calls"
-- slightly differently, and none of them could be filtered or compared against
-- a previous period.
--
-- Analytics tools do not work that way. They have a WINDOW, a set of METRICS,
-- and a set of DIMENSIONS, and every screen is a combination of the three. So:
--
--   report_window()    -- the totals for a period, and the same totals for the
--                         period before it, so every figure carries a delta
--   report_series()    -- those metrics over time, by day or by week
--   report_breakdown() -- those metrics split by any dimension
--
-- Adding "by release reason" is a new value in a CASE, not a new function. The
-- metrics are defined once, so the leaderboard and the trend line cannot
-- disagree about what a counted call is.
--
-- ---------------------------------------------------------------------------
-- SCOPE
--
-- Every function is SECURITY INVOKER, so row level security decides which
-- accounts and activities the caller can see before any of this runs. The
-- p_scope argument narrows further -- 'mine' for a broker's own book, 'team'
-- for everything visible. A broker passing 'team' sees their own book, because
-- that is all RLS gives them; the parameter cannot widen anything.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Shared building blocks
-- ---------------------------------------------------------------------------

/**
 * A metric's definition, in one place.
 *
 * "Counted" means qualifies = true. It is written here rather than in each
 * function so a change to the rule cannot land in the trend line and miss the
 * leaderboard -- the exact way two numbers on one screen come to disagree.
 */
create or replace function report_is_counted(p_qualifies boolean) returns boolean as $$
  select coalesce(p_qualifies, false)
$$ language sql immutable;

/**
 * The totals for a window, beside the same totals for the window before it.
 *
 * The previous period is the SAME LENGTH, immediately before. Comparing 7 days
 * against a calendar month makes every delta meaningless, and comparing against
 * "last month" makes a 28-day report incomparable with a 31-day one.
 */
create or replace function report_window(
  p_from date,
  p_to date,
  p_scope text default 'team'
) returns table (
  metric text,
  value numeric,
  previous numeric
) as $$
declare
  span int := greatest(1, (p_to - p_from) + 1);
  prev_from date := p_from - span;
  prev_to date := p_from - 1;
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
     where (p_scope <> 'mine' or ac.owner_id = (select current_user_id()))
  ),
  clm as (
    select c.claimed_at, c.released_at, c.release_reason
      from account_claims c
      join accounts ac on ac.id = c.account_id
     where (p_scope <> 'mine' or c.user_id = (select current_user_id()))
  ),
  con as (
    select c.created_at
      from contacts c
      join accounts ac on ac.id = c.account_id
     where (p_scope <> 'mine' or ac.owner_id = (select current_user_id()))
  ),
  held as (
    select count(*) as n
      from accounts ac
     where ac.owner_id is not null
       and (p_scope <> 'mine' or ac.owner_id = (select current_user_id()))
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

/**
 * The same metrics over time.
 *
 * Grain is 'day' or 'week'. A 90-day report drawn daily is 90 bars of noise;
 * drawn weekly it is a trend. The screen picks the grain from the span rather
 * than asking, because nobody has an opinion about it until the chart is
 * unreadable.
 *
 * Every bucket in the range is returned, including the empty ones. A chart that
 * silently omits days with no calls draws a flat line through a holiday and
 * makes a dead week look like a busy one.
 */
create or replace function report_series(
  p_from date,
  p_to date,
  p_scope text default 'team',
  p_grain text default 'day'
) returns table (
  bucket date,
  calls bigint,
  approved bigint,
  emails bigint,
  claimed bigint,
  lost bigint
) as $$
  with buckets as (
    select generate_series(
             date_trunc(case when p_grain = 'week' then 'week' else 'day' end, p_from::timestamptz),
             p_to::timestamptz,
             case when p_grain = 'week' then interval '1 week' else interval '1 day' end
           )::date as bucket
  ),
  act as (
    select date_trunc(case when p_grain = 'week' then 'week' else 'day' end, a.occurred_at)::date as bucket,
           a.type, a.qualifies
      from activities a
      join accounts ac on ac.id = a.account_id
     where a.occurred_at >= p_from::timestamptz
       and a.occurred_at < (p_to + 1)::timestamptz
       and (p_scope <> 'mine' or ac.owner_id = (select current_user_id()))
  ),
  clm as (
    select date_trunc(case when p_grain = 'week' then 'week' else 'day' end, c.claimed_at)::date as claim_bucket,
           date_trunc(case when p_grain = 'week' then 'week' else 'day' end, c.released_at)::date as release_bucket,
           c.release_reason
      from account_claims c
      join accounts ac on ac.id = c.account_id
     where (p_scope <> 'mine' or c.user_id = (select current_user_id()))
  )
  select b.bucket,
         coalesce((select count(*) from act where act.bucket = b.bucket and act.type = 'call'), 0),
         coalesce((select count(*) from act where act.bucket = b.bucket and report_is_counted(act.qualifies)), 0),
         coalesce((select count(*) from act where act.bucket = b.bucket and act.type = 'email'), 0),
         coalesce((select count(*) from clm where clm.claim_bucket = b.bucket), 0),
         coalesce((select count(*) from clm where clm.release_bucket = b.bucket and clm.release_reason = 'expired'), 0)
    from buckets b
   order by b.bucket
$$ language sql stable;

/**
 * The metrics split by any dimension.
 *
 * ---------------------------------------------------------------------------
 * ACTIVITY METRICS AND ACCOUNT METRICS ARE ATTRIBUTED DIFFERENTLY, ON PURPOSE.
 *
 * A call belongs to the person who MADE it. An account belongs to the person
 * who HOLDS it. Grouping both by "broker" and expecting one join to serve both
 * is how a leaderboard ends up crediting a manager's calls to whoever owns the
 * account they rang.
 *
 * So the two sides are aggregated separately and joined on the dimension key.
 * A full join, because a broker can have calls and no accounts (new starter) or
 * accounts and no calls -- and the second one is the row a manager is looking
 * for.
 * ---------------------------------------------------------------------------
 *
 * Dimensions: broker, branch, industry, state, status, stage, type, direction,
 * release_reason.
 */
create or replace function report_breakdown(
  p_from date,
  p_to date,
  p_scope text default 'team',
  p_dimension text default 'broker',
  p_search text default '',
  p_limit int default 25,
  p_offset int default 0
) returns table (
  key text,
  label text,
  calls bigint,
  approved bigint,
  hit_rate numeric,
  accounts bigint,
  claimed bigint,
  lost bigint,
  total_rows bigint
) as $$
  with act as (
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
      a.type, a.qualifies
    from activities a
    join accounts ac on ac.id = a.account_id
    left join users au on au.id = a.user_id
   where a.occurred_at >= p_from::timestamptz
     and a.occurred_at < (p_to + 1)::timestamptz
     and (p_scope <> 'mine' or ac.owner_id = (select current_user_id()))
  ),
  act_agg as (
    select k,
           count(*) filter (where type = 'call') as calls,
           count(*) filter (where report_is_counted(qualifies)) as approved
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
   where (p_scope <> 'mine' or ac.owner_id = (select current_user_id()))
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
   where (p_scope <> 'mine' or c.user_id = (select current_user_id()))
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
         total_rows
    from counted
   -- Ordered by counted calls rather than raw volume. Volume rewards short
   -- calls; this rewards the ones that moved a clock. Accounts break the tie so
   -- a broker with no calls this period still appears in a sensible place.
   order by approved desc, calls desc, accounts desc, k
   limit greatest(1, least(p_limit, 200))
  offset greatest(0, p_offset)
$$ language sql stable;

/** The dimensions the reports screen offers, so the menu cannot drift. */
create or replace function report_dimensions()
returns table (key text, label text, hint text) as $$
  select * from (values
    ('broker',   'Broker',        'Calls credited to whoever made them; accounts to whoever holds them.'),
    ('branch',   'Branch',        'Taken from each person''s location. People with no branch set group together.'),
    ('industry', 'Industry',      'The controlled Salesforce picklist, so there is no second spelling.'),
    ('state',    'State',         'From the billing address, upper-cased so NC and nc are one row.'),
    ('status',   'Status',        'Prospect, engaged or customer. The ratio is the useful reading.'),
    ('stage',    'Pipeline stage','Lead, Contact, Pitch, Quote, Closed — where the sale has got to.'),
    ('type',     'Activity type', 'Call, email, SMS, quote or note. Only some of these move a clock.'),
    ('direction','Direction',     'Inbound against outbound. A book that only answers is not hunting.'),
    ('release_reason','How it came free','Timed out, given up, reassigned or converted.')
  ) as v(key, label, hint)
$$ language sql immutable;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function report_is_counted(boolean) to %I', r);
      execute format('grant execute on function report_window(date, date, text) to %I', r);
      execute format('grant execute on function report_series(date, date, text, text) to %I', r);
      execute format(
        'grant execute on function report_breakdown(date, date, text, text, text, int, int) to %I', r);
      execute format('grant execute on function report_dimensions() to %I', r);
    end if;
  end loop;
end $$;
