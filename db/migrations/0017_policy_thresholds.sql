-- 0017_policy_thresholds.sql
--
-- The thresholds the business actually runs on, and a release that happens
-- without anybody pressing anything.
--
-- ===========================================================================
-- THE NUMBERS WERE WRONG
--
-- A prospect was being released at 45 days. The rule is 30: past thirty days
-- without an approved activity, it is gone. A customer was at 120; the rule is
-- 180. Fifteen extra days on a prospect sounds small until you notice it means
-- the pool is permanently short of the accounts that should be in it, and every
-- broker is holding work they have already abandoned.
--
-- Mapped onto the two warning bands as follows, matching the policy's own
-- language:
--
--   PROSPECT   amber at 14  ·  red ("Expiring") at 21  ·  released at 31
--     The policy names Expiring as days 21-30 and release on day 31, so those
--     two are its words. The amber at 14 is the only invented number here: it
--     is a halfway nudge, and it exists because "you have nine days" is a worse
--     first warning than "you have sixteen".
--
--   CUSTOMER   amber at 90  ·  red at 150  ·  released at 181
--     Straight from the active-customer clock: 90 days At Risk, 150 Expiration,
--     181 Inactive. Note this still measures days since an approved ACTIVITY,
--     not days since a load -- loads live in the TMS and this system cannot see
--     them. The shape is right and the input is not, which is documented under
--     Known gaps on the Admin screen.
-- ===========================================================================

update account_retention_rules
   set warning_days = 14, expiring_days = 21, release_days = 31, updated_at = now()
 where applies_to = 'prospect';

-- "Engaged" is not in the policy; operationally it is still a prospect being
-- worked, so it runs on the same clock rather than on a softer one somebody
-- invented.
update account_retention_rules
   set warning_days = 14, expiring_days = 21, release_days = 31, updated_at = now()
 where applies_to = 'engaged';

update account_retention_rules
   set warning_days = 90, expiring_days = 150, release_days = 181, updated_at = now()
 where applies_to = 'customer';

-- ===========================================================================
-- THE RELEASE HAS TO HAPPEN BY ITSELF
--
-- The sweep exists and is correct, and until now the only thing that ran it was
-- an hourly cron -- which depends on a Vercel plan, an environment variable and
-- a deployment all being right. Every one of those is a way for accounts to sit
-- overdue for weeks with the screen cheerfully saying "26d over".
--
-- So the database now enforces it as well, from a function the application
-- calls on an ordinary page load. Belt and braces on purpose: this is the rule
-- the whole system exists to apply, and it should not be able to stop working
-- because somebody forgot to set a secret.
--
-- Rate-limited to once every fifteen minutes through job_runs, so a busy floor
-- refreshing dashboards does not run it hundreds of times an hour, and the run
-- is recorded exactly as the scheduled one is.
-- ===========================================================================
create or replace function sweep_if_due(p_max_age_minutes int default 15)
returns table (ran boolean, released int) as $$
declare
  last_run timestamptz;
  n int := 0;
  enabled boolean;
  run_id uuid;
begin
  select coalesce((value)::text = 'true', true) into enabled
    from app_settings where key = 'lifecycle.release_enabled';
  if enabled is false then
    return query select false, 0;
    return;
  end if;

  select max(started_at) into last_run
    from job_runs
   where job = 'release-overdue-accounts' and ok;

  if last_run is not null and last_run > now() - make_interval(mins => greatest(p_max_age_minutes, 1)) then
    return query select false, 0;
    return;
  end if;

  -- Recorded before the work, like every other job, so a crash halfway leaves
  -- evidence it began rather than looking like it never ran.
  insert into job_runs (job, trigger) values ('release-overdue-accounts', 'auto')
  returning id into run_id;

  n := release_overdue_accounts();

  update job_runs
     set finished_at = now(), ok = true,
         result = jsonb_build_object('released', n)
   where id = run_id;

  return query select true, n;
end $$ language plpgsql security definer set search_path = public, auth;

-- SECURITY DEFINER above is load-bearing and worth stating plainly: releasing
-- an account means writing to a row the caller does not own and usually cannot
-- see. A broker opening their dashboard triggers the release of somebody else's
-- overdue account, which is exactly right -- the sweep is the system acting, not
-- the person acting.
--
-- It cannot be abused into anything else. It takes no account id, it only ever
-- sets owner_id to null, and it only touches rows that account_state() already
-- calls overdue.

alter table job_runs drop constraint if exists job_runs_trigger_check;
alter table job_runs add constraint job_runs_trigger_check
  check (trigger in ('schedule','manual','auto'));

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function sweep_if_due(int) to %I', r);
    end if;
  end loop;
end $$;

-- Bring the book into line immediately. Without this, every account that is
-- already past the corrected threshold waits for the next sweep, and the first
-- thing anyone sees after deploying is the same list of overdue accounts they
-- complained about.
select release_overdue_accounts();
