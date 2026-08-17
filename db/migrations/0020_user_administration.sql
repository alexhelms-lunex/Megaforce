-- 0020_user_administration.sql
--
-- People, as something an administrator can actually manage.
--
-- ===========================================================================
-- WHY THIS IS NOT JUST A FORM OVER THE users TABLE
--
-- Admins already had write access to `users` through row level security, so a
-- CRUD screen was always possible. It would also have been dangerous, because
-- four of the operations an administrator most wants are the four that can
-- break the application from the inside:
--
--   Removing the last admin. Nobody can put it back. The only route out is a
--   SQL console, which is exactly what this application exists to avoid.
--
--   Deleting somebody who owns accounts. Ownership is a foreign key; the
--   delete either fails with a constraint error or, worse, cascades. Neither
--   is what "this person left" means. WordPress asks what to do with their
--   posts for the same reason, and the answer here is the same shape: release
--   the accounts to the pool, or hand them to somebody.
--
--   Pointing somebody's manager at their own subordinate. The org chart is
--   walked recursively by visible_user_ids(); a cycle in it is an infinite
--   loop in the security policy that governs every read in the system.
--
--   Demoting yourself. Recoverable only by another admin, and there may not be
--   one awake.
--
-- So the rules live in the database rather than in a form's validation. A UI
-- can be bypassed by a second tab, a stale page, or a future screen written by
-- somebody who has not read this file. A trigger cannot.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

-- Deactivation, not deletion. Somebody who has left still has their name on
-- every activity they logged and every account they held, and the history is
-- the point -- "who had this in March" is what a territory argument turns on.
alter table users add column if not exists active boolean not null default true;
alter table users add column if not exists deactivated_at timestamptz;
alter table users add column if not exists title text;
alter table users add column if not exists phone text;
alter table users add column if not exists notes text;

create index if not exists users_active_idx on users(active) where active;
create index if not exists users_role_idx on users(role);

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

/**
 * The rules that cannot be allowed to be broken by any screen, ever.
 *
 * Written as a trigger rather than as checks inside the admin functions,
 * because the admin functions are not the only way a row gets written -- RLS
 * lets an admin UPDATE users directly, and a future screen will.
 */
create or replace function guard_user_changes() returns trigger as $$
declare
  admins_left int;
  cycle_check uuid;
  hops int := 0;
begin
  -- 1. THE LAST ADMIN STAYS AN ADMIN.
  if tg_op = 'UPDATE'
     and old.role = 'admin'
     and (new.role <> 'admin' or new.active = false) then
    select count(*) into admins_left
      from users
     where role = 'admin' and active and id <> old.id;

    if admins_left = 0 then
      raise exception
        'This is the last active administrator. Promote somebody else first, or nobody can administer the system.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- 2. NOBODY MANAGES THEMSELVES.
  if new.manager_id = new.id then
    raise exception 'Somebody cannot be their own manager.'
      using errcode = 'check_violation';
  end if;

  -- 3. NO CYCLES IN THE ORG CHART.
  --
  -- visible_user_ids() walks this tree recursively on every read in the
  -- application. A loop here is not a bad org chart, it is a hung query on
  -- every screen at once.
  if new.manager_id is not null
     and (tg_op = 'INSERT' or new.manager_id is distinct from old.manager_id) then
    cycle_check := new.manager_id;
    while cycle_check is not null and hops < 50 loop
      if cycle_check = new.id then
        raise exception 'That would put % under somebody who already reports to them.', new.full_name
          using errcode = 'check_violation';
      end if;
      select manager_id into cycle_check from users where id = cycle_check;
      hops := hops + 1;
    end loop;
  end if;

  -- 4. DEACTIVATION IS STAMPED, REACTIVATION IS CLEARED.
  if tg_op = 'UPDATE' and new.active is distinct from old.active then
    new.deactivated_at := case when new.active then null else now() end;
  end if;

  return new;
end $$ language plpgsql;

drop trigger if exists guard_user_changes_trigger on users;
create trigger guard_user_changes_trigger
  before insert or update on users
  for each row execute function guard_user_changes();

-- ---------------------------------------------------------------------------
-- Reading
-- ---------------------------------------------------------------------------

/**
 * The user list, with the numbers that make a name mean something.
 *
 * Accounts held and calls logged are here rather than fetched per row: a
 * WordPress-style list is forty rows, and forty extra round trips to decorate
 * them is how an admin screen becomes the slowest page in an application.
 *
 * SECURITY DEFINER, and it checks the caller's role itself. Every non-admin
 * gets an empty set rather than an error, because this is called from a screen
 * they should not have reached and a stack trace is not an improvement.
 */
create or replace function admin_users(
  p_search text default '',
  p_role text default '',
  p_status text default 'active',
  p_limit int default 50,
  p_offset int default 0
) returns table (
  id uuid,
  email text,
  full_name text,
  role text,
  title text,
  location text,
  phone text,
  start_date date,
  prospect_limit int,
  active boolean,
  deactivated_at timestamptz,
  manager_id uuid,
  manager_name text,
  has_login boolean,
  accounts_held bigint,
  calls_30d bigint,
  created_at timestamptz,
  total_rows bigint
) as $$
  with allowed as (
    select (select current_user_role()) = 'admin' as ok
  ),
  base as (
    select u.*, m.full_name as manager_name
      from users u
      left join users m on m.id = u.manager_id
     where (select ok from allowed)
       and (p_role = '' or u.role = p_role)
       and (
         p_status = 'all'
         or (p_status = 'active' and u.active)
         or (p_status = 'inactive' and not u.active)
         or (p_status = 'nologin' and u.auth_id is null)
       )
       and (
         coalesce(p_search, '') = ''
         or u.full_name ilike '%' || p_search || '%'
         or u.email ilike '%' || p_search || '%'
         or coalesce(u.location, '') ilike '%' || p_search || '%'
       )
  ),
  counted as (
    select b.*, count(*) over () as total_rows from base b
  )
  select c.id, c.email, c.full_name, c.role, c.title, c.location, c.phone,
         c.start_date, c.prospect_limit, c.active, c.deactivated_at,
         c.manager_id, c.manager_name,
         c.auth_id is not null,
         (select count(*) from accounts a where a.owner_id = c.id),
         (select count(*) from activities x
           where x.user_id = c.id and x.occurred_at > now() - interval '30 days'),
         c.created_at,
         c.total_rows
    from counted c
   order by c.active desc, c.full_name
   limit greatest(1, least(p_limit, 200))
  offset greatest(0, p_offset)
$$ language sql stable security definer set search_path = public, auth;

/**
 * The counts behind the filter links across the top of the list.
 *
 * WordPress puts them there because "Administrator (1)" is the fastest way to
 * notice that a role has one person in it who has left.
 */
create or replace function admin_user_counts()
returns table (bucket text, n bigint) as $$
  select * from (
    select 'all'::text, count(*) from users where (select current_user_role()) = 'admin'
    union all
    select 'active', count(*) from users
     where (select current_user_role()) = 'admin' and active
    union all
    select 'inactive', count(*) from users
     where (select current_user_role()) = 'admin' and not active
    union all
    select 'nologin', count(*) from users
     where (select current_user_role()) = 'admin' and auth_id is null
    union all
    select role, count(*) from users
     where (select current_user_role()) = 'admin'
     group by role
  ) as t(bucket, n)
$$ language sql stable security definer set search_path = public, auth;

-- ---------------------------------------------------------------------------
-- Writing
-- ---------------------------------------------------------------------------

/**
 * Take somebody out of circulation, and say what happens to their book.
 *
 * p_disposition:
 *   'release'  -- every account goes back to the available pool for anyone to
 *                 claim. The honest default when somebody leaves: their book
 *                 was going stale from the day they stopped working it.
 *   'transfer' -- every account moves to p_transfer_to. For a handover, where
 *                 somebody is taking the book on deliberately.
 *   'keep'     -- accounts stay in their name. For a leave of absence, where
 *                 the person is coming back and their book should be waiting.
 *
 * Returns how many accounts moved, because "deactivated" and "deactivated and
 * quietly returned forty accounts to the pool" are different events and the
 * administrator should be told which one just happened.
 */
create or replace function admin_deactivate_user(
  p_user uuid,
  p_disposition text default 'release',
  p_transfer_to uuid default null
) returns int as $$
declare
  moved int := 0;
begin
  if (select current_user_role()) <> 'admin' then
    raise exception 'Only an administrator can deactivate somebody.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_user = (select current_user_id()) then
    raise exception 'You cannot deactivate your own login.'
      using errcode = 'check_violation';
  end if;

  if p_disposition = 'transfer' then
    if p_transfer_to is null then
      raise exception 'Choose who the accounts should go to.'
        using errcode = 'check_violation';
    end if;
    if not exists (select 1 from users where id = p_transfer_to and active) then
      raise exception 'That person is not an active user.'
        using errcode = 'check_violation';
    end if;

    update accounts set owner_id = p_transfer_to, last_release_reason = 'reassigned'
     where owner_id = p_user;
    get diagnostics moved = row_count;

  elsif p_disposition = 'release' then
    update accounts set owner_id = null, last_release_reason = 'reassigned'
     where owner_id = p_user;
    get diagnostics moved = row_count;
  end if;

  -- The guard trigger refuses this if they are the last active admin.
  update users set active = false where id = p_user;

  return moved;
end $$ language plpgsql security definer set search_path = public, auth;

create or replace function admin_reactivate_user(p_user uuid) returns void as $$
begin
  if (select current_user_role()) <> 'admin' then
    raise exception 'Only an administrator can reactivate somebody.'
      using errcode = 'insufficient_privilege';
  end if;
  update users set active = true where id = p_user;
end $$ language plpgsql security definer set search_path = public, auth;

/**
 * Change a role, with the one refusal that matters.
 *
 * Separate from a general update so the last-admin case produces a sentence
 * rather than a constraint violation, and so a bulk role change has one place
 * to go through.
 */
create or replace function admin_set_role(p_user uuid, p_role text) returns void as $$
begin
  if (select current_user_role()) <> 'admin' then
    raise exception 'Only an administrator can change a role.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_role not in ('broker', 'manager', 'credit', 'admin') then
    raise exception 'Unknown role: %', p_role using errcode = 'check_violation';
  end if;

  if p_user = (select current_user_id()) and p_role <> 'admin' then
    raise exception 'You cannot remove your own administrator role. Ask another admin.'
      using errcode = 'check_violation';
  end if;

  update users set role = p_role where id = p_user;
end $$ language plpgsql security definer set search_path = public, auth;

-- ---------------------------------------------------------------------------
-- What each role can do
-- ---------------------------------------------------------------------------

/**
 * The capability matrix, as data rather than as a paragraph in a README.
 *
 * ---------------------------------------------------------------------------
 * These rows do not GRANT anything. Every one of them is already enforced by a
 * row level security policy or a trigger, and this table describes what those
 * policies do in words an administrator can read.
 *
 * Two reasons that is worth a function of its own rather than a page of static
 * text. First, "who can see whose accounts" is the single most misunderstood
 * thing about this system, and the answer being on a screen ends the question.
 * Second, a description sitting beside the policy it describes is one somebody
 * will notice has gone stale; the same sentence in a document is not.
 * ---------------------------------------------------------------------------
 */
-- Dropped first, always. `create or replace` cannot change a function's return
-- type, and 0021 adds a column to this matrix -- so without the drop, a re-run
-- of this file against an up-to-date database fails with "cannot change return
-- type of existing function". Setup files are re-run whenever somebody is
-- confused, which is exactly when they must not break.
drop function if exists role_capabilities();

create function role_capabilities()
returns table (capability text, area text, broker boolean, manager boolean, credit boolean, admin boolean, detail text) as $$
  select * from (values
    ('See their own accounts', 'Accounts', true, true, true, true,
     'Everyone sees what they hold.'),
    ('See their team''s accounts', 'Accounts', false, true, true, true,
     'A manager sees everyone beneath them in the org chart, however many levels down.'),
    ('See every account in the company', 'Accounts', false, false, true, true,
     'Credit and admins are not in the org chart, so they get the whole book rather than a branch of it.'),
    ('Claim from the available pool', 'Accounts', true, true, true, true,
     'Anyone can take an unclaimed account. First click wins.'),
    ('Release their own accounts', 'Accounts', true, true, true, true,
     'You can always hand back what you hold.'),
    ('Release somebody else''s account', 'Accounts', false, false, true, true,
     'A manager cannot take an account off a broker directly — that is a transfer request, so there is a record of who asked and who agreed.'),
    ('Create accounts', 'Accounts', true, true, true, true,
     'Anyone can, but a duplicate name, address or phone number is flagged into Credit''s name automatically.'),
    ('Create a known duplicate', 'Accounts', false, false, true, true,
     'Only Credit and admins may deliberately create a second record for the same company.'),
    ('Edit an account flagged as a duplicate', 'Accounts', false, false, true, true,
     'A flagged record is locked to Credit until they decide which one is real.'),
    ('Set credit limits', 'Credit', false, false, true, true,
     'Credit status and limits come from Salesforce and are maintained by the credit team.'),
    ('Log calls and activities', 'Activity', true, true, true, true,
     'Everyone logs their own work.'),
    ('Resolve the review queue', 'Activity', true, true, true, true,
     'Anyone can attribute an unmatched call, because whoever recognises the number should be able to fix it.'),
    ('Raise an account request', 'Requests', true, true, true, true,
     'Amnesty, extension, transfer, early release or promotion to national.'),
    ('Decide a request', 'Requests', false, true, true, true,
     'Somebody above the person asking. Nobody can approve their own, including an admin.'),
    ('See company-wide reports', 'Reports', false, true, true, true,
     'A broker sees their own figures. A manager sees their line. Credit and admins see everything.'),
    ('Change the retention thresholds', 'Administration', false, false, false, true,
     'The clock everybody lives by. Admin only, and the change applies everywhere at once.'),
    ('Change what counts as approved activity', 'Administration', false, false, false, true,
     'The qualification rules. Admin only, for the same reason.'),
    ('Add, edit and deactivate users', 'Administration', false, false, false, true,
     'Admin only. The last active administrator cannot be demoted or deactivated by anybody, including themselves.'),
    ('Manage integrations and email', 'Administration', false, false, false, true,
     'RingCentral, the mail connection and the digest schedule.')
  ) as t(capability, area, broker, manager, credit, admin, detail)
$$ language sql immutable;

/** The roles themselves, with what each one is for. */
create or replace function role_catalogue()
returns table (key text, label text, summary text, sort int) as $$
  select * from (values
    ('broker',  'Broker',  'Holds a book of prospects and customers. Sees their own accounts and nobody else''s.', 1),
    ('manager', 'Manager', 'Everything a broker can do, plus the whole book of everyone reporting to them, and the power to decide their requests.', 2),
    ('credit',  'Credit',  'Sees every account in the company. Owns credit limits and the duplicate queue, and holds no book of their own.', 3),
    ('admin',   'Admin',   'Everything, including the rules the company runs on: the clock, the qualification rules, users and integrations.', 4)
  ) as t(key, label, summary, sort)
$$ language sql immutable;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function admin_users(text, text, text, int, int) to %I', r);
      execute format('grant execute on function admin_user_counts() to %I', r);
      execute format('grant execute on function admin_deactivate_user(uuid, text, uuid) to %I', r);
      execute format('grant execute on function admin_reactivate_user(uuid) to %I', r);
      execute format('grant execute on function admin_set_role(uuid, text) to %I', r);
      execute format('grant execute on function role_capabilities() to %I', r);
      execute format('grant execute on function role_catalogue() to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
