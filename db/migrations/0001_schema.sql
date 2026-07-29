-- 0001_schema.sql
-- Core CRM schema. Safe to re-run: every object is guarded.
-- Runs identically against Supabase (direct connection, port 5432) and the
-- local PGlite harness used by tests.

create extension if not exists "uuid-ossp";

-- ---------------------------------------------------------------------------
-- users
-- manager_id is a self-reference. The org chart it forms is what the row level
-- security policies in 0002 walk to decide who can see what.
-- ---------------------------------------------------------------------------
create table if not exists users (
  id          uuid primary key default uuid_generate_v4(),
  auth_id     uuid unique,
  email       text not null unique,
  full_name   text not null,
  role        text not null check (role in ('rep','manager','admin')),
  manager_id  uuid references users(id),
  -- The telephony extension this person dials from. It is how an inbound call
  -- event is attributed to a rep rather than merely to an account. Unknown
  -- extensions fall back to the account owner; see src/lib/matcher.ts.
  rc_extension_id text unique,
  created_at  timestamptz not null default now()
);
create index if not exists users_manager_id_idx on users(manager_id);

-- ---------------------------------------------------------------------------
-- accounts
--
-- last_activity_at is STORED, not computed. Deriving "days since last activity"
-- with a correlated subquery over activities on every dashboard render is the
-- query that makes the demo hang in front of an exec. A trigger keeps it fresh.
--
-- custom jsonb holds admin-defined field values; see field_defs below.
-- ---------------------------------------------------------------------------
create table if not exists accounts (
  id                uuid primary key default uuid_generate_v4(),
  name              text not null,
  owner_id          uuid not null references users(id),
  industry          text,
  status            text not null default 'active',
  domain            text,
  last_activity_at  timestamptz,
  custom            jsonb not null default '{}',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create index if not exists accounts_owner_id_idx         on accounts(owner_id);
create index if not exists accounts_last_activity_at_idx on accounts(last_activity_at);
create index if not exists accounts_status_idx           on accounts(status);
create index if not exists accounts_domain_idx           on accounts(lower(domain));
-- GIN over the whole jsonb document. Without this, filtering a saved view on a
-- custom field degrades to a sequential scan of every account.
create index if not exists accounts_custom_gin          on accounts using gin(custom);

-- ---------------------------------------------------------------------------
-- contacts
-- phone_e164 is the join key the call matcher uses. It is indexed and it is
-- always normalized on write -- see src/lib/phone.ts.
-- ---------------------------------------------------------------------------
create table if not exists contacts (
  id          uuid primary key default uuid_generate_v4(),
  account_id  uuid not null references accounts(id) on delete cascade,
  first_name  text not null,
  last_name   text not null,
  email       text,
  phone_e164  text,
  title       text,
  custom      jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists contacts_account_id_idx on contacts(account_id);
create index if not exists contacts_phone_idx      on contacts(phone_e164) where phone_e164 is not null;
create index if not exists contacts_email_idx      on contacts(lower(email)) where email is not null;
create index if not exists contacts_custom_gin     on contacts using gin(custom);

-- ---------------------------------------------------------------------------
-- opportunities
-- ---------------------------------------------------------------------------
create table if not exists opportunities (
  id          uuid primary key default uuid_generate_v4(),
  account_id  uuid not null references accounts(id) on delete cascade,
  owner_id    uuid not null references users(id),
  name        text not null,
  stage       text not null,
  amount      numeric(14,2),
  close_date  date,
  custom      jsonb not null default '{}',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists opportunities_owner_stage_idx on opportunities(owner_id, stage);
create index if not exists opportunities_account_id_idx  on opportunities(account_id);
create index if not exists opportunities_close_date_idx  on opportunities(close_date);
create index if not exists opportunities_custom_gin      on opportunities using gin(custom);

-- ---------------------------------------------------------------------------
-- raw_events
--
-- Every inbound webhook lands here verbatim BEFORE anything interprets it.
-- When a rep asks "why didn't my call log", this table is the answer.
--
-- The partial unique index on (source, external_id) is the idempotency
-- guarantee: providers redeliver, and a redelivery must not become a second
-- activity.
-- ---------------------------------------------------------------------------
create table if not exists raw_events (
  id            uuid primary key default uuid_generate_v4(),
  source        text not null,
  external_id   text,
  payload       jsonb not null,
  received_at   timestamptz not null default now(),
  processed_at  timestamptz,
  error         text
);
create unique index if not exists raw_events_source_external_uniq
  on raw_events(source, external_id) where external_id is not null;
create index if not exists raw_events_unprocessed_idx
  on raw_events(received_at) where processed_at is null;

-- ---------------------------------------------------------------------------
-- activities
--
-- qualification_reason is written on EVERY row, pass or fail. It is the field
-- that makes the pipeline explainable: "why didn't my call log" is answered by
-- reading one column instead of filing a ticket.
-- ---------------------------------------------------------------------------
create table if not exists activities (
  id                    uuid primary key default uuid_generate_v4(),
  account_id            uuid references accounts(id) on delete cascade,
  contact_id            uuid references contacts(id) on delete set null,
  user_id               uuid references users(id),
  type                  text not null check (type in ('call','email','meeting','note')),
  direction             text check (direction in ('inbound','outbound') or direction is null),
  subject               text,
  occurred_at           timestamptz not null,
  duration_seconds      int,
  -- The provider's own outcome string, kept verbatim: 'Call connected',
  -- 'Voicemail', 'No Answer', 'Busy'. The qualifier reads it, and it is quoted
  -- back in qualification_reason so a rejection cites the actual evidence.
  result                text,
  source                text not null default 'manual',
  external_id           text,
  qualifies             boolean not null default false,
  qualification_reason  text not null default '',
  raw_event_id          uuid references raw_events(id),
  created_at            timestamptz not null default now()
);
create unique index if not exists activities_source_external_uniq
  on activities(source, external_id) where external_id is not null;
create index if not exists activities_account_occurred_idx on activities(account_id, occurred_at desc);
create index if not exists activities_user_occurred_idx    on activities(user_id, occurred_at desc);
create index if not exists activities_contact_idx          on activities(contact_id);
create index if not exists activities_qualifying_idx
  on activities(account_id, occurred_at desc) where qualifies;

-- ---------------------------------------------------------------------------
-- unmatched_activities
--
-- Calls that matched no contact, or matched contacts at more than one account.
-- This is screen 4 -- the queue nobody builds and everybody needs.
-- ---------------------------------------------------------------------------
create table if not exists unmatched_activities (
  id                     uuid primary key default uuid_generate_v4(),
  raw_event_id           uuid not null references raw_events(id),
  reason                 text not null,
  candidate_account_ids  uuid[],
  phone_e164             text,
  email                  text,
  direction              text,
  duration_seconds       int,
  result                 text,
  subject                text,
  occurred_at            timestamptz,
  created_at             timestamptz not null default now(),
  resolved_at            timestamptz,
  resolved_by            uuid references users(id),
  resolved_to_account_id uuid references accounts(id),
  resolved_activity_id   uuid references activities(id)
);
-- Partial index: the queue only ever reads open rows, and it stays small even
-- after a year of resolved history sits behind it.
create index if not exists unmatched_open_idx on unmatched_activities(created_at desc)
  where resolved_at is null;
create unique index if not exists unmatched_raw_event_uniq on unmatched_activities(raw_event_id);

-- ---------------------------------------------------------------------------
-- field_defs
--
-- Admin-defined fields. Adding a field is an INSERT here, not a migration and
-- not a deploy. Forms render from these rows; values live in the target
-- table's `custom` jsonb column.
-- ---------------------------------------------------------------------------
create table if not exists field_defs (
  id        uuid primary key default uuid_generate_v4(),
  object    text not null check (object in ('account','contact','opportunity')),
  key       text not null,
  label     text not null,
  type      text not null check (type in ('text','number','date','select','boolean')),
  options   jsonb,
  required  boolean not null default false,
  sort      int not null default 0,
  archived  boolean not null default false,
  created_at timestamptz not null default now(),
  unique(object, key)
);
create index if not exists field_defs_object_sort_idx on field_defs(object, sort) where not archived;

-- ---------------------------------------------------------------------------
-- qualification_rules
--
-- What counts as a real call is a BUSINESS rule, so it lives in data, not in a
-- deploy. Exactly one row is active at a time; superseded rows are retained so
-- an activity's qualification_reason can always be traced to the rule that
-- produced it.
-- ---------------------------------------------------------------------------
create table if not exists qualification_rules (
  id                    uuid primary key default uuid_generate_v4(),
  activity_type         text not null check (activity_type in ('call','email','meeting','note')),
  min_duration_seconds  int not null default 0,
  -- empty array means "any result is acceptable"
  allowed_results       text[] not null default '{}',
  -- null means "either direction qualifies"
  required_direction    text check (required_direction in ('inbound','outbound') or required_direction is null),
  active                boolean not null default true,
  updated_by            uuid references users(id),
  updated_at            timestamptz not null default now(),
  created_at            timestamptz not null default now()
);
-- At most one active rule per activity type. Enforced by the database, so a
-- double-click in the admin UI cannot produce two competing rules.
create unique index if not exists qualification_rules_one_active
  on qualification_rules(activity_type) where active;

-- ---------------------------------------------------------------------------
-- saved_views
-- Named filter sets for the account list (screen 1).
-- ---------------------------------------------------------------------------
create table if not exists saved_views (
  id         uuid primary key default uuid_generate_v4(),
  object     text not null check (object in ('account','contact','opportunity','activity')),
  name       text not null,
  owner_id   uuid references users(id) on delete cascade,
  shared     boolean not null default false,
  definition jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index if not exists saved_views_object_owner_idx on saved_views(object, owner_id);

-- ===========================================================================
-- Triggers
-- ===========================================================================

-- Keep accounts.last_activity_at current. Only qualifying activity counts --
-- a 20 second wrong number must not make a dead account look alive.
create or replace function bump_last_activity() returns trigger as $$
begin
  if new.qualifies and new.account_id is not null then
    update accounts
       set last_activity_at = greatest(coalesce(last_activity_at, new.occurred_at), new.occurred_at),
           updated_at       = now()
     where id = new.account_id
       and (last_activity_at is null or last_activity_at < new.occurred_at);
  end if;
  return new;
end $$ language plpgsql;

drop trigger if exists t_bump_last_activity on activities;
create trigger t_bump_last_activity after insert on activities
  for each row execute function bump_last_activity();

-- Generic updated_at maintenance.
create or replace function touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end $$ language plpgsql;

drop trigger if exists t_accounts_touch on accounts;
create trigger t_accounts_touch before update on accounts
  for each row execute function touch_updated_at();

drop trigger if exists t_opportunities_touch on opportunities;
create trigger t_opportunities_touch before update on opportunities
  for each row execute function touch_updated_at();
