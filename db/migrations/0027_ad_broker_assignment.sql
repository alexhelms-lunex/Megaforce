-- 0027_ad_broker_assignment.sql
--
-- Putting a broker on an account an Account Director opened, and adding the
-- industry to the directory.
--
-- ===========================================================================
-- ALEX, ON BOTH
--
--   "Managers have full visibility. Brokers and AD's are the ones with
--    restrictions. However, AD's and brokers can co own accounts if you
--    remember, but this is rare. So if an account is owned by an AD a manager
--    will have to add the broker to assign them."
--
--   "Brokers can see the industry"
--
-- THE ASSIGNMENT
--
-- An Account Director opens a national account and holds it. Somebody has to
-- run it day to day, and that is a broker -- but nothing in the application
-- could put one there. The ownership trigger refuses any owner change by
-- somebody who is not an admin, deliberately, because that rule is what stops a
-- broker helping themselves to a colleague's book.
--
-- So this is a narrow, named exception rather than a loosening of the rule:
--
--   only a manager or an admin may call it
--   only onto an account currently held by an ACCOUNT DIRECTOR, or by nobody
--   the broker must be somebody the caller can already see
--
-- A manager still cannot take an account off another broker. That remains a
-- transfer request, decided by somebody else, exactly as before.
--
-- The AD does not lose the account. They move to ad_owner_id and keep seeing
-- it -- that is what co-ownership means here, and it is why the column exists.
-- The clock starts on the broker, because the broker is now the one working it.
-- ===========================================================================

/**
 * The trigger gains one more trusted path.
 *
 * Written the same way as the request-approval bypass above it: a
 * transaction-local setting naming the exact account, so an assignment cannot
 * become a general licence to reassign anything else in the same transaction.
 */
create or replace function enforce_owner_reassignment() returns trigger as $$
declare
  actor uuid;
  actor_role text;
  applying uuid;
  assigning uuid;
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

  -- A manager putting a broker onto an account an AD opened. Scoped to the one
  -- account by id, so it authorises exactly the row it was set for.
  assigning := nullif(current_setting('megaforce.assigning_broker', true), '')::uuid;
  if assigning is not null and assigning = new.id then
    return new;
  end if;

  raise exception 'This account belongs to another broker. Only an admin can reassign it.'
    using errcode = '42501';
end $$ language plpgsql security definer set search_path = public, auth;

/**
 * Put a broker on an account, keeping the Account Director on it.
 *
 * Returns a sentence rather than raising, so the screen can show it. The one
 * case that raises is a caller with no business here at all -- everything else
 * is a refusal somebody needs to read.
 */
create or replace function assign_broker_to_account(p_account_id uuid, p_broker uuid)
returns text as $$
declare
  me uuid := (select current_user_id());
  my_role text;
  acct accounts%rowtype;
  broker_role text;
begin
  if me is null then
    return 'not signed in';
  end if;

  select role into my_role from users where id = me;
  if my_role not in ('manager', 'admin') then
    return 'Only a manager or an administrator can assign a broker.';
  end if;

  select * into acct from accounts where id = p_account_id for update;
  if not found then
    return 'That account no longer exists.';
  end if;

  select role into broker_role from users where id = p_broker and active;
  if broker_role is null then
    return 'That person is not here any more.';
  end if;
  if broker_role not in ('broker', 'manager', 'ad') then
    return 'Only somebody who holds a book can run an account.';
  end if;

  /*
   * A manager may only reach inside their own reporting line.
   *
   * Without this, any manager could hand any account to any person in the
   * company -- which is a bigger power than "add a broker to a national
   * account" and not the one being asked for. An admin is exempt because an
   * admin is exempt from everything by design.
   */
  if my_role = 'manager' and p_broker not in (select visible_user_ids()) then
    return 'You can only assign somebody who reports to you.';
  end if;

  -- Before the ownership check below, not after it. Assigning somebody who is
  -- already on the account is a no-op, and reporting it as "raise a transfer
  -- request" -- which is what happened when these two were the other way round
  -- -- sends somebody to fill in a form for a change that has already been made.
  if acct.owner_id = p_broker then
    return 'They already hold it.';
  end if;

  -- The narrow case, and the whole point of the function. Anything else is a
  -- transfer, which is a request somebody else decides.
  if acct.owner_id is not null then
    if (select role from users where id = acct.owner_id) <> 'ad' then
      return
        'That account already belongs to a broker. Raise a transfer request instead — '
        || 'somebody other than you has to approve taking an account off its holder.';
    end if;
  end if;

  -- Transaction-local and scoped to this one account id.
  perform set_config('megaforce.assigning_broker', p_account_id::text, true);

  update accounts
     set owner_id = p_broker,
         -- The AD stays on it. Losing the account is not what "add a broker"
         -- means, and ad_owner_id is the column that exists to say so.
         ad_owner_id = coalesce(acct.owner_id, acct.ad_owner_id),
         claimed_at = now(),
         released_at = null,
         last_release_reason = null,
         retention_override_until = null,
         updated_at = now()
   where id = p_account_id;

  if not found then
    return 'The database refused the change. Nothing was assigned.';
  end if;

  return 'ok';
end $$ language plpgsql security definer set search_path = public, auth;

-- ===========================================================================
-- The industry, in the directory.
--
-- Left out of 0024 on a literal reading of "name, address and owner". Alex:
-- "Brokers can see the industry" -- and it is the one field that makes the
-- search useful for filtering rather than only for lookup.
--
-- It is also not proprietary in the way the rest is: an industry is a fact
-- about the company that anybody can read off their website, not something a
-- broker discovered.
-- ===========================================================================

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
  industry text,
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
  with matched as (
    select
      a.id, a.name, a.industry,
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
        or a.industry ilike '%' || p_search || '%'
      )
       and (coalesce(p_state, '') = '' or a.billing_state = p_state)
       and (
        p_scope <> 'locked'
        or not account_is_open(a.owner_id, a.ad_owner_id, a.locked_to_credit)
       )
       and (p_scope <> 'available' or a.owner_id is null)
       -- Signed in, or nothing. This function is SECURITY DEFINER and granted
       -- to `anon`, so without this clause the publishable key -- which ships
       -- in the browser bundle on purpose -- would enumerate the whole book.
       and (select current_user_id()) is not null
  )
  select m.*, (select count(*) from matched) as total_rows
    from matched m
   order by m.can_open desc, m.available desc, m.name
   limit greatest(1, least(coalesce(p_limit, 50), 200))
  offset greatest(0, coalesce(p_offset, 0))
$$ language sql stable security definer set search_path = public, auth;

drop function if exists account_directory_one(uuid);

create function account_directory_one(p_id uuid)
returns table (
  id uuid,
  name text,
  industry text,
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
  held_since timestamptz
) as $$
  select
    a.id, a.name, a.industry,
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
     and (select current_user_id()) is not null
$$ language sql stable security definer set search_path = public, auth;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function account_directory(text, text, text, int, int) to %I', r);
      execute format('grant execute on function account_directory_one(uuid) to %I', r);
      execute format('grant execute on function assign_broker_to_account(uuid, uuid) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
