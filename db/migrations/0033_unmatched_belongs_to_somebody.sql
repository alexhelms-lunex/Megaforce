-- 0033_unmatched_belongs_to_somebody.sql
--
-- A call that matched nothing is still somebody's call.
--
-- ===========================================================================
--   "I want it to see all calls connected to the ring central account live,
--    within our ring central tab. Even calls to number not in the CRM."
--
-- WHY THE DOCK COULD NOT DO THAT
--
-- A call arriving from RingCentral takes one of two roads. If its number is on
-- a contact record it becomes an activity, credited to whoever made it, and
-- appears in that person's dock. If it is not -- a new prospect, a number typed
-- into a mobile, a company nobody has entered yet -- it goes to
-- unmatched_activities instead.
--
-- And unmatched_activities has never recorded WHO. It stores the number, the
-- direction, the duration and the result, and nothing at all about the
-- extension the call came from. There was no way to ask "show me my unmatched
-- calls", because the row does not know it is anybody's.
--
-- So every call to somebody not yet in the CRM disappeared from the broker's
-- view entirely and surfaced only in a manager-only review queue. That is
-- exactly backwards: the person who just made the call is the one person who
-- knows who it was with, and they were the only person who could not see it.
--
-- WHAT THIS ADDS
--
--   extension_id  what RingCentral said the call came from, kept verbatim even
--                 when it matches nobody -- so an unrecognised extension can be
--                 diagnosed later rather than being lost.
--   user_id       the CRM user that extension belongs to, when there is one.
--
-- Both are nullable and both stay nullable. An extension nobody has claimed is
-- a real and common state -- it is the state this system is in the first time
-- anybody connects a phone -- and forcing a value would mean inventing one.
-- ===========================================================================

alter table unmatched_activities add column if not exists extension_id text;
alter table unmatched_activities add column if not exists user_id uuid references users(id);

-- The dock's query: one person's open items, newest first. Partial, because the
-- dock never reads resolved rows and the table keeps a year of them behind it.
create index if not exists unmatched_user_open_idx
  on unmatched_activities(user_id, occurred_at desc) where resolved_at is null;

-- ---------------------------------------------------------------------------
-- Who may see one
--
-- Before this, only managers, credit and admins -- the review queue's audience.
-- Now also the person who made the call, which is the whole point: they are the
-- only one who knows who it was with.
--
-- A call whose extension matches nobody stays with the triage roles. It has to
-- go somewhere, and "nobody" is not a somewhere -- an orphan call that appears
-- in no dock at all is the failure this migration exists to end.
-- ---------------------------------------------------------------------------
drop policy if exists unmatched_read on unmatched_activities;
create policy unmatched_read on unmatched_activities for select
  using (
    (select signed_in())
    and (
      (select current_user_role()) in ('manager','credit','admin')
      or user_id = (select current_user_id())
    )
  );

drop policy if exists unmatched_resolve on unmatched_activities;
create policy unmatched_resolve on unmatched_activities for update
  using (
    (select signed_in())
    and (
      (select current_user_role()) in ('manager','credit','admin')
      or user_id = (select current_user_id())
    )
  )
  with check (
    (select signed_in())
    and (
      (select current_user_role()) in ('manager','credit','admin')
      or user_id = (select current_user_id())
    )
  );

/**
 * Fill in the extension for calls already in the queue.
 *
 * The extension is sitting in the raw payload of every one of them -- it always
 * was, it simply was never copied out. Reading it back means the calls that
 * arrived before this migration appear in the right dock rather than staying
 * invisible to the person who made them.
 *
 * Two shapes, because RingCentral puts it in a different place depending on the
 * event: on the call log record for a Call Log Sync notification, and on the
 * party for a telephony session. Both are tried; a payload with neither is left
 * alone rather than guessed at.
 */
update unmatched_activities u
   set extension_id = coalesce(
         r.payload #>> '{body,changes,0,newRecords,0,extension,id}',
         r.payload #>> '{body,parties,0,extensionId}'
       )
  from raw_events r
 where r.id = u.raw_event_id
   and u.extension_id is null
   and u.resolved_at is null;

update unmatched_activities u
   set user_id = x.id
  from users x
 where x.rc_extension_id = u.extension_id
   and u.user_id is null
   and u.extension_id is not null
   and u.resolved_at is null;

notify pgrst, 'reload schema';
