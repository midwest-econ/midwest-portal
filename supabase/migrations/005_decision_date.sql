-- 005_decision_date.sql
-- The date authors hear whether their paper is on the program, shown under Key dates
-- on the Submit a Paper page. Meeting admins set it in Settings, like the deadline.
-- Run once in Supabase: SQL Editor → New query → paste this file → Run.

alter table public.meetings add column decisions_on date;   -- null = not shown

update public.meetings set decisions_on = '2027-01-30' where id = 'spring2027';

grant update (decisions_on) on public.meetings to authenticated;
