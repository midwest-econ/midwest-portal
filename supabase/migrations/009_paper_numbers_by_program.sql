-- 009: paper numbers count within each program (James, Oct 29, 2026).
-- Run once in Supabase -> SQL Editor.
--
-- Trade papers are IT1, IT2, ... (International Trade) and Theory papers ET1, ET2, ...
-- (Economic Theory), each from 1 at every meeting. The database keeps the number; the
-- pages add the letters. Existing papers are renumbered in their old order.
--
-- An author who moves a paper to the other program gets that program's next number.
-- Once a paper has a reviewer its program can't change, since reviewers review one program.

alter table public.submissions drop constraint submissions_paper_no_key;

create or replace function public.number_submission()
returns trigger
language plpgsql
security definer          -- must see every submission to find the next number
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' then
    if new.program is not distinct from old.program then
      return new;
    end if;
    if exists (select 1 from public.assignments where submission_id = new.id) then
      raise exception 'This paper already has a reviewer, so its program can''t change. Please write to mwittconference@utk.edu.';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtext('paper_no:' || new.meeting_id || ':' || new.program));
  select coalesce(max(paper_no), 0) + 1 into new.paper_no
  from public.submissions
  where meeting_id = new.meeting_id and program = new.program and id is distinct from new.id;
  return new;
end;
$$;

drop trigger submissions_number on public.submissions;
create trigger submissions_number
before insert or update of program on public.submissions
for each row execute function public.number_submission();

-- Renumber what's there. Only rows whose number changes are updated, and a number
-- change doesn't count as an author's edit, so "Last edited" stays as it was.
with numbered as (
  select id, row_number() over (partition by meeting_id, program order by paper_no) as n
  from public.submissions
)
update public.submissions s set paper_no = numbered.n
from numbered where s.id = numbered.id and s.paper_no <> numbered.n;

alter table public.submissions
  add constraint submissions_paper_no_key unique (meeting_id, program, paper_no);
