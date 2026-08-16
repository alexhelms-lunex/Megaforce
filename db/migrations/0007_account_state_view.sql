-- 0007_account_state_view.sql
--
-- A view carrying each account's lifecycle state, so the screens can read it
-- the same way they read any other column.
--
-- Why a view rather than computing it in the app: the pages talk to Postgres
-- through PostgREST, which selects columns and cannot call a function per row.
-- Without this the list would have to fetch every account and compute the flags
-- in JavaScript -- which means paging breaks, sorting by urgency becomes
-- impossible, and the definition of "amber" ends up living in two places.
--
-- security_invoker = true is the load-bearing part. A view normally runs with
-- its OWNER's permissions, which would hand every broker the entire book
-- through a side door and silently defeat every policy in 0002 and 0005. With
-- security_invoker the view runs as the caller, so the underlying accounts
-- policies apply exactly as they do to a direct query.
-- DROP then CREATE, never CREATE OR REPLACE.
--
-- The view selects a.* , so every column added to accounts changes its shape --
-- and CREATE OR REPLACE refuses to add or reorder columns, failing with
-- "cannot change name of view column". A later migration adding one column to
-- accounts would make this file un-runnable, which is exactly what happened
-- when 0008 introduced accounts.stage.
drop view if exists accounts_with_state;

create view accounts_with_state
with (security_invoker = true) as
select
  a.*,
  account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at)      as state,
  account_days_left(a.owner_id, a.status, a.last_activity_at, a.claimed_at)  as days_left,
  u.full_name                                                                as owner_name,
  u.email                                                                    as owner_email,
  -- Ordering key, so "most urgent first" is a plain ORDER BY rather than a
  -- CASE expression repeated in every query that needs it.
  case account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at)
    when 'overdue'   then 0
    when 'expiring'  then 1
    when 'warning'   then 2
    when 'fresh'     then 3
    when 'available' then 4
    else 5
  end                                                                        as urgency
from accounts a
left join users u on u.id = a.owner_id;

comment on view accounts_with_state is
  'Accounts with their lifecycle state computed. Runs as the caller, so row level security applies.';

-- Granted only to the roles that exist. Supabase provides `authenticated` and
-- `anon`; the local test harness has neither and provides `app_user` instead.
-- A bare GRANT would make this file runnable in exactly one of the two places,
-- and the whole point of these migrations is that they run identically in both.
do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant select on accounts_with_state to %I', r);
    end if;
  end loop;
end $$;
