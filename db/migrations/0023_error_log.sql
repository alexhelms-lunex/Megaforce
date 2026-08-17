-- 0023_error_log.sql
--
-- Somewhere for a crash to be found again.
--
-- ===========================================================================
-- WHY
--
-- Production redacts server errors. Every failure in this application has
-- therefore looked identical from the outside -- "An error occurred in the
-- Server Components render. The specific message is omitted in production
-- builds" -- and each one cost a round trip to diagnose: a screenshot, a guess,
-- a deploy, another screenshot. Several took three. One took a fortnight.
--
-- The real message is captured server-side by onRequestError before any
-- redaction, and was being kept in a module-level array. That was wrong for a
-- reason that only shows up in production: Vercel runs many serverless
-- instances, they are created and discarded constantly, and the instance that
-- serves the request asking "what went wrong" is almost never the instance that
-- failed. So the page reliably reported that nothing had gone wrong, seconds
-- after something had.
--
-- A table is shared by every instance. That is the whole argument for it.
--
-- Deliberately small and self-trimming. This is for the ten minutes after
-- something breaks, not an audit trail -- an audit trail of crashes would grow
-- without bound and nobody would ever read row four hundred.
-- ===========================================================================

create table if not exists app_errors (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  /** Next's reference number. Useless on its own, which is rather the point. */
  digest text,
  message text not null,
  /** The route that failed, e.g. /admin/users/[id]. */
  path text,
  /** 'render' for a page, 'action' for a server action. */
  kind text,
  /** First few frames only. The rest is framework internals. */
  stack text,
  /** Which deployment. A crash fixed two deploys ago should look old. */
  release text
);

create index if not exists app_errors_at_idx on app_errors (at desc);

alter table app_errors enable row level security;

/*
 * Readable by administrators only, and by nobody else at all.
 *
 * A stack trace names files and an error message can quote a row somebody
 * should not see. There is deliberately no insert policy: writes arrive
 * through the service role, which bypasses row level security, so no signed-in
 * user can put anything in here.
 */
drop policy if exists app_errors_admin_read on app_errors;
create policy app_errors_admin_read on app_errors for select
  using ((select current_user_role()) = 'admin');

/**
 * Keep the last 200 and drop the rest.
 *
 * Runs on insert rather than on a schedule, because a schedule is another
 * moving part and this table only grows when something is already wrong.
 */
create or replace function trim_app_errors()
returns trigger as $$
begin
  delete from app_errors
   where id in (
     select id from app_errors order by at desc offset 200
   );
  return null;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists app_errors_trim on app_errors;
create trigger app_errors_trim
  after insert on app_errors
  for each statement execute function trim_app_errors();

notify pgrst, 'reload schema';

-- ===========================================================================
-- Two changes to user administration.
-- ===========================================================================

/**
 * A role change that matches nobody must say so.
 *
 * The role list is unchanged -- 0021 already widened it to include 'ad'. What
 * this adds is the check at the end. The function runs as its owner, so row
 * level security does not apply to it and an UPDATE matching no rows can only
 * mean the id is wrong. It returned void either way, so the action reported
 * "Role changed to broker" over a person who does not exist.
 */
create or replace function admin_set_role(p_user uuid, p_role text) returns void as $$
begin
  if (select current_user_role()) <> 'admin' then
    raise exception 'Only an administrator can change a role.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_role not in ('broker', 'manager', 'ad', 'credit', 'admin') then
    raise exception 'Unknown role: %', p_role using errcode = 'check_violation';
  end if;

  if p_user = (select current_user_id()) and p_role <> 'admin' then
    raise exception 'You cannot remove your own administrator role. Ask another admin.'
      using errcode = 'check_violation';
  end if;

  update users set role = p_role where id = p_user;

  -- Verified rather than assumed. This runs as the function's owner, so row
  -- level security does not apply and a miss means the id is wrong -- which
  -- the caller should hear about rather than being told the role changed.
  if not found then
    raise exception 'No such person.' using errcode = 'no_data_found';
  end if;
end $$ language plpgsql security definer set search_path = public, auth;

/**
 * One person, by id.
 *
 * The edit screen was reading the FIRST TWO HUNDRED users -- each with their
 * accounts-held and calls-in-30-days counts -- and then finding one of them in
 * JavaScript. That is a large query to answer a question about one row, it runs
 * again on every save, and it quietly 404s anybody who happens to sort past
 * position two hundred.
 */
create or replace function admin_user(p_id uuid)
returns table (
  id uuid, email text, full_name text, role text, title text, location text,
  phone text, start_date date, prospect_limit int, active boolean,
  deactivated_at timestamptz, manager_id uuid, manager_name text,
  has_login boolean, accounts_held bigint, calls_30d bigint,
  created_at timestamptz, total_rows bigint
) as $$
  select u.id, u.email, u.full_name, u.role, u.title, u.location, u.phone,
         u.start_date, u.prospect_limit, u.active, u.deactivated_at,
         u.manager_id, m.full_name,
         u.auth_id is not null,
         (select count(*) from accounts a where a.owner_id = u.id),
         (select count(*) from activities act
           where act.user_id = u.id and act.occurred_at > now() - interval '30 days'),
         u.created_at,
         1::bigint
    from users u
    left join users m on m.id = u.manager_id
   where u.id = p_id
     and (select current_user_role()) = 'admin'
$$ language sql stable security definer set search_path = public, auth;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function admin_user(uuid) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
