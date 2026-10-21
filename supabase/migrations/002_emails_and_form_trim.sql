-- 002_emails_and_form_trim.sql
-- 1. Remembers which coauthor emails have been told they're listed on a paper,
--    so the submission-email function notifies each coauthor once, not on every edit.
-- 2. Drops the form questions James removed (Oct 21, 2026): JEL codes, keywords,
--    discussant / chair / reviewer volunteering, days attending, conflicts of interest.
--    (Presenters are expected to attend all three days.)
-- Run once in Supabase: SQL Editor → New query → paste this file → Run.

alter table public.submissions
  drop column jel_codes,
  drop column keywords,
  drop column willing_discussant,
  drop column willing_chair,
  drop column willing_review,
  drop column attendance,
  drop column conflicts,
  add column notified_coauthors text[] not null default '{}';  -- lowercased emails

-- Authors can read this column (table-level select grant from 001) but not set it:
-- it is left out of the insert/update column grants, so only the function
-- (running with the service role) writes it.

-- Recording a notice isn't an edit: keep "last updated" at the author's own save.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.notified_coauthors is distinct from old.notified_coauthors
     and (to_jsonb(new) - 'notified_coauthors') = (to_jsonb(old) - 'notified_coauthors') then
    return new;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
