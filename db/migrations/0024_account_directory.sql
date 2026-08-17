-- 0024_account_directory.sql
--
-- Everyone can find any company. Only its holder can open it.
--
-- ===========================================================================
-- THE RULE, IN ALEX'S WORDS
--
--   "If I am a broker and I have an account in my name, no one can open up the
--    info within the account. They can still search it up and see the basic
--    address and name of the account plus owner/owners. But no other info.
--    The info is proprietary to whomever its in the name of."
--
-- THE HALF THAT ALREADY WORKED
--
-- Row level security already refuses a broker their colleague's account row,
-- and every child table -- contacts, activities, opportunities -- is gated by an
-- EXISTS against that same row. So the contact list, the call history, the
-- notes, the credit limit and the custom fields were all already sealed. That
-- part needed nothing.
--
-- THE HALF THAT DID NOT
--
-- A colleague's account was not merely closed, it was INVISIBLE. It did not
-- appear in search, so two brokers could work the same company for a month
-- without either discovering the other, and the second one to try claiming it
-- was told it did not exist.
--
-- That is worse than the sharing rule requires and worse for the business than
-- showing it. A broker needs to be able to type a company name and learn one
-- thing: is this mine to chase, or is it already somebody's? Answering that
-- costs nothing proprietary -- the name and address came from outside the
-- company, and the holder's name is on every screen in the application already.
--
-- WHAT THIS EXPOSES, EXACTLY
--
--   name, street, city, state, postal code, country,
--   the owner's name, the account director's name,
--   and whether it is unclaimed.
--
-- WHAT IT DOES NOT, AND MUST NOT
--
--   contacts, activities, notes, phone numbers, email addresses, the domain,
--   the industry, the pipeline stage, the credit limit, the custom fields,
--   the clock, the request history.
--
-- Those are the work somebody did. They stay with whoever did it.
--
-- WHY A SECURITY DEFINER FUNCTION
--
-- It has to read past the caller's own row level security, so it runs as its
-- owner. That makes the column list below the entire security boundary, which
-- is why it is written out one field at a time rather than as SELECT * -- a
-- star here would silently start leaking any column a later migration adds.
-- ===========================================================================

/**
 * Can this caller open the account, or only see it in the directory?
 *
 * Mirrors accounts_read from 0016 and 0021 clause for clause, deliberately.
 * Two different answers to "may I see this" is how a screen ends up saying
 * "locked" over an account that opens perfectly, or offering an Open button
 * that 404s. account-locks.test.ts asserts the two agree for every account and
 * every role.
 */
create or replace function account_is_open(
  p_owner_id uuid,
  p_ad_owner_id uuid,
  p_locked_to_credit boolean
) returns boolean as $$
  select
    -- The available pool. Unclaimed means unowned means everybody's to read.
    p_owner_id is null
    -- Your own book, and everyone reporting to you, however far down.
    or p_owner_id in (select visible_user_ids())
    -- An account director sees the national accounts they co-own, even though
    -- the broker running it is nowhere near their reporting line.
    or (p_ad_owner_id is not null and p_ad_owner_id = (select current_user_id()))
    -- Credit and admin are outside the hierarchy on purpose.
    or (select is_privileged())
    -- A flagged duplicate is visible to everybody, which 0016 argues at length:
    -- an invisible one gets typed in again next week by a third person.
    or coalesce(p_locked_to_credit, false)
$$ language sql stable security definer set search_path = public, auth;

/**
 * Every company in the business, as a directory entry.
 *
 * Search covers name, city and state, because those are the three things
 * somebody has in front of them when they want to know whether a company is
 * already taken.
 */
create or replace function account_directory(
  p_search text default '',
  p_state text default '',
  p_scope text default 'all',
  p_limit int default 50,
  p_offset int default 0
) returns table (
  id uuid,
  name text,
  billing_street text,
  billing_city text,
  billing_state text,
  billing_postal_code text,
  billing_country text,
  owner_id uuid,
  owner_name text,
  ad_owner_id uuid,
  ad_owner_name text,
  available boolean,
  can_open boolean,
  total_rows bigint
) as $$
  with visible as (select id from visible_user_ids() as id),
  matched as (
    select
      a.id, a.name,
      a.billing_street, a.billing_city, a.billing_state,
      a.billing_postal_code, a.billing_country,
      a.owner_id, o.full_name as owner_name,
      a.ad_owner_id, d.full_name as ad_owner_name,
      (a.owner_id is null) as available,
      account_is_open(a.owner_id, a.ad_owner_id, a.locked_to_credit) as can_open
      from accounts a
      left join users o on o.id = a.owner_id
      left join users d on d.id = a.ad_owner_id
     where (
        coalesce(p_search, '') = ''
        or a.name ilike '%' || p_search || '%'
        or a.billing_city ilike '%' || p_search || '%'
        or a.billing_state ilike '%' || p_search || '%'
      )
       and (coalesce(p_state, '') = '' or a.billing_state = p_state)
       and (
        p_scope <> 'locked'
        or not account_is_open(a.owner_id, a.ad_owner_id, a.locked_to_credit)
       )
       and (p_scope <> 'available' or a.owner_id is null)
  )
  select m.*, (select count(*) from matched) as total_rows
    from matched m
   order by
     -- Anything the caller can actually work comes first. A directory whose
     -- first page is entirely other people's accounts is a directory nobody
     -- scrolls past page one of.
     m.can_open desc, m.available desc, m.name
   limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0))
$$ language sql stable security definer set search_path = public, auth;

comment on function account_directory(text, text, text, int, int) is
  'Name, address and holder for every company, regardless of who holds it. '
  'Deliberately excludes contacts, activity, credit, industry, stage and custom '
  'fields -- see 0024 for the reasoning.';

/**
 * One directory entry, for the screen somebody lands on after a search.
 *
 * Separate from the list rather than a filter on it, because the account page
 * asks a different question -- "what may I tell them about THIS one" -- and
 * because a list function called with a limit of one is a query nobody reading
 * the page can follow.
 */
create or replace function account_directory_one(p_id uuid)
returns table (
  id uuid,
  name text,
  billing_street text,
  billing_city text,
  billing_state text,
  billing_postal_code text,
  billing_country text,
  owner_id uuid,
  owner_name text,
  ad_owner_id uuid,
  ad_owner_name text,
  available boolean,
  can_open boolean,
  /** How long they have held it. Not the clock -- just the date. */
  held_since timestamptz
) as $$
  select
    a.id, a.name,
    a.billing_street, a.billing_city, a.billing_state,
    a.billing_postal_code, a.billing_country,
    a.owner_id, o.full_name,
    a.ad_owner_id, d.full_name,
    (a.owner_id is null),
    account_is_open(a.owner_id, a.ad_owner_id, a.locked_to_credit),
    a.claimed_at
    from accounts a
    left join users o on o.id = a.owner_id
    left join users d on d.id = a.ad_owner_id
   where a.id = p_id
$$ language sql stable security definer set search_path = public, auth;

/**
 * How many companies are in each bucket for this caller.
 *
 * Drives the counts on the tabs, and exists so the list screen does not have to
 * fetch three pages to label three tabs.
 */
create or replace function account_directory_counts()
returns table (mine bigint, locked bigint, available bigint, total bigint) as $$
  with flags as (
    select
      account_is_open(a.owner_id, a.ad_owner_id, a.locked_to_credit) as can_open,
      (a.owner_id is null) as available
      from accounts a
  )
  select
    count(*) filter (where can_open and not available),
    count(*) filter (where not can_open),
    count(*) filter (where available),
    count(*)
    from flags
$$ language sql stable security definer set search_path = public, auth;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function account_is_open(uuid, uuid, boolean) to %I', r);
      execute format('grant execute on function account_directory(text, text, text, int, int) to %I', r);
      execute format('grant execute on function account_directory_one(uuid) to %I', r);
      execute format('grant execute on function account_directory_counts() to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
