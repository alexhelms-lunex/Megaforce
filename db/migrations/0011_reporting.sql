-- 0011_reporting.sql
--
-- Rollups for the reports screen.
--
-- Same rules as 0010: SECURITY INVOKER, so row level security decides who
-- appears in a leaderboard rather than a role check in the application. A
-- broker running the leaderboard sees themselves; a manager sees their whole
-- subtree; an admin sees the floor. Nobody sees anybody they could not already
-- read with a direct query.
--
-- Written as CTEs joined once, not as correlated subqueries per user. The
-- difference is the difference between one scan of activities and one scan per
-- rep; at a thousand users the second shape is a timeout, and it looks fine on
-- a demo dataset right up until it does not.

-- ---------------------------------------------------------------------------
-- Who is working, and whether the work is landing.
--
-- Includes the caller, unlike dashboard_team -- a leaderboard you are absent
-- from is a leaderboard nobody trusts. Ordered by QUALIFYING calls rather than
-- calls made, because dialling a number for nine seconds is not work and a
-- board that rewards it teaches the wrong thing.
-- ---------------------------------------------------------------------------
create or replace function dashboard_leaderboard(p_days int default 30)
returns table (
  user_id        uuid,
  full_name      text,
  role           text,
  location       text,
  prospect_limit int,
  owned          bigint,
  at_risk        bigint,
  customers      bigint,
  calls          bigint,
  qualifying     bigint,
  connected_rate numeric
) as $$
  with team as (
    select u.id, u.full_name, u.role, u.location, u.prospect_limit
      from users u
     where u.id in (select visible_user_ids())
       and u.role in ('broker','manager')
  ),
  books as (
    select a.owner_id,
           count(*)                                                        as owned,
           count(*) filter (where a.state in ('warning','expiring','overdue')) as at_risk,
           count(*) filter (where a.status = 'customer')                   as customers
      from accounts_with_state a
     where a.owner_id in (select id from team)
     group by a.owner_id
  ),
  made as (
    select x.user_id,
           count(*)                              as calls,
           count(*) filter (where x.qualifies)   as qualifying
      from activities x
     where x.type = 'call'
       and x.occurred_at >= now() - make_interval(days => greatest(p_days, 1))
       and x.user_id in (select id from team)
     group by x.user_id
  )
  select
    t.id, t.full_name, t.role, t.location, t.prospect_limit,
    coalesce(b.owned, 0), coalesce(b.at_risk, 0), coalesce(b.customers, 0),
    coalesce(m.calls, 0), coalesce(m.qualifying, 0),
    -- Share of calls that actually counted. Null rather than zero when nobody
    -- called: "0%" and "did not call" are different facts, and a report that
    -- conflates them starts an argument the report cannot settle.
    case when coalesce(m.calls, 0) = 0 then null
         else round(100.0 * m.qualifying / m.calls, 0) end
  from team t
  left join books b on b.owner_id = t.id
  left join made  m on m.user_id  = t.id
  order by 10 desc, 9 desc, 2
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- By branch.
--
-- Books are held by people, and people sit in offices. This is the rollup a
-- Sales Director reads before deciding where the next hire goes.
-- ---------------------------------------------------------------------------
create or replace function dashboard_by_branch(p_days int default 30)
returns table (
  location   text,
  reps       bigint,
  owned      bigint,
  at_risk    bigint,
  customers  bigint,
  calls      bigint,
  qualifying bigint
) as $$
  with team as (
    select u.id, coalesce(u.location, 'Unassigned') as branch
      from users u
     where u.id in (select visible_user_ids())
       and u.role in ('broker','manager')
  ),
  head as (
    select branch, count(*) as reps from team group by branch
  ),
  books as (
    select t.branch,
           count(*)                                                            as owned,
           count(*) filter (where a.state in ('warning','expiring','overdue'))  as at_risk,
           count(*) filter (where a.status = 'customer')                       as customers
      from team t
      join accounts_with_state a on a.owner_id = t.id
     group by t.branch
  ),
  made as (
    select t.branch,
           count(*)                             as calls,
           count(*) filter (where x.qualifies)  as qualifying
      from team t
      join activities x on x.user_id = t.id
     where x.type = 'call'
       and x.occurred_at >= now() - make_interval(days => greatest(p_days, 1))
     group by t.branch
  )
  select
    h.branch, h.reps,
    coalesce(b.owned, 0), coalesce(b.at_risk, 0), coalesce(b.customers, 0),
    coalesce(m.calls, 0), coalesce(m.qualifying, 0)
  from head h
  left join books b on b.branch = h.branch
  left join made  m on m.branch = h.branch
  order by 3 desc, 1
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- How the book is distributed across the clock, and across status.
--
-- Two breakdowns from one call rather than two round trips. "Sixty accounts are
-- amber" and "sixty accounts are prospects" answer different questions, so they
-- come back tagged by kind and are drawn as separate lists.
-- ---------------------------------------------------------------------------
create or replace function dashboard_state_mix(p_scope text default 'team')
returns table (bucket text, kind text, accounts bigint) as $$
  -- The unclaimed pool is included in the team view because "what is sitting
  -- available" is part of the picture a manager needs; it belongs to nobody, so
  -- in_scope() alone would drop it.
  select a.state, 'clock'::text, count(*)
    from accounts_with_state a
   where in_scope(a.owner_id, p_scope) or (p_scope = 'team' and a.owner_id is null)
   group by a.state
  union all
  select a.status, 'status'::text, count(*)
    from accounts_with_state a
   where in_scope(a.owner_id, p_scope) or (p_scope = 'team' and a.owner_id is null)
   group by a.status
$$ language sql stable;

do $$
declare
  r text;
  f text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach f in array array[
        'dashboard_leaderboard(int)',
        'dashboard_by_branch(int)',
        'dashboard_state_mix(text)'
      ] loop
        execute format('grant execute on function %s to %I', f, r);
      end loop;
    end if;
  end loop;
end $$;
