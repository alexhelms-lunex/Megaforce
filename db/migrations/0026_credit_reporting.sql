-- 0026_credit_reporting.sql
--
-- The numbers a credit function is actually judged on.
--
-- ===========================================================================
-- WHY THESE AND NOT OTHERS
--
-- The reporting engine measures selling: calls made, activities approved,
-- accounts claimed, accounts lost. Every one of those is zero for Customer
-- Credit by construction -- they hold no book and make no calls -- so pointing
-- them at Reports produced a page of zeroes and a leaderboard they are last on.
--
-- A credit function is judged on two things, and neither of them was recorded
-- anywhere before 0025 gave credit limits a queue:
--
--   THROUGHPUT   how much came in, how much went out
--   TURNAROUND   how long somebody waited
--
-- Turnaround is the one that matters. A broker cannot quote without a limit, so
-- every day of delay is a stalled deal -- and until now the only person who knew
-- how long credit took was the broker who was waiting, who had no way to say so
-- except to ask again.
--
-- The third function answers the question that follows: WHO is asking, and are
-- their asks reasonable. A broker with a 30% approval rate is asking for the
-- wrong things, and that is a coaching conversation rather than a credit one.
-- ===========================================================================

/**
 * Credit decisions per day, over a window.
 *
 * Empty days are generated rather than omitted. A series that skips the days
 * with no decisions draws a line that slopes through the weekend as though work
 * happened, and makes a fortnight of silence look like a gentle decline.
 */
create or replace function report_credit_decisions(p_from date, p_to date)
returns table (
  day date,
  raised bigint,
  approved bigint,
  denied bigint,
  avg_hours_to_decide numeric
) as $$
  with days as (
    select generate_series(p_from, p_to, interval '1 day')::date as day
  )
  select
    d.day,
    (select count(*) from account_requests r
      where r.kind = 'credit' and r.created_at::date = d.day),
    (select count(*) from account_requests r
      where r.kind = 'credit' and r.status = 'approved' and r.decided_at::date = d.day),
    (select count(*) from account_requests r
      where r.kind = 'credit' and r.status = 'denied' and r.decided_at::date = d.day),
    (select round(avg(extract(epoch from (r.decided_at - r.created_at)) / 3600)::numeric, 1)
       from account_requests r
      where r.kind = 'credit' and r.decided_at::date = d.day)
    from days d
   where (select current_user_role()) in ('credit','admin')
   order by d.day
$$ language sql stable security definer set search_path = public, auth;

/**
 * How the window as a whole went.
 *
 * The median as well as the mean, because one request that sat over a holiday
 * drags an average into uselessness and then somebody argues about the average
 * instead of about the request.
 */
create or replace function report_credit_summary(p_from date, p_to date)
returns table (
  raised bigint,
  decided bigint,
  approved bigint,
  denied bigint,
  still_waiting bigint,
  approved_value numeric,
  mean_hours numeric,
  median_hours numeric,
  slowest_hours numeric
) as $$
  select
    count(*) filter (where r.created_at::date between p_from and p_to),
    count(*) filter (where r.decided_at::date between p_from and p_to),
    count(*) filter (where r.status = 'approved' and r.decided_at::date between p_from and p_to),
    count(*) filter (where r.status = 'denied' and r.decided_at::date between p_from and p_to),
    count(*) filter (where r.status = 'pending'),
    coalesce(sum(r.amount) filter (
      where r.status = 'approved' and r.decided_at::date between p_from and p_to), 0),
    round(avg(extract(epoch from (r.decided_at - r.created_at)) / 3600) filter (
      where r.decided_at::date between p_from and p_to)::numeric, 1),
    round(percentile_cont(0.5) within group (
      order by extract(epoch from (r.decided_at - r.created_at)) / 3600)::numeric, 1),
    round(max(extract(epoch from (r.decided_at - r.created_at)) / 3600) filter (
      where r.decided_at::date between p_from and p_to)::numeric, 1)
    from account_requests r
   where r.kind = 'credit'
     and (select current_user_role()) in ('credit','admin')
$$ language sql stable security definer set search_path = public, auth;

/**
 * Who is asking, and how often they are right.
 *
 * A broker whose asks are approved nine times in ten is reading their customers
 * correctly. One at three in ten is asking for the wrong things, and that is a
 * coaching conversation for their manager rather than a credit problem.
 */
create or replace function report_credit_by_requester(p_from date, p_to date, p_limit int default 25)
returns table (
  requester text,
  branch text,
  raised bigint,
  approved bigint,
  denied bigint,
  pending bigint,
  approved_value numeric,
  approval_rate numeric
) as $$
  select
    coalesce(u.full_name, 'Unknown'),
    u.location,
    count(*),
    count(*) filter (where r.status = 'approved'),
    count(*) filter (where r.status = 'denied'),
    count(*) filter (where r.status = 'pending'),
    coalesce(sum(r.amount) filter (where r.status = 'approved'), 0),
    case
      when count(*) filter (where r.status <> 'pending') = 0 then null
      else round(
        100.0 * count(*) filter (where r.status = 'approved')
             / count(*) filter (where r.status <> 'pending'), 0)
    end
    from account_requests r
    left join users u on u.id = r.requested_by
   where r.kind = 'credit'
     and r.created_at::date between p_from and p_to
     and (select current_user_role()) in ('credit','admin')
   group by u.full_name, u.location
   order by count(*) desc
   limit greatest(1, least(coalesce(p_limit, 25), 200))
$$ language sql stable security definer set search_path = public, auth;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function report_credit_decisions(date, date) to %I', r);
      execute format('grant execute on function report_credit_summary(date, date) to %I', r);
      execute format('grant execute on function report_credit_by_requester(date, date, int) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
