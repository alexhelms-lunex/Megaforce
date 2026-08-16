-- 0009_company_data.sql
--
-- Everything the Salesforce account record carries that this build did not:
-- a real address, the parent/child hierarchy, national-account approval, and
-- the AD who sits alongside the broker on a customer.
--
-- The address is the load-bearing part. City and state filters, the map, and
-- any territory reporting all depend on the address being STRUCTURED rather
-- than a line of text -- you cannot filter "State = NC" out of
-- "281 Clara Street, San Francisco, California 94107".
--
-- The columns are named billing_* rather than street/city/state for two
-- reasons. The plain names collide: accounts_with_state already exposes a
-- computed `state` (the lifecycle flag), and `select a.*, ... as state` fails
-- with "column state specified more than once". And billing_* is what
-- Salesforce calls them, so the eventual import maps field-for-field instead
-- of through a translation table nobody maintains.

drop view if exists accounts_with_state;

-- ---------------------------------------------------------------------------
-- Address
-- ---------------------------------------------------------------------------
alter table accounts add column if not exists billing_street      text;
alter table accounts add column if not exists billing_city        text;
alter table accounts add column if not exists billing_state       text;
alter table accounts add column if not exists billing_postal_code text;
alter table accounts add column if not exists billing_country     text default 'United States';
-- Stored when known. The map link works from the text address alone, so these
-- are an optimisation for distance work later, not a prerequisite.
alter table accounts add column if not exists billing_latitude    numeric(9,6);
alter table accounts add column if not exists billing_longitude   numeric(9,6);

alter table accounts add column if not exists phone_e164 text;
alter table accounts add column if not exists website    text;

-- Case-insensitive, because nobody types "NC" and "nc" consistently and a
-- filter that misses half the book is worse than no filter.
create index if not exists accounts_city_idx  on accounts(lower(billing_city));
create index if not exists accounts_state_idx on accounts(upper(billing_state));
create index if not exists accounts_phone_idx on accounts(phone_e164) where phone_e164 is not null;

-- ---------------------------------------------------------------------------
-- Hierarchy
--
-- Matters for credit: a parent carries the sum of its children's credit lines,
-- and when a customer goes inactive the credit is stripped from the location
-- account and every service account beneath it.
-- ---------------------------------------------------------------------------
alter table accounts add column if not exists parent_account_id uuid references accounts(id) on delete set null;
create index if not exists accounts_parent_idx on accounts(parent_account_id);

-- An account cannot be its own parent. Deeper cycles are possible in principle
-- and are caught by the depth guard in the recursive query below rather than by
-- a constraint, since Postgres cannot express "no cycles" declaratively.
alter table accounts drop constraint if exists accounts_no_self_parent;
alter table accounts add constraint accounts_no_self_parent
  check (parent_account_id is null or parent_account_id <> id);

-- ---------------------------------------------------------------------------
-- National account approval
--
-- A flag plus a review state, not a checkbox: somebody proposes an account as
-- national, and somebody else approves it.
-- ---------------------------------------------------------------------------
alter table accounts add column if not exists national_account boolean not null default false;
alter table accounts add column if not exists national_account_in_review boolean not null default false;
alter table accounts add column if not exists national_account_approved_by uuid references users(id);
alter table accounts add column if not exists national_account_approved_at timestamptz;

-- ---------------------------------------------------------------------------
-- The AD who shares a customer
--
-- A prospect has exactly one owner. A customer can carry two: if an AD set it
-- up, a broker runs it and the AD takes a percentage. Enforced here rather
-- than left to the UI, because commission depends on it.
-- ---------------------------------------------------------------------------
alter table accounts add column if not exists ad_owner_id uuid references users(id);
create index if not exists accounts_ad_owner_idx on accounts(ad_owner_id);

alter table accounts drop constraint if exists accounts_ad_owner_customers_only;
alter table accounts add constraint accounts_ad_owner_customers_only
  check (ad_owner_id is null or status = 'customer');

-- Where the owner sits, when they started, and how many prospects their tier
-- allows. The list shows location as a column; start_date and prospect_limit
-- are what the policy's per-tier caps are computed from.
alter table users add column if not exists location text;
alter table users add column if not exists start_date date;
alter table users add column if not exists prospect_limit int;

-- ---------------------------------------------------------------------------
-- Credit
--
-- Held per account. A parent's exposure is the sum of its own line and every
-- descendant's, computed rather than stored so it cannot drift.
-- ---------------------------------------------------------------------------
alter table accounts add column if not exists credit_limit numeric(14,2);
alter table accounts add column if not exists credit_status text;

alter table accounts drop constraint if exists accounts_credit_status_check;
alter table accounts add constraint accounts_credit_status_check
  check (credit_status is null or credit_status in ('none','requested','approved','on_hold','revoked'));

/**
 * Total credit exposure for an account and everything beneath it.
 *
 * Recursive because the hierarchy can be more than two deep, and guarded with
 * a depth limit: nothing stops an admin creating A -> B -> A, and an unguarded
 * recursive CTE against a cycle runs until the connection dies.
 *
 * Deliberately NOT a column on accounts_with_state. The list view reads dozens
 * of rows at a time and this would run a recursive CTE for every one of them;
 * the rollup only means anything on a parent's own page, so the detail page
 * calls it and the list does not pay for it.
 */
create or replace function account_credit_rollup(p_account_id uuid)
returns numeric as $$
  with recursive tree as (
    select id, credit_limit, 1 as depth
      from accounts where id = p_account_id
    union all
    select a.id, a.credit_limit, t.depth + 1
      from accounts a join tree t on a.parent_account_id = t.id
     where t.depth < 20
  )
  select coalesce(sum(credit_limit), 0) from tree
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- Industry becomes a controlled list
--
-- The values are those in the Salesforce picklist, so an import lands in the
-- right bucket rather than creating near-duplicate free-text values that
-- quietly split every report.
-- ---------------------------------------------------------------------------
create table if not exists industries (
  name text primary key,
  sort int not null default 0
);

insert into industries (name, sort) values
  ('Animal Feed/Products', 10), ('Appliances/Electronics', 20), ('Auto and Auto Parts', 30),
  ('Bakery', 40), ('Beauty Products', 50), ('Beverages - alcoholic', 60),
  ('Beverages - non-alcoholic', 70), ('Building Materials', 80), ('Candy/Confectionery', 90),
  ('Chemicals', 100), ('Cleaning Products', 110), ('Clothing/Apparel', 120),
  ('Construction', 130), ('Consumer Packaged Goods', 140), ('Dairy', 150),
  ('Equipment (including rental)', 160), ('Event Staging', 170),
  ('Fixtures/Supplies for Hospitality/Restaurant', 180), ('Food - Dry', 190),
  ('Food - Frozen', 200), ('Food Ingredients', 210), ('Furniture', 220),
  ('Glass', 230), ('Grocery/Retail', 240), ('HVAC', 250), ('Industrial Supplies', 260),
  ('Janitorial', 270), ('Lawn and Garden', 280), ('Lumber', 290), ('Meat/Poultry', 300),
  ('Medical', 310), ('Metal', 320), ('Nuts/Grains', 330), ('Oil/Oil Products', 340),
  ('Paper Products', 350), ('Plastics', 360), ('Produce', 370), ('Recycling', 380),
  ('Renewable Energy', 390), ('Restaurant (including QSR)', 400), ('Rubber', 410),
  ('Seafood', 420), ('Textile', 430), ('Toys', 440), ('Tubes/Pipes', 450),
  ('Vitamins/Supplements/Dietary', 460), ('TBD', 999)
on conflict (name) do nothing;

-- NOTE: the entries between "Beverages - alcoholic" and "Equipment", and
-- between "Food Ingredients" and "Lumber", were not captured in the
-- screenshots and are reconstructed. Replace them with the exact values from
-- Salesforce Setup -> Object Manager -> Account -> Industry before importing,
-- or the import will silently drop rows into TBD.

-- ---------------------------------------------------------------------------
-- Supporting index for last_communicated_at
--
-- The view takes max(occurred_at) per account. With (account_id, occurred_at)
-- that is a one-row backward index scan; without it, a sequential scan of
-- activities for every row of every account list.
-- ---------------------------------------------------------------------------
create index if not exists activities_account_occurred_desc_idx
  on activities(account_id, occurred_at desc);

-- ---------------------------------------------------------------------------
-- Rebuild the view.
-- ---------------------------------------------------------------------------
create view accounts_with_state
with (security_invoker = true) as
select
  a.*,
  account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at)     as state,
  account_days_left(a.owner_id, a.status, a.last_activity_at, a.claimed_at) as days_left,
  u.full_name                                                               as owner_name,
  u.email                                                                   as owner_email,
  u.location                                                                as owner_location,
  ad.full_name                                                              as ad_owner_name,
  p.name                                                                    as parent_account_name,
  (select count(*) from accounts c where c.parent_account_id = a.id)        as child_count,
  -- Filterable, so "companies with nobody on file" is one click. An account
  -- with no contact has no phone number, which means no inbound call can ever
  -- be matched to it -- it is invisible to the whole activity engine.
  (select count(*) from contacts c2 where c2.account_id = a.id)             as contact_count,
  case account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at)
    when 'overdue' then 0 when 'expiring' then 1 when 'warning' then 2
    when 'fresh' then 3 when 'available' then 4 else 5
  end                                                                       as urgency,
  -- The last activity of ANY kind, qualifying or not. Shown beside the clock so
  -- a broker can tell "nothing has happened here" apart from "things happened
  -- but none of them counted".
  (select max(occurred_at) from activities x where x.account_id = a.id)     as last_communicated_at
from accounts a
left join users u  on u.id = a.owner_id
left join users ad on ad.id = a.ad_owner_id
left join accounts p on p.id = a.parent_account_id;

comment on view accounts_with_state is
  'Accounts with their lifecycle state computed. Runs as the caller, so row level security applies.';

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant select on accounts_with_state to %I', r);
      execute format('grant select on industries to %I', r);
    end if;
  end loop;
end $$;

alter table industries enable row level security;
drop policy if exists industries_read on industries;
create policy industries_read on industries for select using (true);
