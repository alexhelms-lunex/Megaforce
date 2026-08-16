-- 0008_call_logging.sql
--
-- The RingCentral dock, and the policy rules it enforces.
--
-- Two things the prospecting policy says that the build had wrong or missing:
--
--   1. A qualifying call is **60 seconds**, not 120. The shipped threshold
--      rejected every call between 60 and 119 seconds, so a broker who did the
--      work lost the account anyway. That is the worst direction for this
--      system to be wrong in, and it is fixed here.
--
--   2. "Brokers must choose a stage outcome ... in order for the call to be
--      saved correctly." A call is therefore NOT an approved activity until it
--      has been logged with an outcome. Duration alone is not enough.

-- ---------------------------------------------------------------------------
-- Stage
--
-- The sales pipeline, separate from status. Status is the lifecycle
-- (prospect / customer / inactive); stage is how far along the sale is.
-- The five values are the same ones the dock offers as call outcomes, because
-- they are the same field -- logging a call is what advances the stage.
-- ---------------------------------------------------------------------------
-- The accounts_with_state view selects a.* , so adding a column to accounts
-- changes its shape. Dropped here and recreated at the bottom of this file;
-- leaving it in place makes this migration fail on a database where 0007 has
-- already run, which is every database that is not brand new.
drop view if exists accounts_with_state;

alter table accounts add column if not exists stage text not null default 'Lead';

alter table accounts drop constraint if exists accounts_stage_check;
alter table accounts add constraint accounts_stage_check
  check (stage in ('Lead','Contact','Pitch','Quote','Closed'));

create index if not exists accounts_stage_idx on accounts(stage);

-- ---------------------------------------------------------------------------
-- Contact type
--
-- The policy's approved sales-contact list. It is load-bearing rather than
-- decorative: an email only counts as activity when it went to a contact on
-- file, so this list is what makes activity verifiable.
-- ---------------------------------------------------------------------------
alter table contacts add column if not exists type text;

alter table contacts drop constraint if exists contacts_type_check;
alter table contacts add constraint contacts_type_check
  check (type is null or type in (
    'Owner',
    'C Suite Level',
    'Director of Supply Chain / Logistics',
    'Procurement',
    'Carrier Relations',
    '4PL Logistics Manager',
    'Logistics Manager',
    'Logistics Coordinator',
    'Logistics Operations',
    'Sales',
    'Buyer / Purchasing',
    'Other'
  ));

-- Several contacts legitimately share one phone number -- a switchboard, with
-- different extensions or email addresses behind it, and sometimes rows that
-- are identical in every visible field. The dock has to offer all of them and
-- let the broker pick, so nothing here tries to deduplicate.
create index if not exists contacts_phone_account_idx
  on contacts(phone_e164, account_id) where phone_e164 is not null;

-- ---------------------------------------------------------------------------
-- Logging a call
--
-- What the broker fills in on the dock. All four are mandatory, and the
-- constraint below is what makes "mandatory" true rather than merely asked for
-- politely by a form.
-- ---------------------------------------------------------------------------
alter table activities add column if not exists stage_outcome text;
alter table activities add column if not exists notes text;
alter table activities add column if not exists logged_by uuid references users(id);
alter table activities add column if not exists logged_at timestamptz;

alter table activities drop constraint if exists activities_stage_outcome_check;
alter table activities add constraint activities_stage_outcome_check
  check (stage_outcome is null or stage_outcome in ('Lead','Contact','Pitch','Quote','Closed'));

-- A logged call carries every mandatory field or none of them. Half-filled
-- rows are how a "required" field quietly stops being required.
alter table activities drop constraint if exists activities_log_complete;
alter table activities add constraint activities_log_complete
  check (
    logged_at is null
    or (stage_outcome is not null and notes is not null and length(btrim(notes)) > 0
        and logged_by is not null and account_id is not null)
  );

create index if not exists activities_unlogged_idx
  on activities(occurred_at desc) where logged_at is null and type = 'call';

-- ---------------------------------------------------------------------------
-- Qualification rules: 60 seconds, and an outcome is required
-- ---------------------------------------------------------------------------
alter table qualification_rules add column if not exists requires_outcome boolean not null default false;

update qualification_rules
   set min_duration_seconds = 60,
       requires_outcome = true,
       updated_at = now()
 where activity_type = 'call' and active;

-- ---------------------------------------------------------------------------
-- Advancing the stage
--
-- Logging a call with an outcome moves the account to that stage. Done here
-- rather than in application code so the account and its activity history
-- cannot disagree -- whatever route the log took, the stage follows.
--
-- Deliberately not a downgrade: an account already at Quote is not dragged
-- back to Contact by a routine follow-up call. Stages advance; they do not
-- regress on their own.
-- ---------------------------------------------------------------------------
create or replace function stage_rank(p_stage text) returns int as $$
  select case p_stage
    when 'Lead' then 0 when 'Contact' then 1 when 'Pitch' then 2
    when 'Quote' then 3 when 'Closed' then 4 else -1 end
$$ language sql immutable;

create or replace function advance_account_stage() returns trigger as $$
begin
  if new.stage_outcome is null or new.account_id is null then
    return new;
  end if;

  update accounts
     set stage = new.stage_outcome,
         updated_at = now()
   where id = new.account_id
     and stage_rank(new.stage_outcome) > stage_rank(stage);

  return new;
end $$ language plpgsql;

drop trigger if exists t_activities_advance_stage on activities;
create trigger t_activities_advance_stage after insert or update of stage_outcome on activities
  for each row execute function advance_account_stage();

-- ---------------------------------------------------------------------------
-- Companies whose contacts hold a given number.
--
-- Backs the dock's Company dropdown. Returns every candidate rather than
-- guessing at one, because a number really can sit at two customers and the
-- broker on the call knows which one they just spoke to. Resolving ambiguity
-- at the moment of the call beats queueing it for somebody who was not there.
-- ---------------------------------------------------------------------------
create or replace function accounts_for_phone(p_phone text)
returns table (account_id uuid, account_name text, contact_count bigint) as $$
  select a.id, a.name, count(c.id)
    from accounts a
    join contacts c on c.account_id = a.id
   where c.phone_e164 = p_phone
   group by a.id, a.name
   order by a.name
$$ language sql stable;

-- ---------------------------------------------------------------------------
-- last_activity_at has to move when a call is LOGGED, not only when captured
--
-- The original trigger fired on INSERT only, which was right when a call
-- qualified the moment it arrived. It no longer does: a call now becomes an
-- approved activity when a broker writes it up, and that is an UPDATE.
--
-- Left alone, last_activity_at would never move for a captured call. Every
-- account would drift toward expiry while its broker was diligently logging
-- everything -- the system silently punishing exactly the behaviour it exists
-- to encourage, with nothing on screen to explain it.
--
-- Guarded on the transition rather than the value, so re-saving a log does not
-- keep pushing the clock forward.
-- ---------------------------------------------------------------------------
drop trigger if exists t_bump_last_activity_update on activities;
create trigger t_bump_last_activity_update after update of qualifies on activities
  for each row when (new.qualifies and not old.qualifies)
  execute function bump_last_activity();

-- ---------------------------------------------------------------------------
-- Rebuild accounts_with_state, now carrying stage.
--
-- Identical to 0007 apart from picking up the new column through a.* . It lives
-- here rather than being edited into 0007 so each migration remains a complete,
-- runnable description of the change it makes.
-- ---------------------------------------------------------------------------
create view accounts_with_state
with (security_invoker = true) as
select
  a.*,
  account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at)      as state,
  account_days_left(a.owner_id, a.status, a.last_activity_at, a.claimed_at)  as days_left,
  u.full_name                                                                as owner_name,
  u.email                                                                    as owner_email,
  case account_state(a.owner_id, a.status, a.last_activity_at, a.claimed_at)
    when 'overdue'   then 0
    when 'expiring'  then 1
    when 'warning'   then 2
    when 'fresh'     then 3
    when 'available' then 4
    else 5
  end                                                                        as urgency
from accounts a
left join users u on u.id = a.owner_id;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant select on accounts_with_state to %I', r);
    end if;
  end loop;
end $$;
