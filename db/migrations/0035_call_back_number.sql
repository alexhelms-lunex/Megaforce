-- 0035_call_back_number.sql
--
-- The number that actually rings when somebody presses Call.
--
-- ===========================================================================
--   "Ok so it rung out according to the ring central app. However, my phone
--    never got the call."
--
-- WHY CLICK-TO-CALL RANG NOBODY
--
-- RingOut works in two legs: RingCentral calls YOU first, and when you pick up
-- it dials the customer. The number it calls first was the extension's own
-- RingCentral direct number -- which routes straight back into RingCentral and
-- rings whatever device that extension is registered to. If that is a desk
-- phone nobody has, or an app nobody is signed into, the leg rings out and dies
-- after a few seconds.
--
-- Which is exactly what RingCentral's own log showed: a run of three, nine,
-- thirteen and fourteen second calls, from Alex to Alex, none of which reached
-- a phone he was holding.
--
-- A CRM cannot fix somebody's answering rules, and should not try. What it can
-- do is stop assuming the RingCentral extension is the best way to reach a
-- person, because usually it is not -- a mobile is.
--
-- Nullable, and the fallback chain is unchanged behind it: this number, then
-- the extension's direct number, then the main company number. Somebody who
-- never fills it in is exactly where they were.
-- ===========================================================================

alter table users add column if not exists call_back_number text;

comment on column users.call_back_number is
  'E.164. The handset RingOut rings first when this person presses Call. Their mobile, usually.';

notify pgrst, 'reload schema';
