-- 0005_lifecycle_rls.sql
--
-- Permissions for the ownership model.
--
-- The sharing model, restated now that the available pool exists:
--
--   * A broker sees the accounts they own, plus EVERY unowned account. The pool
--     has to be browsable or nobody can claim from it.
--   * A manager sees their own, their team's, and the pool.
--   * Credit and admin see everything.
--   * A broker can claim an unowned account and can give up one of their own.
--     Taking an account somebody else holds is refused by the trigger in 0004 --
--     that refusal is the entire mechanic, so it lives in the database rather
--     than in a button's disabled state.

-- ---------------------------------------------------------------------------
-- Credit joins admin in seeing everything.
--
-- Alex's decision, and worth writing down plainly: credit assesses risk across
-- the whole book, so ownership must not limit them.
-- ---------------------------------------------------------------------------
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
  select u.id from users u where (select role from me) in ('admin','credit')
$$ language sql stable security definer set search_path = public, auth;

create or replace function is_privileged() returns boolean as $$
  select coalesce((select role from users where auth_id = (select auth.uid())) in ('admin','credit'), false)
$$ language sql stable security definer set search_path = public, auth;

-- ---------------------------------------------------------------------------
-- accounts
-- ---------------------------------------------------------------------------
drop policy if exists accounts_read on accounts;
create policy accounts_read on accounts for select
  using (
    -- The available pool: unowned, and visible to everyone signed in.
    owner_id is null
    or owner_id in (select visible_user_ids())
  );

drop policy if exists accounts_insert on accounts;
create policy accounts_insert on accounts for insert
  with check (owner_id is null or owner_id in (select visible_user_ids()));

-- USING covers which rows may be touched -- including unowned ones, which is
-- what makes claiming possible. WITH CHECK covers what the row may become:
-- null (released) or someone you can already see. Without the null case a
-- broker could not give an account back.
drop policy if exists accounts_update on accounts;
create policy accounts_update on accounts for update
  using (owner_id is null or owner_id in (select visible_user_ids()))
  with check (owner_id is null or owner_id in (select visible_user_ids()));

drop policy if exists accounts_delete on accounts;
create policy accounts_delete on accounts for delete
  using ((select is_privileged()));

-- ---------------------------------------------------------------------------
-- account_claims -- the audit trail
--
-- Readable by everyone signed in. Who used to hold an account is exactly the
-- question a territory argument turns on, and hiding it helps nobody. Writes
-- happen only through the trigger in 0004, so there is no write policy at all.
-- ---------------------------------------------------------------------------
alter table account_claims enable row level security;

drop policy if exists account_claims_read on account_claims;
create policy account_claims_read on account_claims for select
  using ((select auth.uid()) is not null);

-- ---------------------------------------------------------------------------
-- account_retention_rules
-- Everyone reads them -- a broker needs to know how long they have. Admin and
-- credit change them.
-- ---------------------------------------------------------------------------
alter table account_retention_rules enable row level security;

drop policy if exists retention_read on account_retention_rules;
create policy retention_read on account_retention_rules for select
  using ((select auth.uid()) is not null);

drop policy if exists retention_write on account_retention_rules;
create policy retention_write on account_retention_rules for all
  using ((select is_privileged()))
  with check ((select is_privileged()));

-- ---------------------------------------------------------------------------
-- Bring the other tables in line with credit's access.
-- ---------------------------------------------------------------------------
drop policy if exists unmatched_read on unmatched_activities;
create policy unmatched_read on unmatched_activities for select
  using ((select current_user_role()) in ('manager','credit','admin'));

drop policy if exists unmatched_resolve on unmatched_activities;
create policy unmatched_resolve on unmatched_activities for update
  using ((select current_user_role()) in ('manager','credit','admin'))
  with check ((select current_user_role()) in ('manager','credit','admin'));

drop policy if exists users_admin_write on users;
create policy users_admin_write on users for all
  using ((select is_privileged()))
  with check ((select is_privileged()));

drop policy if exists field_defs_admin on field_defs;
create policy field_defs_admin on field_defs for all
  using ((select is_privileged()))
  with check ((select is_privileged()));

drop policy if exists qualification_rules_admin on qualification_rules;
create policy qualification_rules_admin on qualification_rules for all
  using ((select is_privileged()))
  with check ((select is_privileged()));
