-- 0013_clock_resets_on_release.sql
--
-- The clock resets when an account falls out of somebody's name.
--
-- account_state() already half-honoured this: it judges from
-- greatest(last_activity_at, claimed_at), so a new holder is measured from
-- their claim date rather than inheriting the previous owner's neglect. The
-- FLAG was therefore right.
--
-- Everything else derived from last_activity_at was wrong, because the column
-- itself was never cleared:
--
--   * the list's "Last counted" column showed the previous owner's date, so a
--     freshly claimed account rendered a green flag beside "62d ago" in red
--   * the "quiet for 30/60/90 days" filters matched accounts nobody has had
--     time to work
--   * "Never worked" excluded exactly the accounts that, for their new holder,
--     have never been worked
--   * the dashboard and reports counted all of the above
--
-- One column, four screens disagreeing with each other. Clearing it on the
-- ownership change makes the flag, the filters and the numbers say the same
-- thing.
--
-- What is NOT cleared: the activities themselves. Every call and email stays on
-- the record, and last_communicated_at in the view still reports them, so the
-- new holder can read the history of the company they just picked up. Only the
-- pointer the clock reads is reset. The history is evidence; the clock is a
-- rule, and the rule starts again.

create or replace function reset_clock_on_owner_change() returns trigger as $$
begin
  if new.owner_id is not distinct from old.owner_id then
    return new;
  end if;

  -- Released to the pool, reassigned, or transferred through an approved
  -- request -- all three are the account falling out of somebody's name.
  new.last_activity_at := null;

  -- Amnesty does not travel with the account. It was granted to a person for
  -- their reasons; the next holder gets the ordinary clock.
  new.retention_override_until := null;

  return new;
end $$ language plpgsql;

-- BEFORE UPDATE, so the new values are written in the same statement rather
-- than as a second write that could be interleaved or missed.
--
-- Runs alongside t_accounts_track_claim, which is also BEFORE UPDATE OF
-- owner_id. Postgres fires same-timing triggers in name order, so this one goes
-- first; both only assign to NEW, and neither reads what the other sets, so the
-- order does not matter -- but it is worth knowing it is fixed rather than
-- arbitrary.
drop trigger if exists t_accounts_reset_clock on accounts;
create trigger t_accounts_reset_clock before update of owner_id on accounts
  for each row execute function reset_clock_on_owner_change();

-- Bring existing rows in line. An account sitting in the pool right now still
-- carries the last holder's activity date, and would hand it to whoever claims
-- it next.
update accounts
   set last_activity_at = null,
       retention_override_until = null
 where owner_id is null
   and (last_activity_at is not null or retention_override_until is not null);
