-- 0014_clock_integrity.sql
--
-- "Are we sure this clock will always tick, and never fail?"
--
-- No. It had five ways to fail, four of them silent. Silent is the important
-- word: every one of these leaves the screens looking completely normal while
-- the rule underneath has stopped being enforced. They are fixed here, and each
-- one has a test named after it in db/clock-integrity.test.ts.
--
--   1. NOTHING EVER RELEASED. release_overdue_accounts() was written, tested,
--      and never scheduled. Accounts reached 'overdue' and sat there forever.
--      Fixed outside this file, in the cron route -- but the health check below
--      now reports it, so it cannot go unnoticed again.
--
--   2. A FUTURE-DATED ACTIVITY FROZE THE CLOCK. bump_last_activity took
--      new.occurred_at at face value. One webhook with a clock-skewed timestamp
--      -- or a bad import -- sets last_activity_at to 2027 and that account
--      never expires again. Nothing on any screen would look wrong.
--
--   3. THE RULES COULD GO MISSING. account_state() falls back to the prospect
--      rule, and if that is absent returns 'fresh'. Delete or deactivate one
--      row and the entire book reports healthy forever. There was also nothing
--      stopping two active rows for the same status, with `limit 1` picking
--      between them arbitrarily from one query to the next.
--
--   4. MOVING AN ACTIVITY LEFT THE CLOCK BEHIND. The bump fired on insert, and
--      on qualifies flipping false->true. Re-pointing an already-qualifying
--      activity at the right company -- exactly what fixing a mis-match is --
--      changed account_id without touching qualifies, so the correct account's
--      clock never moved.
--
--   5. NO WAY TO SEE ANY OF THIS. Added at the bottom: clock_health(), which
--      the Admin screen reads.

-- ---------------------------------------------------------------------------
-- 2 and 4: the bump
-- ---------------------------------------------------------------------------
create or replace function bump_last_activity() returns trigger as $$
declare
  effective timestamptz;
begin
  if not new.qualifies or new.account_id is null then
    return new;
  end if;

  -- Never credit an account for work dated in the future. Clock skew on a
  -- telephony webhook is ordinary; an account that can never expire because of
  -- it is not. Clamped rather than rejected, because the call did happen and
  -- refusing the row would lose it.
  effective := least(new.occurred_at, now());

  update accounts
     set last_activity_at = greatest(coalesce(last_activity_at, effective), effective),
         updated_at       = now()
   where id = new.account_id
     and (last_activity_at is null or last_activity_at < effective);

  return new;
end $$ language plpgsql;

-- Fires when an activity is moved to a different company, which is what
-- resolving a mis-matched call actually does. Without it the correcting action
-- fixes the record and leaves the clock wrong.
drop trigger if exists t_bump_last_activity_account on activities;
create trigger t_bump_last_activity_account after update of account_id on activities
  for each row when (new.account_id is distinct from old.account_id and new.qualifies)
  execute function bump_last_activity();

-- ---------------------------------------------------------------------------
-- 3: the rules cannot go missing or double up
-- ---------------------------------------------------------------------------

-- One active rule per status. Two would make account_state() pick between them
-- arbitrarily, so an account could change colour between two page loads with
-- nothing having happened.
create unique index if not exists account_retention_rules_one_active_idx
  on account_retention_rules(applies_to) where active;

create unique index if not exists qualification_rules_one_active_idx
  on qualification_rules(activity_type) where active;

-- Restore any status that has lost its rule. The defaults are the shipped ones;
-- this only fires when a row is genuinely absent, so it cannot overwrite a
-- deliberate change.
insert into account_retention_rules (applies_to, warning_days, expiring_days, release_days)
select v.applies_to, v.w, v.e, v.r
  from (values ('prospect',21,30,45), ('engaged',30,45,60), ('customer',60,90,120))
       as v(applies_to, w, e, r)
 where not exists (
   select 1 from account_retention_rules r2 where r2.applies_to = v.applies_to and r2.active
 );

-- ---------------------------------------------------------------------------
-- The tenure counter
--
-- "When I pick it up and log my first activity it goes to one. If it falls out
-- of my name it resets. So whoever gets it next -- including me -- sees zero,
-- and a new counter appears."
--
-- Derived rather than stored. A counter column would need incrementing on every
-- qualifying activity and zeroing on every ownership change, and the day those
-- two got out of step the number would be wrong with nothing to check it
-- against. Counted from claimed_at, which 0013 already resets when the account
-- changes hands, so the reset is automatic and cannot be forgotten.
-- ---------------------------------------------------------------------------
create or replace function account_tenure_activities(
  p_account_id uuid,
  p_claimed_at timestamptz
) returns bigint as $$
  select count(*)
    from activities x
   where x.account_id = p_account_id
     and x.qualifies
     and p_claimed_at is not null
     and x.occurred_at >= p_claimed_at
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- The full ownership timeline
--
-- Every holder with the dates and how long they held it, AND the periods the
-- account sat unclaimed, as segments in the same list. A gap is a fact about
-- the account -- often the most interesting one, because it is when a competitor
-- had a clear run at it -- so it is a row rather than whitespace between rows.
-- ---------------------------------------------------------------------------
create or replace function account_ownership_timeline(p_account_id uuid)
returns table (
  segment        text,
  user_id        uuid,
  user_name      text,
  started_at     timestamptz,
  ended_at       timestamptz,
  days_held      numeric,
  release_reason text,
  qualifying_activities bigint
) as $$
declare
  acct          record;
  c             record;
  cursor_at     timestamptz;
  seg_end       timestamptz;
begin
  select id, created_at, owner_id, claimed_at into acct
    from accounts where id = p_account_id;
  if not found then
    return;
  end if;

  cursor_at := acct.created_at;

  for c in
    select cl.user_id, cl.claimed_at, cl.released_at, cl.release_reason, u.full_name
      from account_claims cl
      left join users u on u.id = cl.user_id
     where cl.account_id = p_account_id
     order by cl.claimed_at
  loop
    -- The unclaimed stretch before this claim, if there was one. A minute of
    -- slack absorbs the ordinary case where a release and a re-claim land in
    -- the same transaction and would otherwise show as a zero-length gap.
    if c.claimed_at > cursor_at + interval '1 minute' then
      segment := 'available';
      user_id := null;
      user_name := null;
      started_at := cursor_at;
      ended_at := c.claimed_at;
      days_held := round(extract(epoch from (c.claimed_at - cursor_at)) / 86400.0, 1);
      release_reason := null;
      qualifying_activities := 0;
      return next;
    end if;

    seg_end := c.released_at;

    segment := 'owned';
    user_id := c.user_id;
    user_name := coalesce(c.full_name, 'Removed user');
    started_at := c.claimed_at;
    ended_at := seg_end;
    days_held := round(extract(epoch from (coalesce(seg_end, now()) - c.claimed_at)) / 86400.0, 1);
    release_reason := c.release_reason;
    -- What they actually did with it, counted inside their own window. This is
    -- the column that turns a list of names into an argument about who worked
    -- the account.
    qualifying_activities := (
      select count(*) from activities x
       where x.account_id = p_account_id
         and x.qualifies
         and x.occurred_at >= c.claimed_at
         and (seg_end is null or x.occurred_at < seg_end)
    );
    return next;

    cursor_at := coalesce(seg_end, now());
  end loop;

  -- Sitting in the pool right now: the open-ended segment on the end.
  if acct.owner_id is null and cursor_at < now() - interval '1 minute' then
    segment := 'available';
    user_id := null;
    user_name := null;
    started_at := cursor_at;
    ended_at := null;
    days_held := round(extract(epoch from (now() - cursor_at)) / 86400.0, 1);
    release_reason := null;
    qualifying_activities := 0;
    return next;
  end if;
end $$ language plpgsql stable;

-- ---------------------------------------------------------------------------
-- 5: a health check, so a stopped clock is visible
--
-- Every failure above is silent by nature. This is the screen that breaks the
-- silence: it reports what is wrong in plain sentences, and the Admin page
-- reads it. A monitoring system nobody looks at is not monitoring; a red band
-- on the page an administrator already opens is.
-- ---------------------------------------------------------------------------
create or replace function clock_health()
returns table (check_name text, ok boolean, detail text) as $$
  -- Has the sweep run? Anything sitting overdue for more than a day means the
  -- scheduled job is not firing, which is the failure that hides best: the
  -- flags all look right and nothing is ever actually taken.
  select
    'nightly release',
    count(*) = 0,
    case when count(*) = 0
      then 'No account has been overdue for more than a day.'
      else count(*) || ' accounts have been overdue over 24h. The scheduled release is not running.'
    end
  from accounts a
  where a.owner_id is not null
    and coalesce(a.retention_override_until, '-infinity'::timestamptz) <= now()
    and account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at,
                      a.retention_override_until) = 'overdue'
    and coalesce(a.last_activity_at, a.claimed_at) < now() - interval '1 day'
      - (select make_interval(days => release_days) from account_retention_rules
          where applies_to = coalesce(a.status,'prospect') and active limit 1)

  union all

  select
    'retention rules',
    count(*) = 3,
    case when count(*) = 3
      then 'All three statuses have exactly one active rule.'
      else 'Expected one active rule each for prospect, engaged and customer; found ' || count(*) || '.'
    end
  from account_retention_rules where active

  union all

  select
    'future-dated activity',
    count(*) = 0,
    case when count(*) = 0
      then 'No account is holding a clock date in the future.'
      else count(*) || ' accounts have last_activity_at in the future and can never expire.'
    end
  from accounts where last_activity_at > now() + interval '1 hour'

  union all

  -- A call nobody owns cannot appear in anybody's dock, so it can never be
  -- written up, so it can never count. It is not lost -- it is invisible.
  select
    'unassignable calls',
    count(*) = 0,
    case when count(*) = 0
      then 'Every unlogged call belongs to somebody who can write it up.'
      else count(*) || ' unlogged calls have no owner and appear in no dock. See the review queue.'
    end
  from activities
  where type = 'call' and logged_at is null and user_id is null

  union all

  select
    'qualification rules',
    bool_and(ok),
    case when bool_and(ok) then 'Call rule is 60s and requires an outcome, per policy.'
         else 'The call qualification rule does not match the prospecting policy.' end
  from (
    select (min_duration_seconds = 60 and requires_outcome) as ok
      from qualification_rules where activity_type = 'call' and active
  ) q
$$ language sql stable;

do $$
declare
  r text;
  f text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach f in array array[
        'account_tenure_activities(uuid, timestamptz)',
        'account_ownership_timeline(uuid)',
        'clock_health()'
      ] loop
        execute format('grant execute on function %s to %I', f, r);
      end loop;
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Rebuild the view with the tenure counter.
-- ---------------------------------------------------------------------------
drop view if exists accounts_with_state;

create view accounts_with_state
with (security_invoker = true) as
select
  a.*,
  account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at, a.retention_override_until)     as state,
  account_days_left(a.owner_id, a.status, a.last_activity_at, a.claimed_at, a.retention_override_until) as days_left,
  account_tenure_activities(a.id, a.claimed_at)                             as tenure_activities,
  u.full_name                                                               as owner_name,
  u.email                                                                   as owner_email,
  u.location                                                                as owner_location,
  ad.full_name                                                              as ad_owner_name,
  p.name                                                                    as parent_account_name,
  (select count(*) from accounts c where c.parent_account_id = a.id)        as child_count,
  (select count(*) from contacts c2 where c2.account_id = a.id)             as contact_count,
  (select count(*) from account_requests r
    where r.account_id = a.id and r.status = 'pending')                     as open_requests,
  case account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at, a.retention_override_until)
    when 'overdue' then 0 when 'expiring' then 1 when 'warning' then 2
    when 'fresh' then 3 when 'protected' then 4 when 'available' then 5
    else 6
  end                                                                       as urgency,
  (select max(occurred_at) from activities x where x.account_id = a.id)     as last_communicated_at
from accounts a
left join users u  on u.id = a.owner_id
left join users ad on ad.id = a.ad_owner_id
left join accounts p on p.id = a.parent_account_id;

comment on view accounts_with_state is
  'Accounts with their lifecycle state computed. Runs as the caller, so row level security applies.';

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant select on accounts_with_state to %I', r);
    end if;
  end loop;
end $$;
