-- 0034_live_calls.sql
--
-- A call that is happening RIGHT NOW.
--
-- ===========================================================================
--   "it needs to always be loaded and connected ring central. If I make a call
--    right now it needs to show there even if the person has not even picked
--    up. with a live second counter."
--
-- WHY THIS CANNOT BE A ROW IN activities
--
-- An activity is a thing that HAPPENED. It has a duration, a result, and a
-- verdict about whether it counted. None of those exist while a phone is still
-- ringing, and inventing them -- duration 0, result "unknown", qualifies false
-- -- would put a row on a company's timeline for a call that may never connect
-- at all. Worse, the qualifier would judge it, and a broker would watch their
-- own call arrive already marked as not counting.
--
-- So a live call is a separate, temporary thing, and it stays separate until
-- RingCentral's own call log says how it ended. Then the call log becomes the
-- activity and this row is finished with.
--
-- WHY IT CANNOT RIDE ON raw_events EITHER
--
-- raw_events deduplicates on (source, external_id), which is exactly right for
-- a call log record -- the same completed call delivered twice must land once.
-- A telephony session fires repeatedly for ONE call, though: Setup, then
-- Proceeding, then Answered, then Disconnected, every one of them carrying the
-- SAME telephonySessionId. Pushed through that door, the first event would be
-- stored and every state change after it silently dropped as a duplicate. The
-- call would appear as "ringing" and stay that way forever.
--
-- Here the session id is the PRIMARY KEY and each event overwrites the last,
-- which is the opposite rule and the correct one for a thing that changes.
-- ===========================================================================

create table if not exists live_calls (
  /* RingCentral's id for the whole conversation, across every state change.
     Primary key rather than unique, because there is exactly one current state
     per call and the newest event replaces whatever came before it. */
  telephony_session_id text primary key,

  /* Which handset. Kept verbatim even when it matches no CRM user, so an
     unrecognised extension can be diagnosed rather than guessed at. */
  extension_id         text,
  user_id              uuid references users(id) on delete set null,

  counterparty_number  text,
  counterparty_name    text,
  our_number           text,
  direction            text,

  /* ringing -> answered -> ended. Nothing else; a broker does not need
     RingCentral's fifteen party states, they need to know whether the phone is
     still ringing and how long they have been talking. */
  state                text not null default 'ringing',
  /* The provider's own word for how it finished, when it has finished. */
  result               text,

  /* Resolved on write so the dock does not do a phone-number lookup per poll. */
  account_id           uuid references accounts(id) on delete set null,
  contact_id           uuid references contacts(id) on delete set null,

  started_at           timestamptz not null default now(),
  /* When the other person picked up. The second counter runs from here, not
     from started_at -- counting ring time as talk time would overstate every
     call against a policy that turns on sixty seconds. */
  answered_at          timestamptz,
  ended_at             timestamptz,
  updated_at           timestamptz not null default now()
);

create index if not exists live_calls_user_idx on live_calls(user_id, started_at desc);
create index if not exists live_calls_open_idx on live_calls(started_at desc) where ended_at is null;

-- ---------------------------------------------------------------------------
-- Which handset made an activity
--
-- unmatched_activities has carried this since 0033; activities never has, and
-- the omission is why a mis-credited call could not be put right. A call from
-- an unrecognised extension is credited to whoever OWNS the account -- a
-- deliberate fallback, so the call is not lost -- but with the extension thrown
-- away, there is afterwards no way to tell that row apart from one genuinely
-- made by the owner. Mapping the extension later then fixes nothing, because
-- nothing records which calls were affected.
--
-- Nullable and staying that way: a manually logged call has no extension, and
-- neither does an email.
-- ---------------------------------------------------------------------------
alter table activities add column if not exists extension_id text;
create index if not exists activities_extension_idx on activities(extension_id)
  where extension_id is not null;

-- Read it back out of the payload for calls already recorded, exactly as 0033
-- did for the review queue. The same two shapes, because RingCentral puts the
-- extension in a different place depending on the event.
update activities a
   set extension_id = coalesce(
         r.payload #>> '{body,changes,0,newRecords,0,extension,id}',
         r.payload #>> '{body,parties,0,extensionId}'
       )
  from raw_events r
 where r.id = a.raw_event_id
   and a.extension_id is null;

-- ---------------------------------------------------------------------------
-- Who may see one
--
-- Their own calls, and nobody else's.
--
-- Asked and answered: "Every person only ever sees calls from their own
-- extension. Managers included -- they would use Reports for oversight instead
-- of the dock." A live call is somebody picking up a phone, and a dock that
-- shows a manager who each of their brokers is talking to right now is
-- surveillance rather than a phone. Reports show the work; this shows the call
-- you are on.
--
-- A call from an extension nobody has claimed therefore appears to NOBODY here.
-- That is deliberate and it is not silent: the dock says so in words, and
-- points at the screen where an extension gets attached to a person.
-- ---------------------------------------------------------------------------
alter table live_calls enable row level security;

drop policy if exists live_calls_read on live_calls;
create policy live_calls_read on live_calls for select
  using ((select signed_in()) and user_id = (select current_user_id()));

/**
 * Attach an extension to a person, and give them back the calls they made.
 *
 * ---------------------------------------------------------------------------
 * The first thing anybody has to do after connecting a phone system, and the
 * one that is easiest to leave undone -- because nothing breaks visibly. Calls
 * still arrive. They are simply credited to whoever owns the account instead of
 * whoever made the call, which looks completely correct on every screen and
 * quietly corrupts every leaderboard and every commission argument.
 *
 * Doing it by hand is worse than doing it here: the extension must be typed
 * into a user record from another browser tab, forty times, and a typo credits
 * one broker's calls to another.
 *
 * The backfill is the part that matters. Somebody who connects the phone on
 * Friday and maps the extensions on Monday would otherwise have three days of
 * calls attributed to the wrong people, permanently. This walks back through
 * everything that extension produced and puts it right:
 *
 *   live_calls           -- so the dock stops being empty
 *   unmatched_activities -- so their unattributed calls appear in their dock
 *   activities           -- but ONLY where nobody wrote it up, because a call
 *                           somebody has already logged has a human's judgement
 *                           attached and reassigning it would erase that.
 *
 * SECURITY DEFINER because it writes to users and activities, which a broker
 * cannot. The guard is the first statement, not the caller.
 */
create or replace function claim_extension(p_user_id uuid, p_extension text)
returns table (live int, queued int, logged int)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_live int := 0;
  v_queued int := 0;
  v_logged int := 0;
begin
  if (select current_user_role()) is distinct from 'admin' then
    raise exception 'only an administrator can attach an extension to somebody';
  end if;

  if p_extension is null or btrim(p_extension) = '' then
    raise exception 'an extension is required';
  end if;

  -- One extension, one person. Taking it from somebody else is allowed -- it is
  -- how a leaver's handset is reassigned -- but it cannot be held by two.
  update users set rc_extension_id = null
   where rc_extension_id = btrim(p_extension) and id <> p_user_id;

  update users set rc_extension_id = btrim(p_extension) where id = p_user_id;

  update live_calls set user_id = p_user_id
   where extension_id = btrim(p_extension) and user_id is distinct from p_user_id;
  get diagnostics v_live = row_count;

  update unmatched_activities set user_id = p_user_id
   where extension_id = btrim(p_extension)
     and resolved_at is null
     and user_id is distinct from p_user_id;
  get diagnostics v_queued = row_count;

  update activities set user_id = p_user_id
   where extension_id = btrim(p_extension)
     and logged_at is null
     and user_id is distinct from p_user_id;
  get diagnostics v_logged = row_count;

  return query select v_live, v_queued, v_logged;
end;
$$;

revoke all on function claim_extension(uuid, text) from public;

do $$
declare r text;
begin
  foreach r in array array['authenticated','service_role','anon'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('grant execute on function claim_extension(uuid, text) to %I', r);
      execute format('grant select on live_calls to %I', r);
    end if;
  end loop;
end $$;

notify pgrst, 'reload schema';
