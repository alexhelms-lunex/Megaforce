-- 0032_signed_in_only.sql
--
-- The available pool was readable by anybody with the publishable key.
--
-- ===========================================================================
-- WHAT WAS WRONG
--
-- 0005 opened the pool to everyone signed in, and wrote the rule like this:
--
--     create policy accounts_read on accounts for select
--       using (owner_id is null or owner_id in (select visible_user_ids()));
--
-- The second half needs a session -- visible_user_ids() returns nothing
-- without one. The FIRST HALF DOES NOT. `owner_id is null` is true for every
-- unclaimed account regardless of who is asking, including nobody.
--
-- Supabase's publishable key ships in the browser bundle. That is by design and
-- it is not a secret: it authenticates as the `anon` role and row level
-- security is what stands behind it. So anyone who viewed source on the login
-- page could read the entire available pool -- every unclaimed company, its
-- address, its phone number -- and, because contacts inherit their account's
-- visibility, every CONTACT on those accounts. Names, direct lines, email
-- addresses. Without logging in.
--
-- The same shape appears in accounts_insert and accounts_update, so the pool
-- was writable too: an unauthenticated caller could create rows with a null
-- owner, or edit any unclaimed account.
--
-- HOW IT WAS FOUND
--
-- Not by reading the policy. A test asserting "a signed-out caller sees no
-- contacts" failed, and the row it saw was the control case -- a contact on an
-- unclaimed account that the test had put there to prove the policies were not
-- simply hiding everything from everybody.
--
-- 0024 had already fixed exactly this shape in account_directory, where the
-- SECURITY DEFINER function needed its own signed-in check. The same reasoning
-- applies one layer down and was not applied there at the time.
--
-- WHAT THIS DOES NOT CHANGE
--
-- Nothing about what a signed-in person sees. Every clause below gains one
-- conjunct that is true for every real session, so no broker, manager, credit
-- user or admin sees one row more or fewer than before. rls.test.ts and
-- pool.test.ts assert exactly that.
--
-- The service role is unaffected: it holds BYPASSRLS, which is how the webhook
-- worker, the seed and the migrations write at all.
-- ===========================================================================

/**
 * Is anybody there?
 *
 * A named helper rather than `(select auth.uid()) is not null` written out
 * eight times. The point is not brevity -- it is that a future policy author
 * reads `signed_in()` in the list of conditions and notices when it is missing,
 * which is not true of a bare null check buried in a boolean expression.
 *
 * STABLE and wrapped in (select ...) at every call site, so Postgres evaluates
 * it once per query as an InitPlan rather than once per row. On the activities
 * table that is the difference between a fast page and a hung one.
 */
create or replace function signed_in() returns boolean as $$
  select (select auth.uid()) is not null
$$ language sql stable security definer set search_path = public, auth;

-- ---------------------------------------------------------------------------
-- accounts -- the pool, which is where the hole was
--
-- The three bodies below are 0016's, copied verbatim and wrapped in one
-- `signed_in() and (...)`. Not 0005's, which is where the broken clause was
-- first written: 0016 widened all three for the duplicate lock -- a flagged
-- duplicate is readable by everybody, reachable by everybody so the trigger can
-- refuse them out loud, and creatable into Credit's name by a manager who is
-- nowhere near Credit in the org chart.
--
-- Rebuilding these from the version that contained the bug drops all of that,
-- and the way it fails is instructive: the duplicate guard hands the row to
-- Credit in a BEFORE trigger, so the manager's INSERT ... RETURNING then fails
-- its own WITH CHECK with "new row violates row-level security policy" --
-- pointing at a clause that is not the problem. That is exactly what happened
-- on the first attempt at this file, and duplicates.test.ts caught it.
-- ---------------------------------------------------------------------------
drop policy if exists accounts_read on accounts;
create policy accounts_read on accounts for select
  using (
    (select signed_in())
    and (
      -- The available pool: unclaimed, and visible to everyone SIGNED IN.
      owner_id is null
      or owner_id in (select visible_user_ids())
      or (select is_privileged())
      -- Flagged duplicates are visible to everyone, and that is deliberate on
      -- two counts. An UPDATE's WHERE clause is subject to the SELECT policy,
      -- so a broker who cannot read the row cannot be refused by the lock
      -- trigger either -- their edit matches zero rows, Postgres reports
      -- success, and they close the page believing they saved. And a visible
      -- "possible duplicate, held by Credit" is what stops a third person
      -- typing the same company in again next week.
      or locked_to_credit
    )
  );

drop policy if exists accounts_insert on accounts;
create policy accounts_insert on accounts for insert
  with check (
    (select signed_in())
    and (
      owner_id is null
      or owner_id in (select visible_user_ids())
      or (
        locked_to_credit
        and duplicate_of is not null
        and owner_id in (select id from users where role = 'credit')
      )
    )
  );

drop policy if exists accounts_update on accounts;
create policy accounts_update on accounts for update
  using (
    (select signed_in())
    and (
      owner_id is null
      or owner_id in (select visible_user_ids())
      -- Anyone may REACH a locked row, so enforce_credit_lock can refuse them
      -- by name. Nobody but credit and admin gets past that trigger, so this
      -- widens who receives an explanation, not who may write.
      or locked_to_credit
    )
  )
  with check (
    (select signed_in())
    and (
      owner_id is null
      or owner_id in (select visible_user_ids())
      or (
        locked_to_credit
        and duplicate_of is not null
        and owner_id in (select id from users where role = 'credit')
      )
    )
  );

/*
 * The manager policy from 0028 is restated rather than left alone.
 *
 * Permissive policies OR together, so a second policy that omits the check
 * would put the hole straight back -- and this one reads
 * `current_user_role() = 'manager'`, which is null without a session and would
 * therefore not have admitted anybody. It is restated anyway: relying on a
 * function returning null for safety means the safety disappears the day
 * somebody adds a coalesce to it.
 */
drop policy if exists accounts_read_manager on accounts;
create policy accounts_read_manager on accounts for select
  using ((select signed_in()) and (select current_user_role()) = 'manager');

-- ---------------------------------------------------------------------------
-- The child tables inherit through accounts, so they are already covered by
-- the change above. Restated only where a clause could stand on its own.
-- ---------------------------------------------------------------------------
drop policy if exists activities_read on activities;
create policy activities_read on activities for select
  using (
    (select signed_in())
    and (
      exists (select 1 from accounts a where a.id = activities.account_id)
      or (activities.account_id is null and activities.user_id in (select visible_user_ids()))
    )
  );

-- ---------------------------------------------------------------------------
-- saved_views -- a shared view was readable by anybody
--
-- `using (shared or owner_id = current_user_id())`. The first half never asked
-- who was looking. A saved view carries a filter set rather than rows, so this
-- leaked less than the pool did -- but a view named "Halvorsen Foods renewal"
-- is still somebody's pipeline, in a list, to anybody who asked.
-- ---------------------------------------------------------------------------
drop policy if exists saved_views_read on saved_views;
create policy saved_views_read on saved_views for select
  using ((select signed_in()) and (shared or owner_id = (select current_user_id())));

-- ---------------------------------------------------------------------------
-- industries -- the picklist
--
-- `using (true)`, and genuinely not sensitive: it is a list of industry names
-- with no company attached to any of them. Closed anyway, because nothing
-- outside a signed-in form has ever read it and an open policy in the list is
-- one a reader has to stop and think about every time.
-- ---------------------------------------------------------------------------
drop policy if exists industries_read on industries;
create policy industries_read on industries for select
  using ((select signed_in()));

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function signed_in() to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
