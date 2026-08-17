-- 0018_self_healing_thresholds.sql
--
-- Make the correct thresholds hold themselves in place, and make the release
-- happen from any screen rather than one.
--
-- ===========================================================================
-- WHY
--
-- 0017 corrected the thresholds with a one-time UPDATE. A one-time UPDATE has
-- one failure mode and it is total: if that migration has not run against a
-- given database -- because the deployment serving it is older than the
-- migration -- the rules stay at 45 days forever and every screen quietly
-- enforces the wrong policy. There is nothing in the system that notices.
--
-- That is exactly what happened, and from the outside it was indistinguishable
-- from the release being broken: accounts sat at "24d over" because 69 days
-- against a 45-day rule IS 24 days over. The code was right and the database
-- was old, and no screen could tell the difference.
--
-- So the numbers stop being a thing that was set once and become a thing that
-- is checked. ensure_policy_thresholds() is called on every sweep; if the rules
-- have drifted from the policy it puts them back and says so in job_runs.
-- ===========================================================================

/**
 * The policy's numbers, as a function rather than as a migration side effect.
 *
 * Returns how many rows it had to correct, so a drift is visible in job_runs
 * rather than silently repaired -- somebody editing a threshold by hand and
 * finding it reverted deserves to be able to see why.
 */
create or replace function ensure_policy_thresholds() returns int as $$
declare
  fixed int := 0;
  r record;
begin
  for r in
    select * from (values
      ('prospect', 14, 21, 31),
      ('engaged',  14, 21, 31),
      ('customer', 90, 150, 181)
    ) as v(applies_to, w, e, rel)
  loop
    -- Insert when the row is missing entirely: account_state() falls back to
    -- the prospect rule and, with that gone, calls the whole book healthy.
    if not exists (select 1 from account_retention_rules a
                    where a.applies_to = r.applies_to and a.active) then
      insert into account_retention_rules (applies_to, warning_days, expiring_days, release_days)
      values (r.applies_to, r.w, r.e, r.rel);
      fixed := fixed + 1;
      continue;
    end if;

    update account_retention_rules
       set warning_days = r.w, expiring_days = r.e, release_days = r.rel, updated_at = now()
     where applies_to = r.applies_to and active
       and (warning_days, expiring_days, release_days) is distinct from (r.w, r.e, r.rel);

    if found then
      fixed := fixed + 1;
    end if;
  end loop;

  return fixed;
end $$ language plpgsql security definer set search_path = public, auth;

/**
 * Correct the rules, then release whatever is past them.
 *
 * Order matters: correcting the thresholds after the sweep would leave a full
 * cycle of accounts sitting overdue under the old numbers, which is the exact
 * complaint this is answering.
 */
create or replace function sweep_if_due(p_max_age_minutes int default 15)
returns table (ran boolean, released int) as $$
declare
  last_run timestamptz;
  n int := 0;
  corrected int := 0;
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

  insert into job_runs (job, trigger) values ('release-overdue-accounts', 'auto')
  returning id into run_id;

  corrected := ensure_policy_thresholds();
  n := release_overdue_accounts();

  update job_runs
     set finished_at = now(), ok = true,
         result = jsonb_build_object('released', n, 'thresholds_corrected', corrected)
   where id = run_id;

  return query select true, n;
end $$ language plpgsql security definer set search_path = public, auth;

-- Correct them now, and take back anything the correction has just made
-- overdue, so a database that has been running on the wrong numbers is right
-- the moment this file lands rather than at the next tick.
select ensure_policy_thresholds();
select release_overdue_accounts();

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function ensure_policy_thresholds() to %I', r);
    end if;
  end loop;
end $$;
