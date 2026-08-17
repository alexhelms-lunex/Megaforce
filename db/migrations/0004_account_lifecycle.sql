-- 0004_account_lifecycle.sql
--
-- The mechanic this CRM exists for.
--
-- A broker holds a prospect account. If they do not keep up with it, it expires
-- and returns to a pool that any broker can claim from. Keeping up with it means
-- qualifying activity -- which the existing qualification_rules already define,
-- so "did this call count" and "does this broker keep the account" are the same
-- question answered once.
--
-- Nothing here is freight-operational. No carriers, no loads, no rates. Those
-- live in the TMS. Once an account converts to a customer, Salesforce owns it.
-- This system tracks one thing: who is responsible for which prospect, and
-- whether they are actually working it.

-- ---------------------------------------------------------------------------
-- Roles
--
-- Replacing the placeholder set. 'rep' becomes 'broker' because that is what
-- these people are called, and names that match the business are worth the
-- migration -- every conversation about the system otherwise needs a
-- translation step.
-- ---------------------------------------------------------------------------
update users set role = 'broker' where role = 'rep';

/*
 * Created only if absent, rather than dropped and re-added.
 *
 * These files are re-run whenever somebody re-runs setup, and a later migration
 * widens this constraint to include 'ad'. Dropping and re-adding the four-role
 * version on a second pass makes Postgres validate it against rows that already
 * hold the fifth -- so setup failed on exactly the databases that were most up
 * to date, and the error named a migration from months earlier.
 *
 * The list of roles lives in whichever migration last changed it. This one just
 * makes sure a constraint exists at all.
 */
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'users_role_check'
  ) then
    alter table users add constraint users_role_check
      check (role in ('broker','manager','credit','admin'));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Ownership becomes optional
--
-- A null owner is not missing data -- it is the available pool, and it is the
-- single most important state in the system. An account with no owner is one
-- any broker can take.
-- ---------------------------------------------------------------------------
alter table accounts alter column owner_id drop not null;

alter table accounts add column if not exists claimed_at timestamptz;
alter table accounts add column if not exists released_at timestamptz;

-- Why an account is where it is, for the pool screen and for reporting.
alter table accounts add column if not exists last_release_reason text;

-- Partial index: the available pool is queried constantly and stays small
-- relative to the book, so it gets its own index rather than scanning owners.
create index if not exists accounts_available_idx
  on accounts(created_at desc) where owner_id is null;

create index if not exists accounts_claimed_at_idx on accounts(claimed_at);

-- ---------------------------------------------------------------------------
-- account_retention_rules
--
-- How long a broker may sit on an account without working it. Data, not code,
-- for the same reason the qualification thresholds are: "thirty days" is a
-- commercial decision that will be argued about, and changing it must not be a
-- deploy.
--
-- Three thresholds rather than one, because a broker losing an account with no
-- warning is how you get a sales floor that hates the CRM:
--
--   warning_days   -- amber. Still yours, but it needs attention.
--   expiring_days  -- red. Days away from being taken.
--   release_days   -- gone. Returns to the pool.
--
-- Separate rows per status, so a converted customer can have a longer leash
-- than an untouched prospect.
-- ---------------------------------------------------------------------------
create table if not exists account_retention_rules (
  id             uuid primary key default uuid_generate_v4(),
  applies_to     text not null check (applies_to in ('prospect','engaged','customer')),
  warning_days   int not null default 21,
  expiring_days  int not null default 30,
  release_days   int not null default 45,
  active         boolean not null default true,
  updated_by     uuid references users(id),
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  -- Thresholds have to increase, or the states overlap and the UI contradicts
  -- itself. Enforced here so a typo in an admin form cannot produce it.
  constraint retention_days_ordered check (warning_days < expiring_days and expiring_days < release_days)
);

create unique index if not exists account_retention_one_active
  on account_retention_rules(applies_to) where active;

insert into account_retention_rules (applies_to, warning_days, expiring_days, release_days) values
  ('prospect', 21, 30, 45),
  ('engaged',  30, 45, 60),
  -- Converted customers are Salesforce's problem; this is a long leash so the
  -- CRM does not yank an account somebody has already won.
  ('customer', 60, 90, 120)
on conflict (applies_to) where active do nothing;

-- ---------------------------------------------------------------------------
-- account_claims
--
-- Who held what, when, and why they stopped. This is the audit trail that
-- settles territory arguments, and it is the reason release is a recorded event
-- rather than a column quietly going null.
-- ---------------------------------------------------------------------------
create table if not exists account_claims (
  id             uuid primary key default uuid_generate_v4(),
  account_id     uuid not null references accounts(id) on delete cascade,
  user_id        uuid not null references users(id),
  claimed_at     timestamptz not null default now(),
  released_at    timestamptz,
  -- 'expired'    -- the system took it back for inactivity
  -- 'manual'     -- the broker gave it up
  -- 'reassigned' -- an admin moved it
  -- 'converted'  -- became a customer, handed to Salesforce
  release_reason text check (release_reason in ('expired','manual','reassigned','converted') or release_reason is null),
  released_by    uuid references users(id),
  created_at     timestamptz not null default now()
);

create index if not exists account_claims_account_idx on account_claims(account_id, claimed_at desc);
create index if not exists account_claims_user_idx on account_claims(user_id, claimed_at desc);
-- One open claim per account. The database refuses a double-claim rather than
-- trusting two brokers not to click at the same moment.
create unique index if not exists account_claims_one_open
  on account_claims(account_id) where released_at is null;

-- ---------------------------------------------------------------------------
-- Statuses
--
-- Replacing the marketing-flavoured set with the states an account actually
-- moves through here.
-- ---------------------------------------------------------------------------
alter table accounts drop constraint if exists accounts_status_check;

update accounts set status = 'prospect' where status not in ('prospect','engaged','customer','do_not_contact');

alter table accounts add constraint accounts_status_check
  check (status in ('prospect','engaged','customer','do_not_contact'));

alter table accounts alter column status set default 'prospect';

-- ---------------------------------------------------------------------------
-- Claiming and releasing
--
-- The previous trigger allowed only an admin to change ownership. That was
-- right when every account had an owner; it makes claiming from the pool
-- impossible. The rule is narrowed rather than removed:
--
--   * Taking an UNOWNED account for yourself     -- allowed, that is the pool.
--   * Giving up an account you hold              -- allowed, it is yours.
--   * Taking an account somebody else holds      -- refused. This is the whole
--                                                   point of the mechanic.
--   * An admin doing anything                    -- allowed.
-- ---------------------------------------------------------------------------
create or replace function enforce_owner_reassignment() returns trigger as $$
declare
  actor uuid;
  actor_role text;
begin
  if new.owner_id is not distinct from old.owner_id then
    return new;
  end if;

  actor := current_user_id();

  -- No auth context: the service role, a migration, the seed, or the nightly
  -- release job. Trusted paths.
  if actor is null then
    return new;
  end if;

  select role into actor_role from users where id = actor;
  if actor_role in ('admin','credit') then
    return new;
  end if;

  -- Claiming from the pool: it had no owner and you are taking it yourself.
  if old.owner_id is null and new.owner_id = actor then
    return new;
  end if;

  -- Releasing your own back to the pool.
  if old.owner_id = actor and new.owner_id is null then
    return new;
  end if;

  raise exception 'This account belongs to another broker. Only an admin can reassign it.'
    using errcode = '42501';
end $$ language plpgsql security definer set search_path = public, auth;

drop trigger if exists t_accounts_owner_guard on accounts;
create trigger t_accounts_owner_guard before update of owner_id on accounts
  for each row execute function enforce_owner_reassignment();

-- ---------------------------------------------------------------------------
-- Keep claimed_at and the claim history honest, whatever route the change took
-- -- a screen, the release job, or an admin in the SQL editor.
-- ---------------------------------------------------------------------------
create or replace function track_account_claim() returns trigger as $$
begin
  if new.owner_id is not distinct from old.owner_id then
    return new;
  end if;

  -- Close the outgoing claim. A reason set by the caller on the same statement
  -- wins; otherwise infer one.
  if old.owner_id is not null then
    update account_claims
       set released_at = now(),
           release_reason = coalesce(new.last_release_reason,
                                     case when new.owner_id is null then 'manual' else 'reassigned' end),
           released_by = current_user_id()
     where account_id = new.id and released_at is null;
  end if;

  if new.owner_id is not null then
    insert into account_claims (account_id, user_id) values (new.id, new.owner_id);
    new.claimed_at := now();
    new.released_at := null;
  else
    new.claimed_at := null;
    new.released_at := now();
  end if;

  return new;
end $$ language plpgsql security definer set search_path = public, auth;

drop trigger if exists t_accounts_track_claim on accounts;
create trigger t_accounts_track_claim before update of owner_id on accounts
  for each row execute function track_account_claim();

-- An account can arrive already owned -- a Salesforce import, an admin creating
-- one on behalf of a broker, the seed. Those need a claim record too, or the
-- history starts blank and the first release has nothing to close. Ownership
-- history must be complete regardless of how ownership began.
create or replace function stamp_claimed_at() returns trigger as $$
begin
  if new.owner_id is not null and new.claimed_at is null then
    new.claimed_at := now();
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists t_accounts_stamp_claimed on accounts;
create trigger t_accounts_stamp_claimed before insert on accounts
  for each row execute function stamp_claimed_at();

create or replace function track_account_claim_insert() returns trigger as $$
begin
  if new.owner_id is not null then
    insert into account_claims (account_id, user_id, claimed_at)
    values (new.id, new.owner_id, coalesce(new.claimed_at, now()))
    -- The partial unique index permits one open claim per account; a
    -- re-insert of the same row must not open a second.
    on conflict do nothing;
  end if;
  return new;
end $$ language plpgsql security definer set search_path = public, auth;

drop trigger if exists t_accounts_track_claim_insert on accounts;
create trigger t_accounts_track_claim_insert after insert on accounts
  for each row execute function track_account_claim_insert();

-- ---------------------------------------------------------------------------
-- account_state
--
-- One place that decides what colour an account is, so the list, the detail
-- page, the dashboard and the release job cannot disagree. Computed from
-- last_activity_at against the rule for the account's status.
--
-- Returns: 'available' | 'fresh' | 'warning' | 'expiring' | 'overdue'
--
-- 'overdue' means it has passed release_days and the job has not run yet. It is
-- shown, not hidden -- a broker should see the account is gone before it
-- disappears from their list.
-- ---------------------------------------------------------------------------
create or replace function account_state(
  p_owner_id uuid,
  p_status text,
  p_last_activity timestamptz,
  p_claimed_at timestamptz
) returns text as $$
declare
  r record;
  reference timestamptz;
  days numeric;
begin
  if p_owner_id is null then
    return 'available';
  end if;

  select warning_days, expiring_days, release_days into r
    from account_retention_rules
   where applies_to = coalesce(p_status, 'prospect') and active
   limit 1;

  if not found then
    select warning_days, expiring_days, release_days into r
      from account_retention_rules where applies_to = 'prospect' and active limit 1;
  end if;
  if not found then
    return 'fresh';
  end if;

  -- A freshly claimed account with no activity yet is judged from the claim
  -- date. Otherwise a broker would inherit an account already in the red for
  -- someone else's neglect.
  reference := greatest(coalesce(p_last_activity, p_claimed_at), coalesce(p_claimed_at, p_last_activity));
  if reference is null then
    return 'fresh';
  end if;

  days := extract(epoch from (now() - reference)) / 86400;

  if days >= r.release_days  then return 'overdue';  end if;
  if days >= r.expiring_days then return 'expiring'; end if;
  if days >= r.warning_days  then return 'warning';  end if;
  return 'fresh';
end $$ language plpgsql stable;

-- Days remaining before release. Negative once overdue.
create or replace function account_days_left(
  p_owner_id uuid,
  p_status text,
  p_last_activity timestamptz,
  p_claimed_at timestamptz
) returns int as $$
declare
  r record;
  reference timestamptz;
begin
  if p_owner_id is null then return null; end if;

  select release_days into r
    from account_retention_rules
   where applies_to = coalesce(p_status, 'prospect') and active limit 1;
  if not found then
    select release_days into r
      from account_retention_rules where applies_to = 'prospect' and active limit 1;
  end if;
  if not found then return null; end if;

  reference := greatest(coalesce(p_last_activity, p_claimed_at), coalesce(p_claimed_at, p_last_activity));
  if reference is null then return null; end if;

  return ceil(r.release_days - extract(epoch from (now() - reference)) / 86400)::int;
end $$ language plpgsql stable;
