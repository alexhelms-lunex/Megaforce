-- 0028_manager_full_visibility.sql
--
-- A manager can open any account in the company.
--
-- ===========================================================================
-- ALEX, ASKED DIRECTLY
--
--   Q: does a manager see (A) their own reports' accounts, or (B) every
--      account in the company?
--   A: "The answer is B for you question."
--
-- So the ownership lock applies to brokers and account directors. It does not
-- apply to managers.
--
-- WHAT THIS WIDENS, AND WHAT IT DELIBERATELY DOES NOT
--
-- READING an account and everything in it -- contacts, calls, notes, pipeline,
-- credit -- becomes company-wide for a manager. That is what was asked for, and
-- because contacts, activities and opportunities are each gated by an EXISTS
-- against the account row, they follow from this one policy without needing
-- policies of their own.
--
-- EVERYTHING ELSE STAYS WHERE IT WAS, and none of it is an oversight:
--
--   EDITING an account is still limited to a manager's own reporting line.
--     "Full visibility" is what was asked for. A manager quietly renaming or
--     restatusing an account in another branch of the company is not visibility,
--     it is a second person editing somebody else's record with no trail
--     leading back to why.
--
--   REASSIGNING an owner is unchanged. Taking an account off its holder is
--     still a transfer request decided by somebody else, and 0027's narrow
--     assignment exception still only reaches an AD's account inside their own
--     line. A manager who could move any account anywhere would make the
--     transfer process optional.
--
--   is_privileged() is untouched, so managers still cannot edit users, delete
--     accounts, or change the qualification rules and the clock. Those are
--     admin powers and this is a visibility question.
--
--   The dashboard and reports still measure a manager's OWN reporting line.
--     "Tracking the brokers" means their brokers; a leaderboard containing the
--     whole company is a different screen, and turning every manager's numbers
--     into company numbers overnight would be a surprise rather than a feature.
--     Say the word and it is a one-line change.
-- ===========================================================================

/**
 * Managers read the whole book.
 *
 * A separate policy rather than widening visible_user_ids(), and that choice is
 * load-bearing. visible_user_ids() is used by the UPDATE policies, by the
 * dashboard, by reports and by the request queue -- widening it there would
 * silently hand managers write access to every account in the company and
 * rewrite every number on their dashboard, neither of which was asked for.
 *
 * Postgres ORs permissive policies together, so this only ever adds.
 */
drop policy if exists accounts_read_manager on accounts;
create policy accounts_read_manager on accounts for select
  using ((select current_user_role()) = 'manager');

/**
 * And the directory has to agree with them.
 *
 * account_is_open() and the SELECT policies are two separate pieces of SQL
 * saying the same thing. The moment they drift, a screen offers an Open button
 * that 404s, or says "held by somebody else" over an account that opens
 * perfectly. account-locks.test.ts asserts they agree for every account and
 * every role, which is why this clause is not optional.
 */
create or replace function account_is_open(
  p_owner_id uuid,
  p_ad_owner_id uuid,
  p_locked_to_credit boolean
) returns boolean as $$
  select
    -- The available pool. Unclaimed means unowned means everybody's to read.
    p_owner_id is null
    -- Your own book, and everyone reporting to you, however far down.
    or p_owner_id in (select visible_user_ids())
    -- An account director sees the national accounts they co-own, even though
    -- the broker running it is nowhere near their reporting line.
    or (p_ad_owner_id is not null and p_ad_owner_id = (select current_user_id()))
    -- Credit and admin are outside the hierarchy on purpose.
    or (select is_privileged())
    -- And managers, who are not restricted by the ownership lock at all.
    or (select current_user_role()) = 'manager'
    -- A flagged duplicate is visible to everybody, which 0016 argues at length:
    -- an invisible one gets typed in again next week by a third person.
    or coalesce(p_locked_to_credit, false)
$$ language sql stable security definer set search_path = public, auth;

notify pgrst, 'reload schema';

-- ===========================================================================
-- And the screens that describe the rules have to describe the new ones.
--
-- /admin/roles reads these tables. A capability matrix that still says a
-- manager sees "their own book plus everyone reporting to them" is worse than
-- no matrix -- it is the place somebody goes to check, and it would be wrong.
-- ===========================================================================

create or replace function role_catalogue()
returns table (key text, label text, summary text, sort int) as $$
  select * from (values
    ('broker',  'Broker',
     'Holds a book of prospects and customers. Sees their own accounts and nobody else''s.', 1),
    ('manager', 'Manager',
     'Holds their own book like anybody else, and can open any account in the company — the ownership lock does not apply to them. They edit and decide requests within their own reporting line.', 2),
    ('ad',      'Account Director',
     'Opens national accounts and co-owns them: a broker runs the account day to day and the AD takes a share. Sees their own book, the accounts they co-own, and anyone reporting to them.', 3),
    ('credit',  'Customer Credit',
     'Sees every account in the company. Owns credit limits and the duplicate queue, and holds no book of their own.', 4),
    ('admin',   'Admin',
     'Everything, including the rules the company runs on: the clock, the qualification rules, users and integrations.', 5)
  ) as t(key, label, summary, sort)
$$ language sql immutable;

/*
 * The matrix, with the rows this round changed and the rows it added.
 *
 * Rewritten in full rather than patched, because a capability matrix assembled
 * from fragments across four migrations is one nobody can read end to end --
 * and this table exists to BE read. Every row 0021 carried is still here; two
 * changed and five are new.
 *
 * Dropped and recreated rather than replaced: `create or replace function`
 * cannot change a return type, and 0021 already had to drop this one once for
 * exactly that reason.
 */
drop function if exists role_capabilities();

create function role_capabilities()
returns table (
  capability text, area text,
  broker boolean, manager boolean, ad boolean, credit boolean, admin boolean,
  detail text
) as $$
  select * from (values
    ('Hold their own book of accounts', 'Accounts', true, true, true, false, true,
     'A manager and an AD own accounts exactly like a broker does. Only customer credit holds none.'),
    ('See their own accounts', 'Accounts', true, true, true, true, true,
     'Everyone sees what they hold.'),
    ('Open an account somebody else holds', 'Accounts', false, true, false, true, true,
     'The ownership lock. A broker or an AD sees a colleague''s account in the directory — name, address, industry and who holds it — and nothing inside it. Managers, credit and admins are not restricted.'),
    ('Find any company in the directory', 'Accounts', true, true, true, true, true,
     'Everybody, always. Name, address, industry and holder, so nobody spends a fortnight prospecting a company a colleague is already working.'),
    ('See the accounts of people who report to them', 'Accounts', false, true, true, true, true,
     'Follows the reporting line, however many levels down. It is not a team or a pool — it is their own book plus everyone beneath them.'),
    ('See accounts they co-own as Account Director', 'Accounts', false, false, true, true, true,
     'A national account has a broker running it and an AD on it. Both see it; the broker''s clock is the one that runs.'),
    ('See every account in the company', 'Accounts', false, true, false, true, true,
     'Managers, credit and admins are outside the ownership lock. Brokers and account directors are not.'),
    ('Edit an account outside their own book', 'Accounts', false, true, true, true, true,
     'Within their reporting line. A manager can OPEN any account in the company but only EDIT within their line — a manager quietly renaming an account in another branch is not visibility.'),
    ('Claim from the available pool', 'Accounts', true, true, true, true, true,
     'Anyone can take an unclaimed account. First click wins.'),
    ('Release their own accounts', 'Accounts', true, true, true, true, true,
     'You can always hand back what you hold.'),
    ('Release somebody else''s account', 'Accounts', false, false, false, true, true,
     'A manager cannot take an account off a broker directly — that is a transfer request, so there is a record of who asked and who agreed.'),
    ('Add a broker to an Account Director''s account', 'Accounts', false, true, false, false, true,
     'A manager puts the broker who will run a national account onto it, within their own reporting line. The AD stays on as account director. It does not work on an ordinary broker''s account — that is a transfer request.'),
    ('Create accounts', 'Accounts', true, true, true, true, true,
     'Anyone can, but a duplicate name, address or phone number is flagged into credit''s name automatically.'),
    ('Create a known duplicate', 'Accounts', false, false, false, true, true,
     'Only credit and admins may deliberately create a second record for the same company.'),
    ('Edit an account flagged as a duplicate', 'Accounts', false, false, false, true, true,
     'A flagged record is locked to credit until they decide which one is real.'),
    ('Set credit limits', 'Credit', false, false, false, true, true,
     'Credit status and limits come from Salesforce and are maintained by customer credit.'),
    ('Ask for a credit limit', 'Credit', true, true, true, false, true,
     'Anybody holding the account can ask, and the amount is part of the ask. It goes to Customer Credit, not to their manager.'),
    ('Decide a credit limit', 'Credit', false, false, false, true, true,
     'Customer Credit only. A manager approving their own broker''s limit is the reason the credit function exists separately from sales.'),
    ('Log calls and activities', 'Activity', true, true, true, true, true,
     'Everyone logs their own work.'),
    ('Resolve the review queue', 'Activity', true, true, true, true, true,
     'Anyone can attribute an unmatched call, because whoever recognises the number should be able to fix it.'),
    ('Raise an account request', 'Requests', true, true, true, true, true,
     'Amnesty, extension, transfer, early release, promotion to national, or a credit limit.'),
    ('Decide a request', 'Requests', false, true, false, true, true,
     'Somebody above the person asking. An AD does not decide requests — co-owning an account is not authority over the person running it. Nobody can approve their own, including an admin.'),
    ('See reports beyond their own figures', 'Reports', false, true, true, true, true,
     'A broker sees their own. A manager and an AD see the people beneath them. Credit and admins see everything.'),
    ('Change the retention thresholds', 'Administration', false, false, false, false, true,
     'The clock everybody lives by. Admin only, and the change applies everywhere at once.'),
    ('Change what counts as approved activity', 'Administration', false, false, false, false, true,
     'The qualification rules. Admin only, for the same reason.'),
    ('Add, edit and deactivate users', 'Administration', false, false, false, false, true,
     'Admin only. The last active administrator cannot be demoted or deactivated by anybody, including themselves.'),
    ('Manage integrations and email', 'Administration', false, false, false, false, true,
     'RingCentral, the mail connection and the digest schedule.')
  ) as t(capability, area, broker, manager, ad, credit, admin, detail)
$$ language sql immutable;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function role_catalogue() to %I', r);
      execute format('grant execute on function role_capabilities() to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';

-- ===========================================================================
-- Reports still mean "my team", not "everything I can now see".
--
-- report_window, report_series and report_breakdown scoped themselves by
-- letting row level security do it: `from accounts` with no owner filter, and
-- whatever came back was the team. That was correct while a manager could only
-- see their own reporting line.
--
-- The policy above changes what comes back. Left alone, every figure on a
-- manager's Reports screen would silently become a company figure while still
-- being labelled "team" -- their call count, their approval rate, their
-- leaderboard position, all quietly measuring people who do not report to them.
-- Nobody asked for that, and a number that changes meaning without changing its
-- label is the worst kind of wrong.
--
-- So 'team' now says what it means: the caller's reporting line. For credit and
-- admin, visible_user_ids() already returns everybody, so their reports are
-- unchanged. Only the nine scoping predicates differ from 0019 -- the bodies
-- are copied verbatim rather than retyped, so the two cannot drift.
-- ===========================================================================

create or replace function report_window(
  p_from date,
  p_to date,
  p_scope text default 'team'
) returns table (
  metric text,
  value numeric,
  previous numeric
) as $$
declare
  span int := greatest(1, (p_to - p_from) + 1);
  prev_from date := p_from - span;
  prev_to date := p_from - 1;
begin
  return query
  with bounds as (
    select p_from::timestamptz as cur_from,
           (p_to + 1)::timestamptz as cur_to,
           prev_from::timestamptz as pre_from,
           (prev_to + 1)::timestamptz as pre_to
  ),
  act as (
    select a.occurred_at, a.type, a.qualifies
      from activities a
      join accounts ac on ac.id = a.account_id
     where (case p_scope when 'mine' then ac.owner_id = (select current_user_id()) else ac.owner_id in (select visible_user_ids()) end)
  ),
  clm as (
    select c.claimed_at, c.released_at, c.release_reason
      from account_claims c
      join accounts ac on ac.id = c.account_id
     where (case p_scope when 'mine' then c.user_id = (select current_user_id()) else c.user_id in (select visible_user_ids()) end)
  ),
  con as (
    select c.created_at
      from contacts c
      join accounts ac on ac.id = c.account_id
     where (case p_scope when 'mine' then ac.owner_id = (select current_user_id()) else ac.owner_id in (select visible_user_ids()) end)
  ),
  held as (
    select count(*) as n
      from accounts ac
     where ac.owner_id is not null
       and (case p_scope when 'mine' then ac.owner_id = (select current_user_id()) else ac.owner_id in (select visible_user_ids()) end)
  )
  select * from (
    select 'calls'::text,
           (select count(*) from act, bounds
             where type = 'call' and occurred_at >= cur_from and occurred_at < cur_to)::numeric,
           (select count(*) from act, bounds
             where type = 'call' and occurred_at >= pre_from and occurred_at < pre_to)::numeric
    union all
    select 'approved',
           (select count(*) from act, bounds
             where report_is_counted(qualifies) and occurred_at >= cur_from and occurred_at < cur_to)::numeric,
           (select count(*) from act, bounds
             where report_is_counted(qualifies) and occurred_at >= pre_from and occurred_at < pre_to)::numeric
    union all
    select 'emails',
           (select count(*) from act, bounds
             where type = 'email' and occurred_at >= cur_from and occurred_at < cur_to)::numeric,
           (select count(*) from act, bounds
             where type = 'email' and occurred_at >= pre_from and occurred_at < pre_to)::numeric
    union all
    select 'claimed',
           (select count(*) from clm, bounds
             where claimed_at >= cur_from and claimed_at < cur_to)::numeric,
           (select count(*) from clm, bounds
             where claimed_at >= pre_from and claimed_at < pre_to)::numeric
    union all
    select 'released',
           (select count(*) from clm, bounds
             where released_at >= cur_from and released_at < cur_to)::numeric,
           (select count(*) from clm, bounds
             where released_at >= pre_from and released_at < pre_to)::numeric
    union all
    -- Lost to the clock, as distinct from handed back. The difference between
    -- these two is the difference between a process problem and a choice.
    select 'lost',
           (select count(*) from clm, bounds
             where released_at >= cur_from and released_at < cur_to and release_reason = 'expired')::numeric,
           (select count(*) from clm, bounds
             where released_at >= pre_from and released_at < pre_to and release_reason = 'expired')::numeric
    union all
    select 'contacts_added',
           (select count(*) from con, bounds
             where created_at >= cur_from and created_at < cur_to)::numeric,
           (select count(*) from con, bounds
             where created_at >= pre_from and created_at < pre_to)::numeric
    union all
    -- A snapshot, not a window figure. Shown without a delta on the screen for
    -- exactly that reason: "accounts held last week" is not a thing this can
    -- know without a history table, and inventing it would be worse than
    -- leaving the comparison off.
    select 'accounts_held', (select n from held)::numeric, null::numeric
  ) as t(metric, value, previous);
end $$ language plpgsql stable;

create or replace function report_series(
  p_from date,
  p_to date,
  p_scope text default 'team',
  p_grain text default 'day'
) returns table (
  bucket date,
  calls bigint,
  approved bigint,
  emails bigint,
  claimed bigint,
  lost bigint
) as $$
  with buckets as (
    select generate_series(
             date_trunc(case when p_grain = 'week' then 'week' else 'day' end, p_from::timestamptz),
             p_to::timestamptz,
             case when p_grain = 'week' then interval '1 week' else interval '1 day' end
           )::date as bucket
  ),
  act as (
    select date_trunc(case when p_grain = 'week' then 'week' else 'day' end, a.occurred_at)::date as bucket,
           a.type, a.qualifies
      from activities a
      join accounts ac on ac.id = a.account_id
     where a.occurred_at >= p_from::timestamptz
       and a.occurred_at < (p_to + 1)::timestamptz
       and (case p_scope when 'mine' then ac.owner_id = (select current_user_id()) else ac.owner_id in (select visible_user_ids()) end)
  ),
  clm as (
    select date_trunc(case when p_grain = 'week' then 'week' else 'day' end, c.claimed_at)::date as claim_bucket,
           date_trunc(case when p_grain = 'week' then 'week' else 'day' end, c.released_at)::date as release_bucket,
           c.release_reason
      from account_claims c
      join accounts ac on ac.id = c.account_id
     where (case p_scope when 'mine' then c.user_id = (select current_user_id()) else c.user_id in (select visible_user_ids()) end)
  )
  select b.bucket,
         coalesce((select count(*) from act where act.bucket = b.bucket and act.type = 'call'), 0),
         coalesce((select count(*) from act where act.bucket = b.bucket and report_is_counted(act.qualifies)), 0),
         coalesce((select count(*) from act where act.bucket = b.bucket and act.type = 'email'), 0),
         coalesce((select count(*) from clm where clm.claim_bucket = b.bucket), 0),
         coalesce((select count(*) from clm where clm.release_bucket = b.bucket and clm.release_reason = 'expired'), 0)
    from buckets b
   order by b.bucket
$$ language sql stable;

create or replace function report_breakdown(
  p_from date,
  p_to date,
  p_scope text default 'team',
  p_dimension text default 'broker',
  p_search text default '',
  p_limit int default 25,
  p_offset int default 0
) returns table (
  key text,
  label text,
  calls bigint,
  approved bigint,
  hit_rate numeric,
  accounts bigint,
  claimed bigint,
  lost bigint,
  total_rows bigint
) as $$
  with act as (
    select
      case p_dimension
        when 'broker'   then coalesce(au.full_name, 'Unattributed')
        when 'branch'   then coalesce(au.location, 'No branch set')
        when 'industry' then coalesce(ac.industry, 'Not set')
        when 'state'    then coalesce(upper(ac.billing_state), 'Not set')
        when 'status'   then coalesce(ac.status, 'Not set')
        when 'stage'    then coalesce(ac.stage, 'Not set')
        when 'type'     then coalesce(a.type, 'Not set')
        when 'direction' then coalesce(a.direction, 'Not set')
        else 'All'
      end as k,
      a.type, a.qualifies
    from activities a
    join accounts ac on ac.id = a.account_id
    left join users au on au.id = a.user_id
   where a.occurred_at >= p_from::timestamptz
     and a.occurred_at < (p_to + 1)::timestamptz
     and (case p_scope when 'mine' then ac.owner_id = (select current_user_id()) else ac.owner_id in (select visible_user_ids()) end)
  ),
  act_agg as (
    select k,
           count(*) filter (where type = 'call') as calls,
           count(*) filter (where report_is_counted(qualifies)) as approved
      from act group by k
  ),
  acc as (
    select
      case p_dimension
        when 'broker'   then coalesce(ou.full_name, 'Unclaimed')
        when 'branch'   then coalesce(ou.location, 'No branch set')
        when 'industry' then coalesce(ac.industry, 'Not set')
        when 'state'    then coalesce(upper(ac.billing_state), 'Not set')
        when 'status'   then coalesce(ac.status, 'Not set')
        when 'stage'    then coalesce(ac.stage, 'Not set')
        when 'release_reason' then coalesce(ac.last_release_reason, 'Never released')
        else 'All'
      end as k,
      ac.id
    from accounts ac
    left join users ou on ou.id = ac.owner_id
   where (case p_scope when 'mine' then ac.owner_id = (select current_user_id()) else ac.owner_id in (select visible_user_ids()) end)
  ),
  acc_agg as (
    select k, count(*) as accounts from acc group by k
  ),
  clm as (
    select
      case p_dimension
        when 'broker'   then coalesce(cu.full_name, 'Unattributed')
        when 'branch'   then coalesce(cu.location, 'No branch set')
        when 'industry' then coalesce(ac.industry, 'Not set')
        when 'state'    then coalesce(upper(ac.billing_state), 'Not set')
        when 'status'   then coalesce(ac.status, 'Not set')
        when 'stage'    then coalesce(ac.stage, 'Not set')
        when 'release_reason' then coalesce(c.release_reason, 'Still held')
        else 'All'
      end as k,
      c.claimed_at, c.released_at, c.release_reason
    from account_claims c
    join accounts ac on ac.id = c.account_id
    left join users cu on cu.id = c.user_id
   where (case p_scope when 'mine' then c.user_id = (select current_user_id()) else c.user_id in (select visible_user_ids()) end)
  ),
  clm_agg as (
    select k,
           count(*) filter (
             where claimed_at >= p_from::timestamptz and claimed_at < (p_to + 1)::timestamptz
           ) as claimed,
           count(*) filter (
             where released_at >= p_from::timestamptz and released_at < (p_to + 1)::timestamptz
               and release_reason = 'expired'
           ) as lost
      from clm group by k
  ),
  merged as (
    select coalesce(a.k, b.k, c.k) as k,
           coalesce(a.calls, 0) as calls,
           coalesce(a.approved, 0) as approved,
           coalesce(b.accounts, 0) as accounts,
           coalesce(c.claimed, 0) as claimed,
           coalesce(c.lost, 0) as lost
      from act_agg a
      full join acc_agg b on b.k = a.k
      full join clm_agg c on c.k = coalesce(a.k, b.k)
  ),
  filtered as (
    select * from merged
     where coalesce(p_search, '') = '' or k ilike '%' || p_search || '%'
  ),
  counted as (
    select *, count(*) over () as total_rows from filtered
  )
  select k,
         k as label,
         calls,
         approved,
         case when calls = 0 then 0 else round(approved::numeric * 100 / calls, 1) end,
         accounts,
         claimed,
         lost,
         total_rows
    from counted
   -- Ordered by counted calls rather than raw volume. Volume rewards short
   -- calls; this rewards the ones that moved a clock. Accounts break the tie so
   -- a broker with no calls this period still appears in a sensible place.
   order by approved desc, calls desc, accounts desc, k
   limit greatest(1, least(p_limit, 200))
  offset greatest(0, p_offset)
$$ language sql stable;

notify pgrst, 'reload schema';
