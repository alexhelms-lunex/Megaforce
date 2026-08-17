-- 0025_credit_requests.sql
--
-- Asking Credit for a limit, and the screen Credit works from.
--
-- ===========================================================================
-- WHY
--
-- Customer Credit is a role in this application with no work in it. They can
-- see every account and edit any limit, and there is nothing anywhere that
-- tells them WHICH limit somebody is waiting on. In practice that conversation
-- happens on the phone or in email, and the CRM records only the outcome --
-- so nobody can answer "how long does credit take", and a broker whose deal is
-- blocked has no way to escalate except to ask again.
--
-- Alex, on what the credit dashboard is for: "For customer credit the main
-- focus is credit increase requests and setting up credit."
--
-- So a credit limit becomes a request like every other exception in this
-- system: raised by the person who needs it, queued, decided by the role that
-- owns the decision, and recorded with a reason.
--
-- WHY IT REUSES account_requests
--
-- Amnesty, extensions, transfers and national promotions already live there,
-- with a decision trigger, row level security, a notification and a history
-- panel on the account. A separate credit_requests table would need all five
-- again, and would then be the one queue that behaves slightly differently.
-- ===========================================================================

-- The limit being asked for. Nullable, because the other five kinds have no
-- amount and never will.
alter table account_requests
  add column if not exists amount numeric(14,2);

comment on column account_requests.amount is
  'The credit limit being requested, in dollars. Only meaningful for kind = ''credit''.';

/*
 * Widen the kinds.
 *
 * Dropped and re-added rather than edited: a check constraint cannot be
 * altered in place. Guarded so re-running this file is safe, and so a database
 * that already has credit requests in it is not briefly left unconstrained.
 */
do $$
begin
  if exists (
    select 1 from pg_constraint
     where conname = 'account_requests_kind_check'
       and pg_get_constraintdef(oid) not like '%credit%'
  ) then
    alter table account_requests drop constraint account_requests_kind_check;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'account_requests_kind_check'
  ) then
    alter table account_requests
      add constraint account_requests_kind_check
      check (kind in ('amnesty','extension','national','release','transfer','credit'));
  end if;
end $$;

/**
 * A credit request is decided by Credit, not by a manager.
 *
 * Every other kind goes to the requester's management chain. This one does not:
 * a manager approving their own broker's credit limit is the entire reason the
 * credit function exists separately. decide_request() checks the chain, so this
 * adds the one exception rather than loosening the rule for everybody.
 */
create or replace function may_decide_request(p_request_id uuid)
returns boolean as $$
  select case
    when (select current_user_role()) = 'admin' then true
    when (select kind from account_requests where id = p_request_id) = 'credit'
      then (select current_user_role()) = 'credit'
    else exists (
      select 1 from account_requests r
       where r.id = p_request_id
         and r.requested_by in (select visible_user_ids())
         and r.requested_by <> (select current_user_id())
    )
  end
$$ language sql stable security definer set search_path = public, auth;

/**
 * What Credit is looking at today.
 *
 * One call rather than six, because this is the first thing that renders on
 * their home screen and six sequential round trips is most of a second before
 * anything appears.
 */
create or replace function dashboard_credit()
returns table (
  pending_credit bigint,
  pending_credit_value numeric,
  oldest_pending_days int,
  decided_30d bigint,
  approved_30d bigint,
  duplicates_open bigint,
  customers_without_limit bigint,
  total_exposure numeric,
  accounts_at_limit bigint
) as $$
  select
    (select count(*) from account_requests where kind = 'credit' and status = 'pending'),
    (select coalesce(sum(amount), 0) from account_requests where kind = 'credit' and status = 'pending'),
    (select coalesce(max(extract(day from now() - created_at))::int, 0)
       from account_requests where kind = 'credit' and status = 'pending'),
    (select count(*) from account_requests
      where kind = 'credit' and status <> 'pending' and decided_at > now() - interval '30 days'),
    (select count(*) from account_requests
      where kind = 'credit' and status = 'approved' and decided_at > now() - interval '30 days'),
    (select count(*) from accounts where locked_to_credit),
    -- A customer with no limit is the gap that matters: they are being shipped
    -- for with nothing agreed behind it.
    (select count(*) from accounts where status = 'customer' and credit_limit is null),
    (select coalesce(sum(credit_limit), 0) from accounts where credit_limit is not null),
    (select count(*) from accounts where credit_limit is not null and credit_limit > 0
       and status = 'customer')
$$ language sql stable security definer set search_path = public, auth;

/**
 * The queue itself, oldest first.
 *
 * Oldest first and not newest: this is a work queue, and a work queue sorted
 * newest first is one where the thing somebody has been waiting a fortnight for
 * is on page three.
 */
create or replace function credit_queue(p_limit int default 25)
returns table (
  request_id uuid,
  account_id uuid,
  account_name text,
  billing_city text,
  billing_state text,
  current_limit numeric,
  requested_amount numeric,
  reason text,
  requested_by_name text,
  owner_name text,
  created_at timestamptz,
  waiting_days int
) as $$
  select
    r.id, a.id, a.name, a.billing_city, a.billing_state,
    a.credit_limit, r.amount, r.reason,
    u.full_name, o.full_name,
    r.created_at,
    extract(day from now() - r.created_at)::int
    from account_requests r
    join accounts a on a.id = r.account_id
    left join users u on u.id = r.requested_by
    left join users o on o.id = a.owner_id
   where r.kind = 'credit' and r.status = 'pending'
     and (select current_user_role()) in ('credit','admin')
   order by r.created_at
   limit greatest(1, least(coalesce(p_limit, 25), 200))
$$ language sql stable security definer set search_path = public, auth;

/**
 * Customers being shipped for with no agreed limit.
 *
 * The other half of Credit's job, and the half nobody raises a request for --
 * an account quietly becomes a customer and no limit is ever set. Nothing
 * surfaces that today, so it is invisible until it is a bad debt.
 */
create or replace function credit_gaps(p_limit int default 25)
returns table (
  account_id uuid,
  account_name text,
  billing_city text,
  billing_state text,
  owner_name text,
  became_customer timestamptz,
  activity_90d bigint
) as $$
  select
    a.id, a.name, a.billing_city, a.billing_state, o.full_name,
    a.updated_at,
    (select count(*) from activities act
      where act.account_id = a.id and act.occurred_at > now() - interval '90 days')
    from accounts a
    left join users o on o.id = a.owner_id
   where a.status = 'customer'
     and a.credit_limit is null
     and (select current_user_role()) in ('credit','admin')
   order by a.updated_at desc
   limit greatest(1, least(coalesce(p_limit, 25), 200))
$$ language sql stable security definer set search_path = public, auth;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function may_decide_request(uuid) to %I', r);
      execute format('grant execute on function dashboard_credit() to %I', r);
      execute format('grant execute on function credit_queue(int) to %I', r);
      execute format('grant execute on function credit_gaps(int) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ===========================================================================
-- Deciding one.
--
-- Rewritten rather than patched, because the credit case differs in two places
-- that are ten lines apart: who may decide it, and what approving it does.
-- ===========================================================================

create or replace function decide_account_request(
  p_request_id uuid,
  p_approve boolean,
  p_note text default null
) returns text as $$
declare
  req account_requests%rowtype;
  me uuid := (select current_user_id());
begin
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
  if req.requested_by = me then
    return 'you cannot decide your own request';
  end if;

  /*
   * A credit request is Credit's to decide, and nobody else's.
   *
   * Every other kind goes to the requester's management chain, which row level
   * security already scopes. This one deliberately leaves that chain: a manager
   * approving their own broker's credit limit is the whole reason the credit
   * function is separate from sales in the first place.
   */
  if req.kind = 'credit'
     and (select current_user_role()) not in ('credit','admin') then
    return 'only customer credit can decide a credit limit';
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

  elsif req.kind = 'credit' then
    -- The amount is the decision. Approving without one would set a limit of
    -- null, which reads on every screen as "no limit agreed" -- the exact state
    -- the request existed to end.
    if req.amount is null then
      raise exception 'A credit request cannot be approved without an amount.'
        using errcode = 'check_violation';
    end if;
    update accounts
       set credit_limit = req.amount,
           updated_at = now()
     where id = req.account_id;
  end if;

  return 'approved';
end $$ language plpgsql security invoker set search_path = public, auth;

notify pgrst, 'reload schema';
