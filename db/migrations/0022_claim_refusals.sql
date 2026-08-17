-- 0022_claim_refusals.sql
--
-- Tell somebody who beat them to an account.
--
-- ===========================================================================
-- WHY
--
-- Two brokers press Claim on the same account. One wins. The loser was told:
--
--     "That account no longer exists."
--
-- It does exist. It is simply not visible to them any more -- the moment the
-- winner took it, row level security scoped it to the winner's reporting line,
-- and the losing broker's read came back empty. The action could not tell
-- "gone" apart from "not yours to see", so it guessed, and it guessed wrong in
-- the case that actually happens.
--
-- That message is worse than unhelpful. A broker who is told an account does
-- not exist concludes the system is broken, and the next thing they do is ask
-- somebody to look into it.
--
-- This returns the holder's name for one account, running as the owner of the
-- function so the lookup is not subject to the caller's own visibility. It
-- gives away nothing that is not already public within the company: every
-- screen in the application shows colleague names, and users_read admits any
-- signed-in user to the users table for exactly that reason.
--
-- Deliberately narrow. It takes one account id and returns one name -- not a
-- row, not a book, not a way to enumerate anything.
-- ===========================================================================

create or replace function account_holder_name(p_account_id uuid)
returns text as $$
  select u.full_name
    from accounts a
    left join users u on u.id = a.owner_id
   where a.id = p_account_id
$$ language sql stable security definer set search_path = public, auth;

comment on function account_holder_name(uuid) is
  'The name of whoever currently holds an account, regardless of the caller''s '
  'visibility. Exists so a lost claim can say who won rather than claiming the '
  'account does not exist.';

/**
 * Does this account exist at all?
 *
 * Separate from the name, because "no owner" and "no account" both come back as
 * null from the function above and they are different refusals: one means
 * somebody released it a second ago and you may try again, the other means it
 * has been deleted.
 */
create or replace function account_exists(p_account_id uuid)
returns boolean as $$
  select exists (select 1 from accounts where id = p_account_id)
$$ language sql stable security definer set search_path = public, auth;

do $$
declare r text;
begin
  foreach r in array array['authenticated','anon','app_user'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function account_holder_name(uuid) to %I', r);
      execute format('grant execute on function account_exists(uuid) to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
