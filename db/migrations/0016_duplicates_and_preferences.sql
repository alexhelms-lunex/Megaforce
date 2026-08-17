-- 0016_duplicates_and_preferences.sql
--
-- Two unrelated things that both belong in the database rather than in a form.

-- ===========================================================================
-- PART ONE: the duplicate guard
--
-- "Bar anyone but Customer Credit or management from creating an account with a
-- duplicate name, address, or primary phone. If a duplicate is created it must
-- be flagged into Customer Credit's name, and only they can change it or hand
-- it to a broker."
--
-- Enforced by a trigger, not by the create form. A rule about who owns which
-- company is exactly the rule people find ways around, and there are three
-- other doors into this table -- the Salesforce import, the review queue, and a
-- future API. A check that lives in one screen protects one screen.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Matching keys
--
-- "Halvorsen Foods, Inc." and "Halvorsen Foods LLC" are the same company and a
-- plain equality test says they are not. The normalisation strips the legal
-- suffix, the punctuation and the spacing, so the comparison is on the part a
-- human would read as the name.
--
-- IMMUTABLE, because these feed generated columns and indexes. Anything
-- volatile here and Postgres refuses the column outright.
-- ---------------------------------------------------------------------------
create or replace function normalize_company_name(p_name text) returns text as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        lower(coalesce(p_name, '')),
        -- Legal suffixes, at the end only. "Inc" inside a name stays.
        '\s*(,)?\s*\y(inc|incorporated|llc|l\.l\.c|ltd|limited|corp|corporation|co|company|plc|lp|llp|group|holdings|enterprises)\y\.?\s*$',
        '',
        'g'
      ),
      -- Everything that is not a letter or a digit.
      '[^a-z0-9]+', '', 'g'
    ),
    ''
  )
$$ language sql immutable;

create or replace function normalize_address(
  p_street text, p_city text, p_state text
) returns text as $$
  select nullif(
    regexp_replace(
      lower(coalesce(p_street,'') || '|' || coalesce(p_city,'') || '|' || coalesce(p_state,'')),
      '[^a-z0-9|]+', '', 'g'
    ),
    '||'
  )
$$ language sql immutable;

alter table accounts add column if not exists name_key text
  generated always as (normalize_company_name(name)) stored;
alter table accounts add column if not exists address_key text
  generated always as (normalize_address(billing_street, billing_city, billing_state)) stored;

create index if not exists accounts_name_key_idx on accounts(name_key);
create index if not exists accounts_address_key_idx on accounts(address_key) where address_key is not null;

-- ---------------------------------------------------------------------------
-- The flag
-- ---------------------------------------------------------------------------
alter table accounts add column if not exists duplicate_of uuid references accounts(id) on delete set null;
alter table accounts add column if not exists duplicate_reason text;
alter table accounts add column if not exists duplicate_flagged_at timestamptz;
/**
 * While true, only credit and admin may edit this row or move its owner.
 * Set automatically when a duplicate is admitted; cleared by credit once they
 * have decided which record is real.
 */
alter table accounts add column if not exists locked_to_credit boolean not null default false;

create index if not exists accounts_duplicate_idx on accounts(duplicate_of) where duplicate_of is not null;
create index if not exists accounts_locked_idx on accounts(locked_to_credit) where locked_to_credit;

/**
 * Find what an account would collide with.
 *
 * Exposed as a function, not buried in the trigger, so the create form can warn
 * BEFORE somebody types out a whole record. Being refused at the point of save,
 * after five minutes of typing, is how a rule earns a workaround.
 */
create or replace function find_duplicate_accounts(
  p_name text,
  p_street text,
  p_city text,
  p_state text,
  p_phone text,
  p_exclude uuid default null
)
returns table (id uuid, name text, owner_name text, matched_on text) as $$
  select a.id, a.name, u.full_name,
         case
           when a.name_key is not null and a.name_key = normalize_company_name(p_name) then 'name'
           when a.phone_e164 is not null and a.phone_e164 = p_phone then 'phone'
           else 'address'
         end
    from accounts a
    left join users u on u.id = a.owner_id
   where (p_exclude is null or a.id <> p_exclude)
     and (
       (a.name_key is not null and a.name_key = normalize_company_name(p_name))
       or (p_phone is not null and p_phone <> '' and a.phone_e164 = p_phone)
       or (a.address_key is not null
           and a.address_key = normalize_address(p_street, p_city, p_state))
     )
   order by 4
   limit 5
$$ language sql stable;

/**
 * The guard itself.
 *
 * A broker is refused, and told which account they have collided with so they
 * can go and look at it. Credit, management and admin are allowed through, and
 * what they create is flagged and handed to Credit -- because the point of
 * letting them through is that sometimes two records genuinely are different
 * companies, and somebody has to decide which.
 *
 * The service role passes unchallenged: the Salesforce import and the seed both
 * legitimately load whatever is in the source system, and refusing halfway
 * through an import leaves the database in a worse state than the duplicates
 * would have.
 */
create or replace function guard_duplicate_accounts() returns trigger as $$
declare
  actor uuid := current_user_id();
  actor_role text;
  dup record;
  credit_owner uuid;
begin
  -- Nothing that could collide has changed. Skip the lookup entirely, so an
  -- ordinary edit does not pay for this on every save.
  if tg_op = 'UPDATE'
     and new.name is not distinct from old.name
     and new.billing_street is not distinct from old.billing_street
     and new.billing_city is not distinct from old.billing_city
     and new.billing_state is not distinct from old.billing_state
     and new.phone_e164 is not distinct from old.phone_e164 then
    return new;
  end if;

  -- No session: the importer, the seed, a migration. Trusted paths.
  if actor is null then
    return new;
  end if;

  select role into actor_role from users where id = actor;

  select * into dup
    from find_duplicate_accounts(new.name, new.billing_street, new.billing_city,
                                 new.billing_state, new.phone_e164, new.id)
   limit 1;

  if not found then
    return new;
  end if;

  if actor_role not in ('credit','manager','admin') then
    raise exception
      'This looks like a duplicate of "%" (same %). Ask Credit to check before adding it again.',
      dup.name, dup.matched_on
      using errcode = '23505';
  end if;

  -- Admitted, but not quietly. Flagged, and handed to Credit.
  new.duplicate_of := dup.id;
  new.duplicate_reason := format('Matches "%s" on %s', dup.name, dup.matched_on);
  new.duplicate_flagged_at := now();
  new.locked_to_credit := true;

  select id into credit_owner from users where role = 'credit' order by created_at limit 1;
  if credit_owner is not null then
    new.owner_id := credit_owner;
  else
    -- No credit user exists yet. Better unowned and flagged than silently left
    -- with the creator, which is the outcome the rule exists to prevent.
    new.owner_id := null;
  end if;

  return new;
end $$ language plpgsql security definer set search_path = public, auth;

drop trigger if exists t_accounts_guard_duplicates on accounts;
create trigger t_accounts_guard_duplicates before insert or update on accounts
  for each row execute function guard_duplicate_accounts();

/**
 * Locked rows are Credit's.
 *
 * A separate trigger from the guard above, because it protects a different
 * thing: the guard decides what may be CREATED, this decides who may touch it
 * afterwards. A broker cannot claim, edit or rename a flagged duplicate.
 */
create or replace function enforce_credit_lock() returns trigger as $$
declare
  actor uuid := current_user_id();
  actor_role text;
begin
  if not old.locked_to_credit then
    return new;
  end if;
  if actor is null then
    return new;
  end if;

  select role into actor_role from users where id = actor;
  if actor_role in ('credit','admin') then
    return new;
  end if;

  raise exception
    'This account is flagged as a possible duplicate and is held by Credit. Only Credit can change it.'
    using errcode = '42501';
end $$ language plpgsql security definer set search_path = public, auth;

drop trigger if exists t_accounts_credit_lock on accounts;
create trigger t_accounts_credit_lock before update on accounts
  for each row execute function enforce_credit_lock();

-- ---------------------------------------------------------------------------
-- Row level security has to know about the handover.
--
-- Without this the whole feature is dead on arrival, and the way it fails is
-- particularly unhelpful: a manager creates a legitimate second record, the
-- trigger correctly reassigns it to Credit, and then the INSERT policy rejects
-- the row because a credit user is not in the manager's reporting line. The
-- manager sees "new row violates row-level security policy" and nothing they
-- can do will make it work.
--
-- So the policy gains one more permitted shape: an account may also be owned by
-- Credit when it is a flagged duplicate. The extra clause cannot be used to
-- take anything -- it only ever hands an account AWAY, to Credit, with the flag
-- set and the lock on.
-- ---------------------------------------------------------------------------
-- READ, and this one is the subtle half.
--
-- `INSERT ... RETURNING` must satisfy the SELECT policy as well as WITH CHECK.
-- The handover moves the row to Credit in a BEFORE trigger, so by the time
-- RETURNING runs, the manager who just created it can no longer see it -- and
-- Postgres reports that as "new row violates row-level security policy", which
-- points squarely at the wrong clause. Hours can go into the WITH CHECK before
-- anyone suspects the RETURNING.
--
-- Letting the creator see it is also simply correct. They made the record;
-- hiding it from them the instant it is flagged is not a security property, it
-- is a dead end -- and Credit will need to talk to them about it. Only credit,
-- managers and admins can create a duplicate at all, so this clause covers
-- exactly the people who could already have caused it.
drop policy if exists accounts_read on accounts;
create policy accounts_read on accounts for select
  using (
    owner_id is null
    or owner_id in (select visible_user_ids())
    or (select is_privileged())
    -- Flagged duplicates are visible to everyone, and that is deliberate on two
    -- counts. An UPDATE's WHERE clause is subject to the SELECT policy, so a
    -- broker who cannot read the row cannot be refused by the lock trigger
    -- either -- their edit matches zero rows, Postgres reports success, and they
    -- close the page believing they saved. And a visible "possible duplicate,
    -- held by Credit" is what stops a third person typing the same company in
    -- again next week.
    or locked_to_credit
  );

drop policy if exists accounts_insert on accounts;
create policy accounts_insert on accounts for insert
  with check (
    owner_id is null
    or owner_id in (select visible_user_ids())
    or (
      locked_to_credit
      and duplicate_of is not null
      and owner_id in (select id from users where role = 'credit')
    )
  );

-- UPDATE. The USING clause deliberately lets a manager REACH a locked row, so
-- that enforce_credit_lock can refuse it with a sentence.
--
-- Without this the row simply does not match, the UPDATE affects zero rows, and
-- Postgres reports success. The manager closes the page believing they saved.
-- A loud refusal that names Credit is far better than a silent one, and the
-- trigger is what actually withholds the write -- this clause only decides
-- whether the person gets an explanation.
drop policy if exists accounts_update on accounts;
create policy accounts_update on accounts for update
  using (
    owner_id is null
    or owner_id in (select visible_user_ids())
    -- Anyone may REACH a locked row, so enforce_credit_lock can refuse them by
    -- name. Nobody but credit and admin gets past that trigger, so this widens
    -- who receives an explanation, not who may write.
    or locked_to_credit
  )
  with check (
    owner_id is null
    or owner_id in (select visible_user_ids())
    or (
      locked_to_credit
      and duplicate_of is not null
      and owner_id in (select id from users where role = 'credit')
    )
  );

-- ===========================================================================
-- PART TWO: preferences
--
-- Everything a person can change about their own experience, in one row per
-- person. Defaults live in the column definitions rather than in the
-- application, so somebody who has never opened Settings behaves identically to
-- somebody who opened it and changed nothing.
-- ===========================================================================
create table if not exists user_preferences (
  user_id uuid primary key references users(id) on delete cascade,

  /** 'system' | 'light' | 'dark' */
  theme text not null default 'system' check (theme in ('system','light','dark')),
  /** 'comfortable' | 'compact' -- row height in every table. */
  density text not null default 'comfortable' check (density in ('comfortable','compact')),
  /**
   * Overrides for the lifecycle flag colours. Roughly one man in twelve cannot
   * separate the reds from the ambers, and this is the screen those colours
   * decide someone's commission on.
   */
  lifecycle_colors jsonb not null default '{}'::jsonb,
  /** Where signing in lands you. */
  default_landing text not null default '/' check (default_landing in ('/','/accounts','/activity','/me','/reports')),
  /** Which account preset the Accounts screen opens on. */
  default_account_preset text not null default 'my-book',
  timezone text not null default 'America/New_York',

  /** Which events raise an in-app alert, and which send mail. */
  alerts jsonb not null default jsonb_build_object(
    'account_expiring',   jsonb_build_object('app', true,  'email', true),
    'account_released',   jsonb_build_object('app', true,  'email', true),
    'request_decided',    jsonb_build_object('app', true,  'email', true),
    'call_unlogged',      jsonb_build_object('app', true,  'email', false),
    'account_assigned',   jsonb_build_object('app', true,  'email', true),
    'duplicate_flagged',  jsonb_build_object('app', true,  'email', false),
    'daily_digest',       jsonb_build_object('app', false, 'email', true)
  ),

  /** Quality of life. */
  show_tips boolean not null default true,
  compact_sidebar boolean not null default false,
  /** Warn before claiming when already at the tier limit. */
  warn_at_limit boolean not null default true,
  /** Play a sound when a new call lands in the dock. */
  sound_on_call boolean not null default false,

  updated_at timestamptz not null default now()
);

alter table user_preferences enable row level security;

drop policy if exists user_preferences_own on user_preferences;
create policy user_preferences_own on user_preferences for all
  using (user_id = (select current_user_id()))
  with check (user_id = (select current_user_id()));

/*
 * my_preferences() used to be defined here, and is deliberately gone.
 *
 * It returned `user_preferences` and built its fallback as a hand-written
 * row(...) cast to that type. A table's composite type has exactly as many
 * fields as the table has columns, so the first migration to ADD a column to
 * user_preferences turned that into a thirteen-field row cast to a
 * fourteen-field type -- "cannot cast type record to user_preferences".
 *
 * Setup re-runs every file every time, so the failure surfaced HERE, in a file
 * nobody had touched, rather than in 0031 which caused it. The drop has to be
 * in this file rather than in 0031 for the same reason: on a re-run this file
 * executes first, and a create that fails stops the whole set before anything
 * later can clean up after it.
 *
 * Nothing ever called it. The application reads the row through PostgREST and
 * merges it over DEFAULT_PREFERENCES in TypeScript, which does the same job and
 * does not care how many columns the table has. 0031 has the full reasoning.
 */
drop function if exists my_preferences();

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant select, insert, update on user_preferences to %I', r);
      execute format(
        'grant execute on function find_duplicate_accounts(text, text, text, text, text, uuid) to %I', r);
    end if;
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- Rebuild the view: the duplicate flag has to be visible in a list.
-- ---------------------------------------------------------------------------
drop view if exists accounts_with_state;

create view accounts_with_state
with (security_invoker = true) as
select
  a.*,
  account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at, a.retention_override_until)     as state,
  account_days_left(a.owner_id, a.status, a.last_activity_at, a.claimed_at, a.retention_override_until) as days_left,
  account_tenure_activities(a.id, a.claimed_at)                             as tenure_activities,
  u.full_name                                                               as owner_name,
  u.email                                                                   as owner_email,
  u.location                                                                as owner_location,
  ad.full_name                                                              as ad_owner_name,
  p.name                                                                    as parent_account_name,
  dup.name                                                                  as duplicate_of_name,
  (select count(*) from accounts c where c.parent_account_id = a.id)        as child_count,
  (select count(*) from contacts c2 where c2.account_id = a.id)             as contact_count,
  (select count(*) from account_requests r
    where r.account_id = a.id and r.status = 'pending')                     as open_requests,
  case account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at, a.retention_override_until)
    when 'overdue' then 0 when 'expiring' then 1 when 'warning' then 2
    when 'fresh' then 3 when 'protected' then 4 when 'available' then 5
    else 6
  end                                                                       as urgency,
  (select max(occurred_at) from activities x where x.account_id = a.id)     as last_communicated_at
from accounts a
left join users u  on u.id = a.owner_id
left join users ad on ad.id = a.ad_owner_id
left join accounts p on p.id = a.parent_account_id
left join accounts dup on dup.id = a.duplicate_of;

comment on view accounts_with_state is
  'Accounts with their lifecycle state computed. Runs as the caller, so row level security applies.';

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant select on accounts_with_state to %I', r);
    end if;
  end loop;
end $$;
