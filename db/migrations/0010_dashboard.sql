-- 0010_dashboard.sql
--
-- The numbers behind the home screen.
--
-- These are functions rather than queries in the page for one reason that
-- matters at a thousand users: aggregation belongs next to the data. The
-- alternative -- select every account and every activity, then count them in
-- JavaScript -- moves tens of thousands of rows across the wire to produce
-- eight integers, and it gets slower every month the company grows.
--
-- Every function here is SECURITY INVOKER (the default). That is deliberate and
-- load-bearing: they read `accounts_with_state` and `activities`, both of which
-- carry row level security, so a broker's dashboard counts a broker's book and
-- a manager's counts their whole subtree, without a single line of scoping
-- logic in the application. A SECURITY DEFINER function here would hand every
-- rep the company's numbers.
--
-- p_scope selects between the caller's own book ('mine') and everything they
-- can see ('team'). It never widens beyond RLS -- 'team' still resolves through
-- visible_user_ids(), so it grants nothing a direct query would not.

-- ---------------------------------------------------------------------------
-- The scope predicate, written once.
--
-- Repeating this CASE in five functions is how one of them ends up subtly
-- different from the others and a manager's call count stops matching their
-- team list.
-- ---------------------------------------------------------------------------
create or replace function in_scope(p_owner uuid, p_scope text) returns boolean as $$
  select case
    when p_owner is null then false
    when p_scope = 'team' then p_owner in (select visible_user_ids())
    else p_owner = (select current_user_id())
  end
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- The KPI row.
-- ---------------------------------------------------------------------------
create or replace function dashboard_kpis(p_scope text default 'mine')
returns table (
  owned            bigint,
  prospects        bigint,
  customers        bigint,
  at_risk          bigint,
  expiring_soon    bigint,
  available_pool   bigint,
  calls_7d         bigint,
  qualifying_7d    bigint,
  calls_prev_7d    bigint,
  unlogged         bigint,
  contacts_owned   bigint,
  my_limit         int
) as $$
  with book as (
    select a.status, a.state
      from accounts_with_state a
     where in_scope(a.owner_id, p_scope)
  ),
  calls as (
    select x.occurred_at, x.qualifies, x.logged_at
      from activities x
     where x.type = 'call'
       and in_scope(x.user_id, p_scope)
  )
  select
    (select count(*) from book),
    (select count(*) from book where status = 'prospect'),
    (select count(*) from book where status = 'customer'),
    (select count(*) from book where state in ('warning','expiring','overdue')),
    (select count(*) from book where state in ('expiring','overdue')),
    -- The pool is everyone's, so it is never scoped. It is on the dashboard
    -- because "what can I claim right now" is the other half of the job.
    (select count(*) from accounts_with_state where owner_id is null),
    (select count(*) from calls where occurred_at >= now() - interval '7 days'),
    (select count(*) from calls where occurred_at >= now() - interval '7 days' and qualifies),
    -- The previous seven days, so the card can show a direction rather than a
    -- number with nothing to compare it to.
    (select count(*) from calls
      where occurred_at >= now() - interval '14 days'
        and occurred_at <  now() - interval '7 days'),
    (select count(*) from calls where logged_at is null),
    (select count(*) from contacts c
       join accounts a on a.id = c.account_id
      where in_scope(a.owner_id, p_scope)),
    (select prospect_limit from users where id = (select current_user_id()))
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- Calls per day, for the activity chart.
--
-- generate_series first, then a left join, so a day with no calls comes back as
-- a zero rather than as a missing bar. A chart that silently omits quiet days
-- makes a bad week look like a good one.
-- ---------------------------------------------------------------------------
create or replace function dashboard_calls_daily(
  p_days int default 14,
  p_scope text default 'mine'
)
returns table (day date, calls bigint, qualifying bigint) as $$
  select
    d::date,
    count(x.id),
    count(x.id) filter (where x.qualifies)
  from generate_series(
         current_date - (greatest(p_days, 1) - 1),
         current_date,
         interval '1 day'
       ) d
  left join activities x
    on x.type = 'call'
   and x.occurred_at >= d
   and x.occurred_at <  d + interval '1 day'
   and in_scope(x.user_id, p_scope)
  group by d
  order by d
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- Where the book sits in the pipeline.
--
-- Left-joined against the five stages so an empty stage still appears. A funnel
-- with a missing rung reads as a funnel with nothing stuck in it.
-- ---------------------------------------------------------------------------
create or replace function dashboard_stage_funnel(p_scope text default 'mine')
returns table (stage text, accounts bigint, rank int) as $$
  select s.stage, count(a.id), s.rank
    from (values ('Lead',0),('Contact',1),('Pitch',2),('Quote',3),('Closed',4)) as s(stage, rank)
    left join accounts a on a.stage = s.stage and in_scope(a.owner_id, p_scope)
   group by s.stage, s.rank
   order by s.rank
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- Industry mix.
--
-- Which verticals the book actually sits in, and how many of each have
-- converted. The conversion column is the useful one: it turns "we have a lot
-- of Produce accounts" into "we have a lot of Produce accounts and none of
-- them buy".
-- ---------------------------------------------------------------------------
create or replace function dashboard_industry_mix(
  p_scope text default 'mine',
  p_limit int default 8
)
returns table (industry text, accounts bigint, customers bigint, at_risk bigint) as $$
  select
    coalesce(a.industry, 'Unspecified'),
    count(*),
    count(*) filter (where a.status = 'customer'),
    count(*) filter (where a.state in ('warning','expiring','overdue'))
  from accounts_with_state a
  where in_scope(a.owner_id, p_scope)
  group by 1
  order by 2 desc, 1
  limit greatest(p_limit, 1)
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- The team table, for managers.
--
-- Driven by visible_user_ids(), so it shows exactly the people the caller is
-- responsible for -- their whole subtree, however deep -- and is empty for a
-- broker rather than needing to be hidden by the page.
-- ---------------------------------------------------------------------------
create or replace function dashboard_team(p_days int default 7)
returns table (
  user_id       uuid,
  full_name     text,
  role          text,
  location      text,
  prospect_limit int,
  owned         bigint,
  at_risk       bigint,
  customers     bigint,
  calls         bigint,
  qualifying    bigint,
  unlogged      bigint
) as $$
  -- CTEs joined once rather than six correlated subqueries per user. An admin's
  -- subtree is every rep in the company; the correlated shape would scan
  -- activities once per person and looks fine only on a demo dataset.
  with team as (
    select u.id, u.full_name, u.role, u.location, u.prospect_limit
      from users u
     where u.id in (select visible_user_ids())
       and u.id <> (select current_user_id())
  ),
  books as (
    select a.owner_id,
           count(*)                                                            as owned,
           count(*) filter (where a.state in ('warning','expiring','overdue'))  as at_risk,
           count(*) filter (where a.status = 'customer')                       as customers
      from accounts_with_state a
     where a.owner_id in (select id from team)
     group by a.owner_id
  ),
  made as (
    select x.user_id,
           count(*) filter (
             where x.occurred_at >= now() - make_interval(days => greatest(p_days, 1))
           ) as calls,
           count(*) filter (
             where x.qualifies
               and x.occurred_at >= now() - make_interval(days => greatest(p_days, 1))
           ) as qualifying,
           count(*) filter (where x.logged_at is null) as unlogged
      from activities x
     where x.type = 'call' and x.user_id in (select id from team)
     group by x.user_id
  )
  select
    t.id, t.full_name, t.role, t.location, t.prospect_limit,
    coalesce(b.owned, 0), coalesce(b.at_risk, 0), coalesce(b.customers, 0),
    coalesce(m.calls, 0), coalesce(m.qualifying, 0), coalesce(m.unlogged, 0)
  from team t
  left join books b on b.owner_id = t.id
  left join made  m on m.user_id  = t.id
  order by t.full_name
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- The distinct values a filter offers.
--
-- Read from the caller's visible accounts rather than from a hardcoded list, so
-- the State dropdown contains the states that exist in the book and nothing
-- else. Twelve options a rep can use beats fifty that mostly return nothing.
-- ---------------------------------------------------------------------------
create or replace function account_filter_options()
returns table (kind text, value text, uses bigint) as $$
  select 'state', upper(billing_state), count(*)
    from accounts where billing_state is not null and btrim(billing_state) <> ''
   group by 2
  union all
  select 'city', billing_city, count(*)
    from accounts where billing_city is not null and btrim(billing_city) <> ''
   group by 2
  union all
  select 'industry', industry, count(*)
    from accounts where industry is not null and btrim(industry) <> ''
   group by 2
  union all
  select 'owner_location', u.location, count(*)
    from accounts a join users u on u.id = a.owner_id
   where u.location is not null
   group by 2
  order by 1, 3 desc, 2
$$ language sql stable;

do $$
declare
  r text;
  f text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach f in array array[
        'in_scope(uuid, text)',
        'dashboard_kpis(text)',
        'dashboard_calls_daily(int, text)',
        'dashboard_stage_funnel(text)',
        'dashboard_industry_mix(text, int)',
        'dashboard_team(int)',
        'account_filter_options()'
      ] loop
        execute format('grant execute on function %s to %I', f, r);
      end loop;
    end if;
  end loop;
end $$;
