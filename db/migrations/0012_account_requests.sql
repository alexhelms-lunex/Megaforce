-- 0012_account_requests.sql
--
-- The Account Request tab, and the clock override it grants.
--
-- One mechanism serves two things the policy names separately -- amnesty on a
-- prospect and an extension on a customer -- because they are the same
-- transaction: an employee asks to hold an account past its window, and
-- somebody above them says yes or no. Building them twice would let the two
-- approval paths drift apart, and the drift would only surface in a dispute.
--
-- Approval does NOT rewrite last_activity_at. That column means "the last time
-- an approved activity landed here", and forging it to buy time would make the
-- activity history lie about work that never happened -- exactly the record a
-- territory argument turns on. Instead an approval writes a separate override
-- date, and the state functions read it alongside the activity clock.

alter table accounts add column if not exists retention_override_until timestamptz;

comment on column accounts.retention_override_until is
  'Granted by an approved account request. While in the future the account cannot expire.';

-- ---------------------------------------------------------------------------
-- The state functions learn about the override.
--
-- DROP then CREATE, not CREATE OR REPLACE: the parameter list changes, and
-- Postgres treats a different signature as a different function -- leaving the
-- four-argument version in place and making every call ambiguous. The view
-- depends on both, so it comes down first and goes back up at the bottom.
-- ---------------------------------------------------------------------------
-- Both signatures are dropped. The four-argument one because 0004 defines it
-- and re-running these migrations recreates it; the five-argument one because
-- this file may itself be re-run, and CREATE would then collide with its own
-- previous result. Migrations here are expected to be idempotent, and setup
-- runs the whole directory every time.
drop view if exists accounts_with_state;
drop function if exists account_state(uuid, text, timestamptz, timestamptz);
drop function if exists account_state(uuid, text, timestamptz, timestamptz, timestamptz);
drop function if exists account_days_left(uuid, text, timestamptz, timestamptz);
drop function if exists account_days_left(uuid, text, timestamptz, timestamptz, timestamptz);

create function account_state(
  p_owner_id uuid,
  p_status text,
  p_last_activity timestamptz,
  p_claimed_at timestamptz,
  p_override_until timestamptz
) returns text as $$
declare
  r record;
  reference timestamptz;
  days numeric;
begin
  if p_owner_id is null then
    return 'available';
  end if;

  -- A live override outranks the clock entirely. Somebody with the authority to
  -- grant it has already decided this account is being kept.
  if p_override_until is not null and p_override_until > now() then
    return 'protected';
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

create function account_days_left(
  p_owner_id uuid,
  p_status text,
  p_last_activity timestamptz,
  p_claimed_at timestamptz,
  p_override_until timestamptz
) returns int as $$
declare
  r record;
  reference timestamptz;
begin
  if p_owner_id is null then return null; end if;

  -- Under an override, "days left" is days of protection remaining. It is the
  -- number the holder actually needs: how long before this is a problem again.
  if p_override_until is not null and p_override_until > now() then
    return ceil(extract(epoch from (p_override_until - now())) / 86400)::int;
  end if;

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

-- The nightly sweep must not take a protected account. Without this the
-- approval would show on screen and be silently ignored by the job that
-- actually releases things, which is the worst possible split.
create or replace function release_overdue_accounts() returns int as $$
declare
  n int;
begin
  with released as (
    update accounts a set
      owner_id = null,
      released_at = now(),
      last_release_reason = 'expired'
    where a.owner_id is not null
      and coalesce(a.retention_override_until, '-infinity'::timestamptz) <= now()
      and account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at,
                        a.retention_override_until) = 'overdue'
    returning a.id
  )
  select count(*) into n from released;

  update account_claims c
     set released_at = now(), release_reason = 'expired'
    from accounts a
   where c.account_id = a.id and a.owner_id is null and c.released_at is null;

  return n;
end $$ language plpgsql;

-- ---------------------------------------------------------------------------
-- The requests themselves
-- ---------------------------------------------------------------------------
create table if not exists account_requests (
  id            uuid primary key default uuid_generate_v4(),
  account_id    uuid not null references accounts(id) on delete cascade,
  requested_by  uuid not null references users(id),
  -- amnesty:   keep a prospect past its window
  -- extension: keep a customer past its window (the policy's Sales Director call)
  -- national:  promote to a national account
  -- release:   hand it back early, on purpose
  -- transfer:  move it to somebody else
  kind          text not null check (kind in ('amnesty','extension','national','release','transfer')),
  reason        text not null check (length(btrim(reason)) > 0),
  /** How many days of protection is being asked for. Null for kinds that do not grant time. */
  days          int check (days is null or (days > 0 and days <= 365)),
  /** For a transfer: who it should go to. */
  transfer_to   uuid references users(id),
  status        text not null default 'pending' check (status in ('pending','approved','denied','withdrawn')),
  decided_by    uuid references users(id),
  decided_at    timestamptz,
  decision_note text,
  created_at    timestamptz not null default now(),

  -- A decision carries who made it. Half-recorded approvals are how an audit
  -- trail becomes a rumour.
  constraint account_requests_decision_complete check (
    status in ('pending','withdrawn') or (decided_by is not null and decided_at is not null)
  ),
  constraint account_requests_transfer_target check (
    kind <> 'transfer' or transfer_to is not null
  )
);

create index if not exists account_requests_pending_idx
  on account_requests(created_at desc) where status = 'pending';
create index if not exists account_requests_account_idx on account_requests(account_id);
create index if not exists account_requests_requester_idx on account_requests(requested_by);

-- Only one open request per account, so two managers cannot approve the same
-- ask twice and grant 120 days when 60 were requested.
create unique index if not exists account_requests_one_open_idx
  on account_requests(account_id) where status = 'pending';

alter table account_requests enable row level security;

-- You can see your own requests, anything raised by somebody in your reporting
-- line, and -- if you are credit or admin -- all of them.
drop policy if exists account_requests_read on account_requests;
create policy account_requests_read on account_requests for select
  using (
    requested_by = (select current_user_id())
    or requested_by in (select visible_user_ids())
    or (select is_privileged())
  );

-- Anyone may ask, but only for themselves. Raising a request in a colleague's
-- name is impersonation, and the WITH CHECK is what makes that impossible
-- rather than merely discouraged.
drop policy if exists account_requests_insert on account_requests;
create policy account_requests_insert on account_requests for insert
  with check (requested_by = (select current_user_id()) and status = 'pending');

-- Deciding is a manager's act. A requester can withdraw their own, which the
-- application enforces by only ever writing status = 'withdrawn' there.
drop policy if exists account_requests_update on account_requests;
create policy account_requests_update on account_requests for update
  using (
    requested_by = (select current_user_id())
    or requested_by in (select visible_user_ids())
    or (select is_privileged())
  )
  with check (
    requested_by = (select current_user_id())
    or requested_by in (select visible_user_ids())
    or (select is_privileged())
  );

-- ---------------------------------------------------------------------------
-- Ownership may also change through an approved request.
--
-- 0004 refuses any owner change by somebody who is not an admin, and that rule
-- is right: taking an account off a colleague is the thing the whole mechanic
-- exists to prevent. But an approved transfer or early release IS the sanctioned
-- way to move one, and without this exception a manager's approval is recorded
-- and then silently refused by the trigger.
--
-- The exception is narrow. It is not "a manager may reassign"; it is "this
-- specific transaction is applying this specific approved request". The GUC is
-- transaction-local and set only inside decide_account_request, and even a
-- forged value has to name a request row that genuinely exists, is genuinely
-- approved, and genuinely points at the account being changed.
-- ---------------------------------------------------------------------------
create or replace function enforce_owner_reassignment() returns trigger as $$
declare
  actor uuid;
  actor_role text;
  applying uuid;
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

  applying := nullif(current_setting('megaforce.applying_request', true), '')::uuid;
  if applying is not null and exists (
    select 1 from account_requests r
     where r.id = applying
       and r.account_id = new.id
       and r.status = 'approved'
       and r.kind in ('transfer','release')
  ) then
    return new;
  end if;

  raise exception 'This account belongs to another broker. Only an admin can reassign it.'
    using errcode = '42501';
end $$ language plpgsql security definer set search_path = public, auth;

/**
 * Approve or deny, and apply the effect in the same transaction.
 *
 * The decision and its consequence cannot be two statements from the
 * application: a crash between them leaves a request marked approved that
 * granted nothing, and the holder finds out when the account disappears.
 *
 * SECURITY INVOKER, so the caller's own row level security decides whether they
 * may touch this request and this account. A manager can approve within their
 * subtree because the policies already say so; nothing here grants rights.
 */
create or replace function decide_account_request(
  p_request_id uuid,
  p_approve boolean,
  p_note text default null
) returns text as $$
declare
  req account_requests%rowtype;
  me uuid := (select current_user_id());
begin
  -- No identity, no decision. Without this the UPDATE below writes a null
  -- decided_by and trips the decision-complete constraint, surfacing a raw
  -- Postgres error where a sentence belongs.
  if me is null then
    return 'not signed in';
  end if;

  select * into req from account_requests where id = p_request_id for update;
  if not found then
    return 'not found';
  end if;
  if req.status <> 'pending' then
    return 'already ' || req.status;
  end if;
  -- Approving your own request defeats the point of having an approver.
  if req.requested_by = me then
    return 'you cannot decide your own request';
  end if;

  update account_requests
     set status = case when p_approve then 'approved' else 'denied' end,
         decided_by = me,
         decided_at = now(),
         decision_note = p_note
   where id = p_request_id;

  if not p_approve then
    return 'denied';
  end if;

  -- Transaction-local, and read by the ownership trigger above. Scoped to this
  -- one request so an approval cannot become a general licence to reassign.
  perform set_config('megaforce.applying_request', p_request_id::text, true);

  if req.kind in ('amnesty','extension') then
    update accounts
       set retention_override_until = now() + make_interval(days => coalesce(req.days, 30)),
           updated_at = now()
     where id = req.account_id;

  elsif req.kind = 'national' then
    update accounts
       set national_account = true,
           national_account_in_review = false,
           national_account_approved_by = me,
           national_account_approved_at = now(),
           updated_at = now()
     where id = req.account_id;

  elsif req.kind = 'release' then
    update accounts
       set owner_id = null,
           released_at = now(),
           last_release_reason = 'manual',
           retention_override_until = null,
           updated_at = now()
     where id = req.account_id;

  elsif req.kind = 'transfer' then
    update accounts
       set owner_id = req.transfer_to,
           claimed_at = now(),
           retention_override_until = null,
           updated_at = now()
     where id = req.account_id;
  end if;

  return 'approved';
end $$ language plpgsql;

-- ---------------------------------------------------------------------------
-- Rebuild the view, now carrying the override and the open request count.
-- ---------------------------------------------------------------------------
create view accounts_with_state
with (security_invoker = true) as
select
  a.*,
  account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at, a.retention_override_until)     as state,
  account_days_left(a.owner_id, a.status, a.last_activity_at, a.claimed_at, a.retention_override_until) as days_left,
  u.full_name                                                               as owner_name,
  u.email                                                                   as owner_email,
  u.location                                                                as owner_location,
  ad.full_name                                                              as ad_owner_name,
  p.name                                                                    as parent_account_name,
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
left join accounts p on p.id = a.parent_account_id;

comment on view accounts_with_state is
  'Accounts with their lifecycle state computed. Runs as the caller, so row level security applies.';

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant select on accounts_with_state to %I', r);
      execute format('grant select, insert, update on account_requests to %I', r);
      execute format('grant execute on function decide_account_request(uuid, boolean, text) to %I', r);
    end if;
  end loop;
end $$;
