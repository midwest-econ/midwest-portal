-- 007: a demo meeting for trying the portal with test papers (James, Oct 28, 2026).
-- Run once in Supabase -> SQL Editor.
--
-- The Submit a Paper page ignores demo meetings unless the address names one:
--   https://portal.midwesttradetheory.org/?meeting=demo
-- Organizers pick it from the Meeting menu (or organizer.html?meeting=demo). Emails
-- about a demo meeting are real but their subjects start with "[Demo]".
-- Removing it (and its test papers) is in the README, "Deleting the demo meeting".

alter table public.meetings add column demo boolean not null default false;

insert into public.meetings (id, name, host, location, submissions_open, demo)
values ('demo', 'Demo', 'Demo', 'Test papers only', true, true);
