-- 0029_prospects.sql
--
-- Prospects: every company in the business, in one list.
--
-- ===========================================================================
-- THE ASK, IN ALEX'S WORDS
--
--   "In salesforce there are two primary tabs. Prospects / Customers. I want
--    all accounts in the system customer or not to be visible under prospects.
--    Under customers I would like it to be changed to, Your customers.
--    We want the available accounts to be found under prospects through search.
--    We want taken accounts to be found there too. It needs to be easy for
--    someone to find and identify taken accounts so people do not step on each
--    others toes."
--
-- WHY THIS COULD NOT BE DONE ON THE ACCOUNTS SCREEN AS IT STOOD
--
-- That screen reads accounts_with_state, a security_invoker view. Row level
-- security filters it, so it can only ever contain accounts the caller may
-- OPEN. A broker searching it for a company a colleague holds gets nothing --
-- not "held by Dana", nothing -- which reads as "we have never heard of them"
-- and is precisely how two brokers end up calling the same buyer.
--
-- The directory in 0024 answered that, but as a SEPARATE screen with a thinner
-- row. Two lists means two searches, and the one people actually use is the one
-- in the nav they clicked first.
--
-- So: one list. Every account, held or not, customer or not. The lock moves
-- from WHICH ROWS COME BACK to WHICH COLUMNS ARE FILLED IN.
--
-- WHAT EVERY ROW CARRIES, WHOEVER HOLDS IT
--
--   name, street, city, state, postcode, country, industry,
--   the owner's name, the account director's name,
--   whether it is unclaimed, and whether the caller may open it.
--
-- WHAT ONLY AN OPENABLE ROW CARRIES
--
--   status, stage, phone, website, credit limit, credit status,
--   last activity, last contact, contact count, child count, parent name,
--   the clock state and the days left on it.
--
-- Those are somebody's WORK. Alex: "The info is proprietary to whomever its in
-- the name of." A locked row gets NULL in every one of them -- not a redacted
-- string, not a zero. Null is the only value that cannot be mistaken for a
-- reading.
--
-- WHY SECURITY DEFINER, AND WHAT THAT COSTS
--
-- It reads past the caller's own row level security by design, so the column
-- list below IS the security boundary. That is why every restricted field is
-- written out with its own `case when open` rather than the table being joined
-- and starred -- a `select *` here would silently start leaking whatever column
-- the next migration adds. account-locks.test.ts asserts, for every role and
-- every account, that a locked row comes back with those columns null.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Searching that finds things.
--
-- The directory's search was `name ilike %term%` OR city OR state. Three
-- separate problems with that, all of which read to the person typing as "we
-- do not have this company":
--
--   * Its own placeholder offered to search INDUSTRY, and the query did not.
--   * Punctuation had to be typed exactly. "Smith & Sons, Inc." was not found
--     by "smith and sons inc", and neither was found by the other.
--   * Two words never worked. "charlotte logistics" was one string tested
--     against one column at a time, so it matched nothing at all unless a
--     company was literally called that.
--
-- The fix is a normalised haystack -- everything about a company folded into
-- one lowercase string with punctuation flattened to spaces -- and a term
-- split into words where EVERY word must appear SOMEWHERE. That makes
-- "charlotte logistics" find Carolina Logistics of Charlotte, and makes the
-- ampersand, the comma and the full stop stop mattering.
--
-- The phone number is in the haystack and is NOT in a locked row's output. A
-- company's switchboard number is public information -- it is on their website
-- -- so being able to type it and learn "that is Acme Foods, Dana holds it"
-- gives away nothing and stops a cold call landing on a colleague's account.
-- Contacts are not in here at all, at any privilege level; see 0031.
-- ---------------------------------------------------------------------------
create or replace function prospect_haystack(
  p_name text, p_city text, p_state text, p_street text,
  p_industry text, p_website text, p_phone text
) returns text as $$
  select lower(regexp_replace(
    concat_ws(' ',
      coalesce(p_name, ''), coalesce(p_city, ''), coalesce(p_state, ''),
      coalesce(p_street, ''), coalesce(p_industry, ''),
      coalesce(p_website, ''), coalesce(p_phone, '')
    ),
    '[^a-zA-Z0-9]+', ' ', 'g'))
$$ language sql immutable;

/**
 * Does this haystack contain every word of the search?
 *
 * AND across words, OR across fields -- the way anybody who has used a search
 * box expects. An empty search matches everything rather than nothing, because
 * a cleared search box means "show me the list", not "show me nothing".
 */
create or replace function prospect_matches(p_haystack text, p_search text)
returns boolean as $$
  select coalesce(bool_and(position(w in p_haystack) > 0), true)
    from unnest(
      string_to_array(
        trim(regexp_replace(lower(coalesce(p_search, '')), '[^a-zA-Z0-9]+', ' ', 'g')),
        ' ')
    ) as w
   where w <> ''
$$ language sql immutable;

-- ---------------------------------------------------------------------------
-- The list.
-- ---------------------------------------------------------------------------
drop function if exists prospect_list(text, text, text, text, text, text, int, int);

create function prospect_list(
  p_search text default '',
  -- all | available | mine | held | customers
  p_scope text default 'all',
  p_state text default '',
  p_industry text default '',
  p_status text default '',
  -- relevance | name | urgency | recent
  p_sort text default 'relevance',
  p_limit int default 100,
  p_offset int default 0
) returns table (
  -- Always present, whoever holds it.
  id uuid,
  name text,
  billing_street text,
  billing_city text,
  billing_state text,
  billing_postal_code text,
  billing_country text,
  industry text,
  owner_id uuid,
  owner_name text,
  ad_owner_id uuid,
  ad_owner_name text,
  available boolean,
  can_open boolean,
  national_account boolean,
  -- A flagged duplicate is openable by everybody on purpose (0016), so the
  -- flag itself is not restricted -- it is the reason the row is open.
  locked_to_credit boolean,
  -- Null unless can_open. See the header.
  status text,
  stage text,
  phone_e164 text,
  website text,
  credit_limit numeric,
  credit_status text,
  last_activity_at timestamptz,
  last_communicated_at timestamptz,
  contact_count bigint,
  child_count bigint,
  parent_account_name text,
  lifecycle_state text,
  days_left int,
  total_rows bigint
) as $$
  with base as (
    select
      a.id, a.name,
      a.billing_street, a.billing_city, a.billing_state,
      a.billing_postal_code, a.billing_country, a.industry,
      a.owner_id, o.full_name as owner_name,
      a.ad_owner_id, d.full_name as ad_owner_name,
      (a.owner_id is null) as available,
      account_is_open(a.owner_id, a.ad_owner_id, a.locked_to_credit) as can_open,
      a.national_account, a.locked_to_credit,
      a.status, a.stage, a.phone_e164, a.website,
      a.credit_limit, a.credit_status,
      a.last_activity_at, a.claimed_at, a.retention_override_until,
      a.parent_account_id, p.name as parent_account_name,
      prospect_haystack(a.name, a.billing_city, a.billing_state, a.billing_street,
                        a.industry, a.website, a.phone_e164) as haystack
      from accounts a
      left join users o on o.id = a.owner_id
      left join users d on d.id = a.ad_owner_id
      left join accounts p on p.id = a.parent_account_id
      /*
       * SIGNED IN, OR NOTHING.
       *
       * Definer rights plus the anon grant PostgREST requires means an
       * unauthenticated caller holding the publishable key would otherwise
       * enumerate every company in the business. That key ships in the browser
       * bundle on purpose; anything that treats it as a secret is not safe.
       */
     where (select current_user_id()) is not null
  ),
  matched as (
    select b.*,
           -- Ranked, so the thing somebody typed the name of is first rather
           -- than alphabetically fourteenth.
           case
             when coalesce(p_search, '') = '' then 3
             when lower(b.name) = lower(trim(p_search)) then 0
             when lower(b.name) like lower(trim(p_search)) || '%' then 1
             when position(lower(trim(p_search)) in lower(b.name)) > 0 then 2
             else 3
           end as rank
      from base b
     where prospect_matches(b.haystack, p_search)
       and (coalesce(p_state, '') = '' or upper(b.billing_state) = upper(p_state))
       and (coalesce(p_industry, '') = '' or b.industry = p_industry)
       -- A status filter can only mean anything for a row whose status the
       -- caller may read. Applying it to locked rows would silently drop them
       -- from a list whose whole purpose is that they appear in it.
       and (coalesce(p_status, '') = '' or (b.can_open and b.status = p_status))
       and (
         case coalesce(p_scope, 'all')
           when 'available' then b.owner_id is null
           when 'mine'      then b.owner_id = (select current_user_id())
                                or b.ad_owner_id = (select current_user_id())
           when 'held'      then not b.can_open
           when 'customers' then (b.owner_id = (select current_user_id())
                                  or b.ad_owner_id = (select current_user_id()))
                                 and b.status = 'customer'
           else true
         end
       )
  ),
  counted as (
    select m.*, count(*) over () as total_rows from matched m
  )
  select
    c.id, c.name,
    c.billing_street, c.billing_city, c.billing_state,
    c.billing_postal_code, c.billing_country, c.industry,
    c.owner_id, c.owner_name, c.ad_owner_id, c.ad_owner_name,
    c.available, c.can_open, c.national_account, c.locked_to_credit,
    -- Everything below this line is somebody's work.
    case when c.can_open then c.status end,
    case when c.can_open then c.stage end,
    case when c.can_open then c.phone_e164 end,
    case when c.can_open then c.website end,
    case when c.can_open then c.credit_limit end,
    case when c.can_open then c.credit_status end,
    case when c.can_open then c.last_activity_at end,
    case when c.can_open then
      (select max(x.occurred_at) from activities x where x.account_id = c.id) end,
    case when c.can_open then
      (select count(*) from contacts ct where ct.account_id = c.id) end,
    case when c.can_open then
      (select count(*) from accounts ch where ch.parent_account_id = c.id) end,
    case when c.can_open then c.parent_account_name end,
    case when c.can_open then
      account_state(c.owner_id, c.status, c.last_activity_at, c.claimed_at,
                    c.retention_override_until) end,
    case when c.can_open then
      account_days_left(c.owner_id, c.status, c.last_activity_at, c.claimed_at,
                        c.retention_override_until) end,
    c.total_rows
    from counted c
   order by
     case coalesce(p_sort, 'relevance')
       -- Locked rows carry no clock and no activity date, so under those two
       -- sorts they go to the bottom as a group rather than scattering through
       -- the list wherever null happens to fall.
       when 'urgency' then case when c.can_open then 0 else 1 end
       when 'recent'  then case when c.can_open then 0 else 1 end
       else 0
     end,
     case when coalesce(p_sort, 'relevance') = 'relevance' then c.rank end,
     case when coalesce(p_sort, 'relevance') = 'relevance' and coalesce(p_search, '') = ''
          then (case when c.can_open then 0 else 1 end) end,
     case when coalesce(p_sort, 'relevance') = 'urgency' then
       case account_state(c.owner_id, c.status, c.last_activity_at, c.claimed_at,
                          c.retention_override_until)
         when 'overdue' then 0 when 'expiring' then 1 when 'warning' then 2
         when 'fresh' then 3 when 'protected' then 4 when 'available' then 5
         else 6 end
     end,
     case when coalesce(p_sort, 'relevance') = 'recent' then c.last_activity_at end desc nulls last,
     c.name
   limit greatest(1, least(coalesce(p_limit, 100), 200))
  offset greatest(0, coalesce(p_offset, 0))
$$ language sql stable security definer set search_path = public, auth;

comment on function prospect_list(text, text, text, text, text, text, int, int) is
  'Every company in the business, held or not. Rows the caller may not open '
  'come back with status, stage, phone, website, credit, activity, contacts '
  'and the clock set to null -- see 0029 for the reasoning.';

/**
 * The counts on the tabs.
 *
 * One pass over the accounts table rather than five list calls, and it respects
 * the search box so the numbers describe what is actually on screen. A tab
 * reading "Held by others 412" over a filtered list showing three is a tab
 * nobody trusts twice.
 */
drop function if exists prospect_counts(text, text, text, text);

create function prospect_counts(
  p_search text default '',
  p_state text default '',
  p_industry text default '',
  p_status text default ''
) returns table (
  total bigint,
  available bigint,
  mine bigint,
  held bigint,
  customers bigint
) as $$
  with flags as (
    select
      account_is_open(a.owner_id, a.ad_owner_id, a.locked_to_credit) as can_open,
      (a.owner_id is null) as available,
      coalesce(a.owner_id = (select current_user_id())
               or a.ad_owner_id = (select current_user_id()), false) as is_mine,
      a.status
      from accounts a
     where (select current_user_id()) is not null
       and prospect_matches(
             prospect_haystack(a.name, a.billing_city, a.billing_state,
                               a.billing_street, a.industry, a.website, a.phone_e164),
             p_search)
       and (coalesce(p_state, '') = '' or upper(a.billing_state) = upper(p_state))
       and (coalesce(p_industry, '') = '' or a.industry = p_industry)
       and (
         coalesce(p_status, '') = ''
         or (account_is_open(a.owner_id, a.ad_owner_id, a.locked_to_credit)
             and a.status = p_status)
       )
  )
  select
    count(*),
    count(*) filter (where available),
    count(*) filter (where is_mine),
    count(*) filter (where not can_open),
    count(*) filter (where is_mine and status = 'customer')
    from flags
$$ language sql stable security definer set search_path = public, auth;

/**
 * The industries actually present, for the filter menu.
 *
 * Reads every account rather than the caller's visible ones, because this list
 * sits above a list that shows every account. A menu offering only the
 * industries in your own book, above results drawn from the whole business, is
 * a menu that hides rows and looks broken doing it.
 */
create or replace function prospect_industries()
returns table (industry text, uses bigint) as $$
  select a.industry, count(*)
    from accounts a
   where (select current_user_id()) is not null
     and a.industry is not null and a.industry <> ''
   group by a.industry
   order by count(*) desc, a.industry
   limit 200
$$ language sql stable security definer set search_path = public, auth;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function prospect_haystack(text, text, text, text, text, text, text) to %I', r);
      execute format('grant execute on function prospect_matches(text, text) to %I', r);
      execute format('grant execute on function prospect_list(text, text, text, text, text, text, int, int) to %I', r);
      execute format('grant execute on function prospect_counts(text, text, text, text) to %I', r);
      execute format('grant execute on function prospect_industries() to %I', r);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- The directory search gets the same treatment.
--
-- 0024's version searched name, city and state with a single ilike and offered
-- industry in its placeholder without ever searching it. Same function, same
-- signature, same columns -- only the WHERE clause changes, so nothing that
-- calls it needs to know.
-- ---------------------------------------------------------------------------
drop function if exists account_directory(text, text, text, int, int);

create function account_directory(
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
  industry text,
  owner_id uuid,
  owner_name text,
  ad_owner_id uuid,
  ad_owner_name text,
  available boolean,
  can_open boolean,
  total_rows bigint
) as $$
  with matched as (
    select
      a.id, a.name,
      a.billing_street, a.billing_city, a.billing_state,
      a.billing_postal_code, a.billing_country, a.industry,
      a.owner_id, o.full_name as owner_name,
      a.ad_owner_id, d.full_name as ad_owner_name,
      (a.owner_id is null) as available,
      account_is_open(a.owner_id, a.ad_owner_id, a.locked_to_credit) as can_open
      from accounts a
      left join users o on o.id = a.owner_id
      left join users d on d.id = a.ad_owner_id
     where prospect_matches(
             prospect_haystack(a.name, a.billing_city, a.billing_state,
                               a.billing_street, a.industry, a.website, a.phone_e164),
             p_search)
       and (coalesce(p_state, '') = '' or upper(a.billing_state) = upper(p_state))
       and (
        p_scope <> 'locked'
        or not account_is_open(a.owner_id, a.ad_owner_id, a.locked_to_credit)
       )
       and (p_scope <> 'available' or a.owner_id is null)
       and (select current_user_id()) is not null
  )
  select m.*, (select count(*) from matched) as total_rows
    from matched m
   order by m.can_open desc, m.available desc, m.name
   limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0))
$$ language sql stable security definer set search_path = public, auth;

comment on function account_directory(text, text, text, int, int) is
  'Name, address, industry and holder for every company, regardless of who '
  'holds it. Deliberately excludes contacts, activity, credit, stage and '
  'custom fields -- see 0024 for the reasoning.';

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function account_directory(text, text, text, int, int) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
