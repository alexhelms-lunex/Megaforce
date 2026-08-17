-- 0031_rows_per_page.sql
--
-- How many rows a person wants to see, and where they want to land.
--
-- ===========================================================================
--   "When loading accounts or available accounts or any capacity of account we
--    want to render 100. But a toggle for brokers to render less down to 10 all
--    the way up to 200 should be available per the users discretion."
--
-- WHY THIS IS A STORED PREFERENCE AND NOT JUST A URL PARAMETER
--
-- It is both. The URL carries it so a filtered list can be pasted to a
-- colleague and arrive looking the same, and the preference carries it so
-- somebody who wants 200 rows gets 200 rows tomorrow morning without setting it
-- again. A setting that resets every time somebody clicks a nav link is a
-- setting people stop touching.
--
-- The ceiling is 200 in the database as well as in the menu. prospect_list caps
-- its own limit, so a hand-edited URL asking for 50,000 gets 200 -- the cap is
-- not the dropdown's good manners.
-- ===========================================================================

alter table user_preferences
  add column if not exists rows_per_page int not null default 100;

-- Named so the constraint failure reads as the rule rather than as a number.
alter table user_preferences drop constraint if exists user_preferences_rows_per_page_check;
alter table user_preferences add constraint user_preferences_rows_per_page_check
  check (rows_per_page in (10, 25, 50, 100, 200));

/*
 * Where signing in lands you.
 *
 * The original check listed the five screens that existed at the time. Adding
 * a screen to the nav without adding it here means the Settings dropdown offers
 * a landing page that cannot be saved -- the write fails on a constraint and
 * the toggle silently snaps back, which reads as a broken form rather than as a
 * missing migration.
 */
alter table user_preferences drop constraint if exists user_preferences_default_landing_check;
alter table user_preferences add constraint user_preferences_default_landing_check
  check (default_landing in ('/','/prospects','/customers','/accounts','/activity','/me','/reports'));

-- ===========================================================================
-- Removing my_preferences(), which was a tripwire under this table.
--
-- 0016 defined it as:
--
--     returns user_preferences as $$
--       select coalesce(
--         (select p from user_preferences p where p.user_id = ...),
--         (select row(<thirteen values written out by hand>)::user_preferences)
--       )
--
-- A table's composite type has exactly as many fields as the table has
-- columns, so adding rows_per_page above turned that hand-written row from
-- thirteen fields into a thirteen-field row being cast to a fourteen-field
-- type. Postgres refuses with "cannot cast type record to user_preferences"
-- and setup stops -- at 0016, naming a file that has not changed in weeks,
-- rather than at the migration that actually caused it. That is exactly the
-- failure it produced, and only the double-run in setup/run.test.ts caught it.
--
-- The function has NEVER been called. Not by the application, not by another
-- migration, not by a policy -- its whole effect on this project has been to
-- lie in wait for the next column. The application reads the row through
-- PostgREST and merges it over DEFAULT_PREFERENCES in TypeScript, which does
-- the same job and does not care how many columns there are.
--
-- So it goes. If a SQL-side reader is ever wanted, it should return jsonb and
-- let the caller merge, for the same reason: a shape that cannot go stale.
-- ===========================================================================
drop function if exists my_preferences();

notify pgrst, 'reload schema';
