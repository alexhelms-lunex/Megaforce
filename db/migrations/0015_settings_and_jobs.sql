-- 0015_settings_and_jobs.sql
--
-- The spine every outside system hangs off, and the scheduler that drives it.
--
-- Four tables, deliberately generic, because the alternative is a new table and
-- a new admin screen for each provider and the fifth one takes as long as the
-- first. RingCentral, Microsoft 365 and ZoomInfo differ in what they need to
-- connect; they do not differ in "is it on, does it work, when did it last
-- work, and who changed it".
--
-- SECRETS. Held here rather than in environment variables so an administrator
-- can rotate a key without a Vercel login and a redeploy -- which was the
-- explicit requirement. They are encrypted with pgp_sym_encrypt under a key
-- that only ever exists in the application's environment, so the database on
-- its own cannot read them: a leaked backup, a read-only replica, or a support
-- engineer with a SQL console all get ciphertext. The key is passed in per call
-- and never stored.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Settings
--
-- One row per setting, JSON value. Not a wide table with a column per option,
-- because every new option would then be a migration, and "changeable in the
-- app" has to mean changeable without a deploy.
-- ---------------------------------------------------------------------------
create table if not exists app_settings (
  key         text primary key,
  value       jsonb not null,
  /** Shown above the field on the settings screen. */
  label       text not null,
  description text,
  /** Groups the settings screen into sections. */
  category    text not null default 'general',
  sort        int not null default 0,
  updated_by  uuid references users(id),
  updated_at  timestamptz not null default now()
);

alter table app_settings enable row level security;

-- Readable by everyone signed in: the 5am send hour and the digest template are
-- not secrets, and screens need them. Writable by admins only.
drop policy if exists app_settings_read on app_settings;
create policy app_settings_read on app_settings for select
  using ((select auth.uid()) is not null);

drop policy if exists app_settings_write on app_settings;
create policy app_settings_write on app_settings for all
  using ((select current_user_role()) = 'admin')
  with check ((select current_user_role()) = 'admin');

insert into app_settings (key, value, label, description, category, sort) values
  ('email.enabled', 'false'::jsonb, 'Send email',
   'Master switch. Off means nothing is sent, whatever else is configured.', 'email', 10),
  ('email.daily_digest_hour', '5'::jsonb, 'Daily digest hour',
   'Hour of the day, in the timezone below, that the broker digest goes out.', 'email', 20),
  ('email.timezone', '"America/New_York"'::jsonb, 'Timezone',
   'The clock the send hour is read against. The scheduler runs hourly in UTC and converts.', 'email', 30),
  ('email.from_name', '"Megaforce CRM"'::jsonb, 'From name', null, 'email', 40),
  ('email.from_address', '""'::jsonb, 'From address',
   'Must be a mailbox the connected Microsoft 365 account is allowed to send as.', 'email', 50),
  ('email.digest_send_when_empty', 'false'::jsonb, 'Send even when there is nothing to say',
   'Off means a broker with a clean book gets no email. A daily message that is usually empty is a daily message people filter.', 'email', 60),
  ('email.reply_to', '""'::jsonb, 'Reply-to address', null, 'email', 70),
  ('email.footer', '"You are receiving this because you hold accounts in Megaforce."'::jsonb,
   'Footer line', null, 'email', 80),
  ('inbox.enabled', 'false'::jsonb, 'Log email from Outlook',
   'Reads connected mailboxes and turns messages to and from contacts on file into activities.', 'inbox', 10),
  ('inbox.lookback_minutes', '90'::jsonb, 'How far back to read each run',
   'Overlap is deliberate; the same message is recognised and never logged twice.', 'inbox', 20),
  ('lifecycle.release_enabled', 'true'::jsonb, 'Release overdue accounts',
   'The nightly sweep. Off means accounts show as overdue and are never actually taken.', 'lifecycle', 10),
  ('zoominfo.enabled', 'false'::jsonb, 'ZoomInfo lookup',
   'Shows the ZoomInfo panel on every company record.', 'zoominfo', 10)
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Integrations
-- ---------------------------------------------------------------------------
create table if not exists integrations (
  provider    text primary key check (provider in ('ringcentral','microsoft','zoominfo')),
  enabled     boolean not null default false,
  /** Non-secret configuration: server URLs, tenant id, mailbox addresses. */
  config      jsonb not null default '{}'::jsonb,
  /** Secret values, encrypted. Never selected by the ordinary read path. */
  secrets     bytea,
  /** Last successful call, and the last failure, so the screen can be honest. */
  last_ok_at  timestamptz,
  last_error  text,
  last_error_at timestamptz,
  updated_by  uuid references users(id),
  updated_at  timestamptz not null default now()
);

insert into integrations (provider) values ('ringcentral'), ('microsoft'), ('zoominfo')
on conflict (provider) do nothing;

alter table integrations enable row level security;

-- Admins only, in both directions. Even the non-secret config names internal
-- hosts and mailbox addresses, which is not something a broker needs.
drop policy if exists integrations_admin on integrations;
create policy integrations_admin on integrations for all
  using ((select current_user_role()) = 'admin')
  with check ((select current_user_role()) = 'admin');

/**
 * Store a provider's secrets.
 *
 * The whole secret bundle is encrypted as one JSON document rather than column
 * by column, so adding a field to a provider needs no migration.
 *
 * SECURITY DEFINER because the worker that reads these runs without a user
 * session. The grant list at the bottom is what actually limits who may call
 * it -- and the encryption key still has to be supplied by the caller, so
 * execute permission alone reveals nothing.
 */
create or replace function set_integration_secrets(
  p_provider text,
  p_secrets jsonb,
  p_key text
) returns void as $$
begin
  if p_key is null or length(p_key) < 16 then
    raise exception 'encryption key missing or too short';
  end if;
  update integrations
     set secrets = pgp_sym_encrypt(p_secrets::text, p_key),
         updated_at = now(),
         updated_by = current_user_id()
   where provider = p_provider;
end $$ language plpgsql security definer set search_path = public, auth;

create or replace function get_integration_secrets(p_provider text, p_key text)
returns jsonb as $$
declare
  raw bytea;
begin
  select secrets into raw from integrations where provider = p_provider;
  if raw is null then
    return '{}'::jsonb;
  end if;
  return pgp_sym_decrypt(raw, p_key)::jsonb;
exception when others then
  -- A wrong key throws. Returning null rather than the exception lets the
  -- caller say "the key does not match what is stored" instead of leaking a
  -- decryption error into a page.
  return null;
end $$ language plpgsql security definer set search_path = public, auth;

/** Which fields each provider needs. Drives the settings form. */
create table if not exists integration_fields (
  provider   text not null,
  key        text not null,
  label      text not null,
  help       text,
  secret     boolean not null default false,
  required   boolean not null default true,
  sort       int not null default 0,
  primary key (provider, key)
);

insert into integration_fields (provider, key, label, help, secret, required, sort) values
  ('ringcentral','server','Server URL','https://platform.ringcentral.com for production, https://platform.devtest.ringcentral.com to test.',false,true,10),
  ('ringcentral','client_id','Client ID',null,false,true,20),
  ('ringcentral','client_secret','Client secret',null,true,true,30),
  ('ringcentral','jwt','JWT credential','From the RingCentral app under Credentials. Grants the app permission to read call logs and place calls.',true,true,40),
  ('ringcentral','webhook_secret','Webhook verification token','Anything long and random. Paste the same value into RingCentral''s webhook settings.',true,false,50),

  ('microsoft','tenant_id','Directory (tenant) ID','From Entra ID, on the app registration overview page.',false,true,10),
  ('microsoft','client_id','Application (client) ID',null,false,true,20),
  ('microsoft','client_secret','Client secret','From Certificates & secrets. Note the expiry date -- these lapse, and mail stops silently when they do.',true,true,30),
  ('microsoft','send_as','Send-as mailbox','The mailbox the digest is sent from. The app registration needs Mail.Send for it.',false,false,40),

  ('zoominfo','username','Username',null,false,true,10),
  ('zoominfo','client_id','Client ID','From the ZoomInfo API console.',false,false,20),
  ('zoominfo','private_key','Private key','Used for PKI authentication. Paste the whole key including the header and footer lines.',true,true,30)
on conflict (provider, key) do nothing;

alter table integration_fields enable row level security;
drop policy if exists integration_fields_read on integration_fields;
create policy integration_fields_read on integration_fields for select
  using ((select current_user_role()) = 'admin');

-- ---------------------------------------------------------------------------
-- Scheduled work
--
-- Every run is recorded, successful or not. The alternative -- a job that runs
-- silently and is assumed to be working -- is exactly how the nightly release
-- came to have never run at all.
-- ---------------------------------------------------------------------------
create table if not exists job_runs (
  id          uuid primary key default uuid_generate_v4(),
  job         text not null,
  started_at  timestamptz not null default now(),
  finished_at timestamptz,
  ok          boolean,
  /** Free-form counts: accounts released, emails sent, messages read. */
  result      jsonb not null default '{}'::jsonb,
  error       text,
  /** 'schedule' | 'manual' -- so a hand-run does not look like a healthy cron. */
  trigger     text not null default 'schedule'
);

create index if not exists job_runs_job_started_idx on job_runs(job, started_at desc);

alter table job_runs enable row level security;
drop policy if exists job_runs_read on job_runs;
create policy job_runs_read on job_runs for select
  using ((select current_user_role()) in ('admin','manager'));

-- ---------------------------------------------------------------------------
-- Email
-- ---------------------------------------------------------------------------
create table if not exists email_templates (
  key       text primary key,
  name      text not null,
  subject   text not null,
  /** Handlebars-ish {{token}} body. The available tokens are listed on screen. */
  body      text not null,
  enabled   boolean not null default true,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

insert into email_templates (key, name, subject, body) values
  ('daily_digest', 'Daily broker digest',
   'Your book this morning: {{at_risk_count}} need attention',
   E'Good morning {{first_name}},\n\n'
   '{{#if unlogged_count}}You have {{unlogged_count}} call(s) still to write up. A call does not count until it has a company, a contact, notes and a stage.\n\n{{/if}}'
   'Needing attention today ({{at_risk_count}}):\n{{at_risk_list}}\n\n'
   'You hold {{owned_count}} accounts of a possible {{prospect_limit}}.\n'
   'Last 7 days: {{calls_7d}} calls, {{qualifying_7d}} of them counted.\n\n'
   'Open your book: {{app_url}}\n'),
  ('request_decided', 'Account request decided',
   'Your {{kind}} request on {{account_name}} was {{status}}',
   E'{{first_name}},\n\n{{decider_name}} {{status}} your {{kind}} request on {{account_name}}.\n\n{{decision_note}}\n\n{{app_url}}/requests\n'),
  ('account_released', 'Account released',
   '{{account_name}} has returned to the available pool',
   E'{{first_name}},\n\n{{account_name}} passed its window without an approved activity and has returned to the available pool.\n\nAnyone can claim it now, including you.\n\n{{app_url}}/available\n')
on conflict (key) do nothing;

alter table email_templates enable row level security;
drop policy if exists email_templates_read on email_templates;
create policy email_templates_read on email_templates for select
  using ((select auth.uid()) is not null);
drop policy if exists email_templates_write on email_templates;
create policy email_templates_write on email_templates for all
  using ((select current_user_role()) = 'admin')
  with check ((select current_user_role()) = 'admin');

/**
 * Every message this system sends.
 *
 * Written before the send is attempted, updated after. "Did the 5am email go
 * out?" has to be answerable from a screen, not from a provider's dashboard --
 * and a queued row that never reached 'sent' is the only evidence that the send
 * crashed halfway.
 */
create table if not exists email_log (
  id           uuid primary key default uuid_generate_v4(),
  template_key text,
  to_user_id   uuid references users(id),
  to_address   text not null,
  subject      text not null,
  body         text not null,
  /** 'queued' | 'sent' | 'failed' | 'skipped' */
  status       text not null default 'queued',
  error        text,
  /** Why a message was deliberately not sent -- opted out, empty digest. */
  skip_reason  text,
  provider_id  text,
  job_run_id   uuid references job_runs(id),
  created_at   timestamptz not null default now(),
  sent_at      timestamptz
);

create index if not exists email_log_created_idx on email_log(created_at desc);
create index if not exists email_log_user_idx on email_log(to_user_id, created_at desc);

-- One digest per person per day, whatever the scheduler does. A cron that
-- double-fires, a manual run on top of the scheduled one, or a retry after a
-- partial failure must not put three copies in somebody's inbox.
-- The date expression needs its own parentheses: an index element that is not a
-- bare column or a plain function call has to be wrapped, or the parser trips
-- on the cast.
create unique index if not exists email_log_one_daily_digest_idx
  on email_log(to_user_id, template_key, ((created_at at time zone 'UTC')::date))
  where template_key = 'daily_digest' and status in ('sent','queued');

alter table email_log enable row level security;
drop policy if exists email_log_read on email_log;
create policy email_log_read on email_log for select
  using (to_user_id = (select current_user_id()) or (select current_user_role()) = 'admin');

/** Per-person opt-outs. Absent row means subscribed. */
create table if not exists email_preferences (
  user_id      uuid primary key references users(id) on delete cascade,
  daily_digest boolean not null default true,
  notifications boolean not null default true,
  updated_at   timestamptz not null default now()
);

alter table email_preferences enable row level security;
drop policy if exists email_preferences_own on email_preferences;
create policy email_preferences_own on email_preferences for all
  using (user_id = (select current_user_id()) or (select current_user_role()) = 'admin')
  with check (user_id = (select current_user_id()) or (select current_user_role()) = 'admin');

-- ---------------------------------------------------------------------------
-- What the digest says
--
-- Assembled in SQL, one row per broker, so the 5am job is a single query rather
-- than N+1 round trips per person. At a thousand users that difference is the
-- job finishing before anybody wakes up.
--
-- SECURITY DEFINER, because the scheduler runs with no user session and must
-- see every broker's book. It is the one place in this system that deliberately
-- reads across owners, and it exists solely to send each person their own.
-- ---------------------------------------------------------------------------
create or replace function digest_recipients()
returns table (
  user_id        uuid,
  full_name      text,
  email          text,
  prospect_limit int,
  owned          bigint,
  at_risk        bigint,
  unlogged       bigint,
  calls_7d       bigint,
  qualifying_7d  bigint,
  at_risk_list   jsonb
) as $$
  with people as (
    select u.id, u.full_name, u.email, u.prospect_limit
      from users u
      left join email_preferences p on p.user_id = u.id
     where u.role in ('broker','manager')
       and u.email is not null
       and coalesce(p.daily_digest, true)
  ),
  books as (
    select a.owner_id,
           count(*) as owned,
           count(*) filter (where a.state in ('warning','expiring','overdue')) as at_risk
      from accounts_with_state a
     where a.owner_id in (select id from people)
     group by a.owner_id
  ),
  calls as (
    select x.user_id,
           count(*) filter (where x.occurred_at >= now() - interval '7 days') as calls_7d,
           count(*) filter (where x.occurred_at >= now() - interval '7 days' and x.qualifies) as qual_7d,
           count(*) filter (where x.logged_at is null) as unlogged
      from activities x
     where x.type = 'call' and x.user_id in (select id from people)
     group by x.user_id
  )
  select
    p.id, p.full_name, p.email, p.prospect_limit,
    coalesce(b.owned, 0), coalesce(b.at_risk, 0),
    coalesce(c.unlogged, 0), coalesce(c.calls_7d, 0), coalesce(c.qual_7d, 0),
    coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', t.id, 'name', t.name, 'state', t.state, 'days_left', t.days_left)
               order by t.urgency, t.days_left)
        from (
          select a.id, a.name, a.state, a.days_left, a.urgency
            from accounts_with_state a
           where a.owner_id = p.id
             and a.state in ('warning','expiring','overdue')
           order by a.urgency, a.days_left nulls last
           limit 10
        ) t
    ), '[]'::jsonb)
  from people p
  left join books b on b.owner_id = p.id
  left join calls c on c.user_id  = p.id
$$ language sql stable security definer set search_path = public, auth;

do $$
declare
  r text;
  f text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      foreach f in array array[
        'set_integration_secrets(text, jsonb, text)',
        'get_integration_secrets(text, text)'
      ] loop
        execute format('grant execute on function %s to %I', f, r);
      end loop;
      execute format('grant select on integration_fields to %I', r);
      execute format('grant select, insert, update on app_settings to %I', r);
      execute format('grant select, insert, update on integrations to %I', r);
      execute format('grant select on job_runs to %I', r);
      execute format('grant select, insert, update on email_templates to %I', r);
      execute format('grant select on email_log to %I', r);
      execute format('grant select, insert, update on email_preferences to %I', r);
    end if;
  end loop;
end $$;
