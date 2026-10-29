-- 008: test reviewers for the demo meeting, kept apart from the real ones (James, Oct 29, 2026).
-- Run once in Supabase -> SQL Editor.
--
-- A reviewer is either real or a test reviewer (demo = true). Real meetings' papers go
-- only to real reviewers and the demo meeting's only to test reviewers; the database
-- refuses anything else, so testing in the demo can't email the real committee. Someone
-- who organizes only the demo meeting sees only the test reviewers.

alter table public.reviewers add column demo boolean not null default false;

-- Every reviewer so far is a test address. Those with papers at a real meeting (the early
-- tests at Spring 2027) stay real until that test data is deleted; the rest become test
-- reviewers.
update public.reviewers r set demo = true
where not exists (
  select 1 from public.assignments a
  join public.submissions s on s.id = a.submission_id
  join public.meetings m on m.id = s.meeting_id
  where a.reviewer_id = r.id and not m.demo
);

-- Papers and reviewers must match in program (as before) and in demo or real.
create or replace function public.check_assignment_program()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select program from public.submissions where id = new.submission_id)
     is distinct from (select program from public.reviewers where id = new.reviewer_id) then
    raise exception 'This reviewer reviews a different program';
  end if;
  if (select m.demo from public.submissions s join public.meetings m on m.id = s.meeting_id
      where s.id = new.submission_id)
     is distinct from (select demo from public.reviewers where id = new.reviewer_id) then
    raise exception 'Demo papers go only to test reviewers, and real papers only to real reviewers';
  end if;
  return new;
end;
$$;

-- A reviewer stays real or test for good.
create function public.keep_reviewer_demo()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.demo is distinct from old.demo then
    raise exception 'A reviewer can''t move between the demo and the real meetings';
  end if;
  return new;
end;
$$;

create trigger reviewers_keep_demo
before update of demo on public.reviewers
for each row execute function public.keep_reviewer_demo();

-- Does the signed-in person organize this program at a real meeting (or at every meeting)?
create function public.organizes_real_program(prog text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organizers o
    where o.user_id = auth.uid() and o.program = prog
      and (o.meeting_id is null
           or exists (select 1 from public.meetings m where m.id = o.meeting_id and not m.demo))
  );
$$;

drop policy "organizers manage their program's reviewers" on public.reviewers;
create policy "organizers manage their program's reviewers"
  on public.reviewers for all
  to authenticated
  using (public.organizes_program(program) and (demo or public.organizes_real_program(program)))
  with check (public.organizes_program(program) and (demo or public.organizes_real_program(program)));
