-- 0021_account_director_role.sql
--
-- Account Director becomes a role, and "team" stops being a word this system
-- uses.
--
-- ===========================================================================
-- WHY
--
-- The floor is four kinds of person: brokers, managers, Account Directors, and
-- customer credit. Three of those had a role and the fourth did not, so an AD
-- was being recorded as a broker or a manager and neither is true.
--
-- The AD is not a tier above a broker. It is a different job: they open
-- national accounts and take a share of the commission while a broker runs the
-- account day to day, which is why accounts already carry ad_owner_id
-- separately from owner_id. Giving them "manager" to get the visibility they
-- need also gave them the power to decide other people's account requests,
-- which is not their job.
--
-- ---------------------------------------------------------------------------
-- AND THERE ARE NO TEAMS.
--
-- The word appeared on the dashboard, in the reports scope toggle and through
-- the capability descriptions, and it was wrong in a way that mattered.
-- Nothing in this system is a team: there is a reporting line, and a manager
-- has their OWN book on top of it. "Team accounts" read as a pooled figure
-- belonging to a group, when it is one person's accounts plus the accounts of
-- everyone who reports to them.
--
-- The visibility model does not change here -- only what it is called, and the
-- fact that an AD now has a name of its own.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- The role itself
-- ---------------------------------------------------------------------------

alter table users drop constraint if exists users_role_check;
alter table users add constraint users_role_check
  check (role in ('broker', 'manager', 'ad', 'credit', 'admin'));

comment on column users.role is
  'broker | manager | ad | credit | admin. An Account Director (ad) opens national '
  'accounts and co-owns them with the broker running them day to day.';

/**
 * Roles the admin screens will accept.
 *
 * Rewritten rather than edited, because admin_set_role() validated against a
 * hard-coded list of four and would have gone on refusing 'ad' with "Unknown
 * role" no matter what the constraint allowed.
 */
create or replace function admin_set_role(p_user uuid, p_role text) returns void as $$
begin
  if (select current_user_role()) <> 'admin' then
    raise exception 'Only an administrator can change a role.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_role not in ('broker', 'manager', 'ad', 'credit', 'admin') then
    raise exception 'Unknown role: %', p_role using errcode = 'check_violation';
  end if;

  if p_user = (select current_user_id()) and p_role <> 'admin' then
    raise exception 'You cannot remove your own administrator role. Ask another admin.'
      using errcode = 'check_violation';
  end if;

  update users set role = p_role where id = p_user;
end $$ language plpgsql security definer set search_path = public, auth;

-- ---------------------------------------------------------------------------
-- What an AD can see
-- ---------------------------------------------------------------------------

/**
 * An Account Director sees the accounts they co-own, on top of their own book
 * and their reporting line.
 *
 * Not the whole company. An AD is not credit; they should see the national
 * accounts they opened and the people beneath them, and nothing else. The
 * existing recursion already gives them their own line -- this adds the
 * accounts where they are the ad_owner but somebody else is the owner.
 *
 * Written as a separate policy rather than by widening accounts_read, because
 * a policy that names one situation is a policy somebody can read and check.
 * Postgres ORs multiple permissive policies together, so this only ever adds.
 */
drop policy if exists accounts_read_ad on accounts;
create policy accounts_read_ad on accounts for select
  using (
    ad_owner_id is not null
    and ad_owner_id = (select current_user_id())
  );

-- ---------------------------------------------------------------------------
-- The catalogue, with an AD in it and the word "team" gone
-- ---------------------------------------------------------------------------

create or replace function role_catalogue()
returns table (key text, label text, summary text, sort int) as $$
  select * from (values
    ('broker',  'Broker',
     'Holds a book of prospects and customers. Sees their own accounts and nobody else''s.', 1),
    ('manager', 'Manager',
     'Holds their own book like anybody else, and additionally sees the accounts of everyone who reports to them. They decide those people''s account requests.', 2),
    ('ad',      'Account Director',
     'Opens national accounts and co-owns them: a broker runs the account day to day and the AD takes a share. Sees their own book, the accounts they co-own, and anyone reporting to them.', 3),
    ('credit',  'Customer Credit',
     'Sees every account in the company. Owns credit limits and the duplicate queue, and holds no book of their own.', 4),
    ('admin',   'Admin',
     'Everything, including the rules the company runs on: the clock, the qualification rules, users and integrations.', 5)
  ) as t(key, label, summary, sort)
$$ language sql immutable;

-- Dropped rather than replaced: the matrix gains an `ad` column, and
-- `create or replace` refuses to change a function's return type. Idempotent,
-- so re-running this file is safe.
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
    ('See the accounts of people who report to them', 'Accounts', false, true, true, true, true,
     'Follows the reporting line, however many levels down. It is not a team or a pool — it is their own book plus everyone beneath them.'),
    ('See accounts they co-own as Account Director', 'Accounts', false, false, true, true, true,
     'A national account has a broker running it and an AD on it. Both see it; the broker''s clock is the one that runs.'),
    ('See every account in the company', 'Accounts', false, false, false, true, true,
     'Credit and admins are outside the reporting line, so they get the whole book rather than a branch of it.'),
    ('Claim from the available pool', 'Accounts', true, true, true, true, true,
     'Anyone can take an unclaimed account. First click wins.'),
    ('Release their own accounts', 'Accounts', true, true, true, true, true,
     'You can always hand back what you hold.'),
    ('Release somebody else''s account', 'Accounts', false, false, false, true, true,
     'A manager cannot take an account off a broker directly — that is a transfer request, so there is a record of who asked and who agreed.'),
    ('Create accounts', 'Accounts', true, true, true, true, true,
     'Anyone can, but a duplicate name, address or phone number is flagged into credit''s name automatically.'),
    ('Create a known duplicate', 'Accounts', false, false, false, true, true,
     'Only credit and admins may deliberately create a second record for the same company.'),
    ('Edit an account flagged as a duplicate', 'Accounts', false, false, false, true, true,
     'A flagged record is locked to credit until they decide which one is real.'),
    ('Set credit limits', 'Credit', false, false, false, true, true,
     'Credit status and limits come from Salesforce and are maintained by customer credit.'),
    ('Log calls and activities', 'Activity', true, true, true, true, true,
     'Everyone logs their own work.'),
    ('Resolve the review queue', 'Activity', true, true, true, true, true,
     'Anyone can attribute an unmatched call, because whoever recognises the number should be able to fix it.'),
    ('Raise an account request', 'Requests', true, true, true, true, true,
     'Amnesty, extension, transfer, early release or promotion to national.'),
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
      execute format('grant execute on function role_capabilities() to %I', r);
      execute format('grant execute on function role_catalogue() to %I', r);
      execute format('grant execute on function admin_set_role(uuid, text) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
