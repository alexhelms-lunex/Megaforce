-- 0002_rls.sql
-- Row level security.
--
-- The sharing model, stated once in plain language so it can be defended out
-- loud:
--
--   * A rep sees and edits the accounts they own.
--   * A manager sees and edits everything owned by anyone beneath them on the
--     org chart -- their reports, their reports' reports, all the way down.
--   * An admin sees and edits everything.
--   * Nobody except an admin can change who OWNS an account. Managers can fix a
--     wrong deal amount; they cannot quietly move a rep's account to someone
--     else. That restriction is a trigger, because RLS in Postgres operates on
--     whole rows and cannot protect a single column.
--
-- Reads of these helpers are wrapped in `(select ...)` throughout. The subquery
-- form is evaluated once per query as an InitPlan; a bare call is evaluated
-- once per ROW. On a 20,000 row activity table that is the difference between a
-- fast page and a hung one.

-- ---------------------------------------------------------------------------
-- Identity helpers
-- ---------------------------------------------------------------------------

-- Maps the Supabase Auth session to our own users row.
create or replace function current_user_id() returns uuid as $$
  select id from users where auth_id = (select auth.uid())
$$ language sql stable security definer set search_path = public, auth;

create or replace function current_user_role() returns text as $$
  select role from users where auth_id = (select auth.uid())
$$ language sql stable security definer set search_path = public, auth;

-- Every user whose records the caller may touch: themselves, plus the entire
-- subtree beneath them, plus everyone if they are an admin.
create or replace function visible_user_ids() returns setof uuid as $$
  with recursive me as (
    select id, role from users where auth_id = (select auth.uid())
  ),
  team as (
    select u.id from users u join me on u.id = me.id
    union all
    select u.id from users u join team t on u.manager_id = t.id
  )
  select id from team
  union
  select u.id from users u where (select role from me) = 'admin'
$$ language sql stable security definer set search_path = public, auth;

-- ---------------------------------------------------------------------------
-- Enable RLS
-- FORCE makes the policies apply to the table owner as well, so a migration
-- connection cannot silently sidestep them. The service role used by the
-- webhook worker has BYPASSRLS and is deliberately unaffected.
-- ---------------------------------------------------------------------------
alter table users                enable row level security;
alter table accounts             enable row level security;
alter table contacts             enable row level security;
alter table opportunities        enable row level security;
alter table activities           enable row level security;
alter table unmatched_activities enable row level security;
alter table field_defs           enable row level security;
alter table qualification_rules  enable row level security;
alter table saved_views          enable row level security;
alter table raw_events           enable row level security;

alter table accounts             force row level security;
alter table contacts             force row level security;
alter table opportunities        force row level security;
alter table activities           force row level security;

-- ---------------------------------------------------------------------------
-- users
-- The directory is readable by every signed-in user -- you cannot render "owned
-- by Dana Whitfield" otherwise, and colleague names are not sensitive. Writes
-- are admin-only. This policy deliberately does NOT call visible_user_ids(),
-- which reads this same table; keeping it simple avoids recursive evaluation.
-- ---------------------------------------------------------------------------
drop policy if exists users_read on users;
create policy users_read on users for select
  using ((select auth.uid()) is not null);

drop policy if exists users_admin_write on users;
create policy users_admin_write on users for all
  using ((select current_user_role()) = 'admin')
  with check ((select current_user_role()) = 'admin');

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
drop policy if exists accounts_read on accounts;
create policy accounts_read on accounts for select
  using (owner_id in (select visible_user_ids()));

drop policy if exists accounts_insert on accounts;
create policy accounts_insert on accounts for insert
  with check (owner_id in (select visible_user_ids()));

-- Both USING and WITH CHECK are required. USING decides which rows you may
-- update; WITH CHECK decides what the row is allowed to look like afterwards.
-- Without WITH CHECK a manager could update a team account and set owner_id to
-- someone outside their tree, making the row invisible to themselves and
-- everyone above them.
drop policy if exists accounts_update on accounts;
create policy accounts_update on accounts for update
  using (owner_id in (select visible_user_ids()))
  with check (owner_id in (select visible_user_ids()));

drop policy if exists accounts_delete on accounts;
create policy accounts_delete on accounts for delete
  using ((select current_user_role()) = 'admin');

-- ---------------------------------------------------------------------------
-- contacts / opportunities / activities
--
-- These inherit visibility from their parent account rather than restating the
-- org chart rule. One source of truth: change the sharing model in one place
-- and every child object follows.
--
-- EXISTS with a correlated key, not `account_id in (select id from accounts)`.
-- The IN form materialises every visible account before filtering; EXISTS lets
-- the planner probe the accounts primary key once per candidate row.
-- ---------------------------------------------------------------------------
drop policy if exists contacts_rw on contacts;
create policy contacts_rw on contacts for all
  using      (exists (select 1 from accounts a where a.id = contacts.account_id))
  with check (exists (select 1 from accounts a where a.id = contacts.account_id));

drop policy if exists opportunities_rw on opportunities;
create policy opportunities_rw on opportunities for all
  using      (exists (select 1 from accounts a where a.id = opportunities.account_id))
  with check (exists (select 1 from accounts a where a.id = opportunities.account_id));

-- Activities are read-only to the application. They are written by the webhook
-- worker under the service role, or by an explicit resolve action. Letting reps
-- hand-edit a call record would destroy the audit story the whole pipeline
-- exists to provide.
drop policy if exists activities_read on activities;
create policy activities_read on activities for select
  using (
    exists (select 1 from accounts a where a.id = activities.account_id)
    or (activities.account_id is null and activities.user_id in (select visible_user_ids()))
  );

-- Manually logged notes and meetings are the one thing a user may add.
drop policy if exists activities_insert_manual on activities;
create policy activities_insert_manual on activities for insert
  with check (
    source = 'manual'
    and exists (select 1 from accounts a where a.id = activities.account_id)
  );

-- ---------------------------------------------------------------------------
-- unmatched_activities -- the review queue
-- Unmatched calls have not been attributed to an account yet, so there is no
-- ownership to filter on. Managers and admins triage them.
-- ---------------------------------------------------------------------------
drop policy if exists unmatched_read on unmatched_activities;
create policy unmatched_read on unmatched_activities for select
  using ((select current_user_role()) in ('manager','admin'));

drop policy if exists unmatched_resolve on unmatched_activities;
create policy unmatched_resolve on unmatched_activities for update
  using ((select current_user_role()) in ('manager','admin'))
  with check ((select current_user_role()) in ('manager','admin'));

-- ---------------------------------------------------------------------------
-- Configuration tables
-- Everyone reads them (forms and the qualifier need them); admins change them.
-- ---------------------------------------------------------------------------
drop policy if exists field_defs_read on field_defs;
create policy field_defs_read on field_defs for select
  using ((select auth.uid()) is not null);

drop policy if exists field_defs_admin on field_defs;
create policy field_defs_admin on field_defs for all
  using ((select current_user_role()) = 'admin')
  with check ((select current_user_role()) = 'admin');

drop policy if exists qualification_rules_read on qualification_rules;
create policy qualification_rules_read on qualification_rules for select
  using ((select auth.uid()) is not null);

drop policy if exists qualification_rules_admin on qualification_rules;
create policy qualification_rules_admin on qualification_rules for all
  using ((select current_user_role()) = 'admin')
  with check ((select current_user_role()) = 'admin');

-- saved_views: your own, plus anything explicitly shared.
drop policy if exists saved_views_read on saved_views;
create policy saved_views_read on saved_views for select
  using (shared or owner_id = (select current_user_id()));

drop policy if exists saved_views_write on saved_views;
create policy saved_views_write on saved_views for all
  using (owner_id = (select current_user_id()))
  with check (owner_id = (select current_user_id()));

-- raw_events: no policies at all. RLS is enabled and nothing grants access, so
-- the table is invisible to every user-facing connection. Only the service role
-- touches it. Raw provider payloads can contain phone numbers and recording
-- URLs that have no business being on a rep's screen.

-- ===========================================================================
-- Column-level protection: who owns an account
--
-- RLS grants or denies whole rows; it cannot say "you may edit this row but not
-- this column". A trigger can.
-- ===========================================================================
create or replace function enforce_owner_reassignment() returns trigger as $$
declare
  actor uuid;
begin
  if new.owner_id is not distinct from old.owner_id then
    return new;   -- ownership unchanged, nothing to police
  end if;

  actor := current_user_id();

  -- No auth context means this is the service role, a migration, or the seed
  -- script. Those are trusted paths and are allowed through.
  if actor is null then
    return new;
  end if;

  if (select role from users where id = actor) = 'admin' then
    return new;
  end if;

  raise exception 'Account ownership can only be changed by an admin'
    using errcode = '42501';
end $$ language plpgsql security definer set search_path = public, auth;

drop trigger if exists t_accounts_owner_guard on accounts;
create trigger t_accounts_owner_guard before update of owner_id on accounts
  for each row execute function enforce_owner_reassignment();
