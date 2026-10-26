-- 003_review.sql
-- Reviewing, with Trade and Theory kept completely apart.
--   * Organizers belong to a program (Trade or Theory), for every meeting or for one
--     meeting (e.g. the local host's theorists for that meeting only).
--   * Paper numbers, reviewers (each in one program), assignments sent in batches of
--     about 10, 1–6 scores with optional comments, per-program review instructions.
-- Run once in Supabase: SQL Editor → New query → paste this file → Run.
--
-- Who sees what:
--   Trade organizers   Trade papers, PDFs, reviewers, assignments and scores only
--   Theory organizers  the same for Theory, and only for their meeting if scoped to one
--   meeting admins     also open/close submissions and set the deadline (meeting-wide)
--   reviewers          their own assignments, those papers (and PDFs), their own scores
--   authors            nothing here; still only their own submission and its status
-- Reviewers are matched by the email they sign in with.

-- ---------------------------------------------------------------------------
-- Organizers by program (and optionally by meeting). Existing organizers become
-- Trade organizers for every meeting, and meeting admins.
-- Add one later in the SQL Editor, after they have signed in once:
--   insert into public.organizers (user_id, program, meeting_id)
--   select id, 'Theory', 'spring2027' from auth.users where email = 'name@colorado.edu';
-- (meeting_id null = every meeting; add meeting_admin = true only for the board.)
-- ---------------------------------------------------------------------------
alter table public.organizers drop constraint organizers_pkey;
alter table public.organizers
  add column id            bigint generated always as identity primary key,
  add column program       text check (program in ('Trade', 'Theory')),
  add column meeting_id    text references public.meetings (id),   -- null = every meeting
  add column meeting_admin boolean not null default false;
update public.organizers set program = 'Trade', meeting_admin = true;
alter table public.organizers alter column program set not null;
create unique index organizers_scope_key
  on public.organizers (user_id, program, coalesce(meeting_id, ''));

-- Does the signed-in person organize this program at this meeting?
create function public.organizes(prog text, m text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.organizers o
    where o.user_id = auth.uid() and o.program = prog
      and (o.meeting_id is null or o.meeting_id = m)
  );
$$;

-- ... this program at any meeting (reviewers belong to a program, not a meeting)?
create function public.organizes_program(prog text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.organizers o where o.user_id = auth.uid() and o.program = prog);
$$;

-- ... the program and meeting of this submission?
create function public.organizes_submission(sid bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.submissions s
    where s.id = sid and public.organizes(s.program, s.meeting_id)
  );
$$;

create function public.is_meeting_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.organizers where user_id = auth.uid() and meeting_admin);
$$;

-- Organizers see only their own organizer rows (their programs and meetings).
drop policy "organizers see organizers" on public.organizers;
create policy "organizers see own roles"
  on public.organizers for select
  to authenticated
  using (user_id = auth.uid());

-- Replace 001's "organizers see every submission and PDF" with program-scoped rules.
drop policy "read own or as organizer" on public.submissions;
create policy "authors read own"
  on public.submissions for select
  to authenticated
  using (user_id = auth.uid());
create policy "organizers read their program"
  on public.submissions for select
  to authenticated
  using (public.organizes(program, meeting_id));

create function public.organizer_can_read(path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.submissions s
    where s.pdf_path = path and public.organizes(s.program, s.meeting_id)
  );
$$;

drop policy "authors read own papers, organizers read all" on storage.objects;
create policy "authors read own papers"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'papers' and (storage.foldername(name))[2] = auth.uid()::text);
create policy "organizers read their program's papers"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'papers' and public.organizer_can_read(name));

-- ---------------------------------------------------------------------------
-- Paper numbers: #1, #2, … within each meeting, in order of submission.
-- ---------------------------------------------------------------------------
alter table public.submissions add column paper_no integer;

create function public.number_submission()
returns trigger
language plpgsql
security definer          -- must see every submission to find the next number
set search_path = ''
as $$
begin
  perform pg_advisory_xact_lock(hashtext('paper_no:' || new.meeting_id));
  select coalesce(max(paper_no), 0) + 1 into new.paper_no
  from public.submissions where meeting_id = new.meeting_id;
  return new;
end;
$$;

create trigger submissions_number
before insert on public.submissions
for each row execute function public.number_submission();

-- "Last edited" means the author's own save. Paper numbers, status changes and
-- coauthor-notice bookkeeping don't count; an author's save always does, even
-- with nothing changed (the receipt email relies on that).
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  sys text[] := array['notified_coauthors', 'status', 'paper_no', 'updated_at'];
begin
  if to_jsonb(new) <> to_jsonb(old)
     and (to_jsonb(new) - sys) = (to_jsonb(old) - sys) then
    return new;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

with numbered as (
  select id, row_number() over (partition by meeting_id order by created_at, id) as n
  from public.submissions
)
update public.submissions s set paper_no = numbered.n
from numbered where numbered.id = s.id;

alter table public.submissions alter column paper_no set not null;
alter table public.submissions add constraint submissions_paper_no_key unique (meeting_id, paper_no);

-- Organizers change the status of papers in their own program only.
create function public.set_submission_status(sid bigint, new_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.organizes_submission(sid) then
    raise exception 'Only this program''s organizers can change its status';
  end if;
  update public.submissions set status = new_status where id = sid;
end;
$$;
revoke execute on function public.set_submission_status(bigint, text) from public, anon;
grant execute on function public.set_submission_status(bigint, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Meeting settings. Opening/closing and the deadline are meeting-wide (meeting
-- admins). Review instructions are per program, each edited by its own organizers.
-- ---------------------------------------------------------------------------
alter table public.meetings add column review_instructions jsonb not null default '{}'::jsonb;

update public.meetings
set review_instructions = jsonb_build_object(
  'Trade', $txt$Please rank each paper on the following six point scale, with six the highest score and one the lowest. A short comment (a sentence or up to a paragraph) is welcome but optional.

6 - excellent paper of general interest - definitely should be on the program
5 - good paper - should be on the program
4 - competent paper - should be on the program if there is room
3 - paper of interest only to those working in the area - on the program if there is space
2 - marginal paper - on the program only if there is room
1 - should not be on the program

Keep in mind that the focus of the meetings is on real international trade topics. As the meetings continue to grow the submissions seem to encompass wider varieties of topics. There can be quite a few submissions that either do not deal with international trade topics or are concerned with open economy macro questions. So, take topic and audience interest into account in your ratings. Also, please keep in mind that we expect a large number of submissions for this meeting and expect to accept less than half of the number of papers submitted.$txt$,
  'Theory', $txt$Please rank each paper on the following six point scale, with six the highest score and one the lowest. A short comment (a sentence or up to a paragraph) is welcome but optional.

6 - excellent paper of general interest - definitely should be on the program
5 - good paper - should be on the program
4 - competent paper - should be on the program if there is room
3 - paper of interest only to those working in the area - on the program if there is space
2 - marginal paper - on the program only if there is room
1 - should not be on the program

Please take topic and audience interest into account in your ratings, and keep in mind that we expect a large number of submissions for this meeting and expect to accept less than half of the number of papers submitted.$txt$)
where id = 'spring2027';

create policy "meeting admins edit meetings"
  on public.meetings for update
  to authenticated
  using (public.is_meeting_admin())
  with check (public.is_meeting_admin());
grant update (submissions_open, submission_deadline) on public.meetings to authenticated;

create function public.set_review_instructions(m text, prog text, body text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.organizes(prog, m) then
    raise exception 'Only this program''s organizers can edit its instructions';
  end if;
  update public.meetings
  set review_instructions = review_instructions || jsonb_build_object(prog, body)
  where id = m;
end;
$$;
revoke execute on function public.set_review_instructions(text, text, text) from public, anon;
grant execute on function public.set_review_instructions(text, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- Reviewers: each reviews one program.
-- ---------------------------------------------------------------------------
create table public.reviewers (
  id          bigint generated always as identity primary key,
  name        text not null,
  email       text not null unique check (email = lower(email)),
  affiliation text,
  program     text not null check (program in ('Trade', 'Theory')),
  active      boolean not null default true,   -- inactive = not offered for new batches
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Assignments: one paper to one reviewer. A batch is the set given to a reviewer
-- at one time; invited_at records when its email went out.
-- ---------------------------------------------------------------------------
create table public.assignments (
  id            bigint generated always as identity primary key,
  submission_id bigint not null references public.submissions (id) on delete cascade,
  reviewer_id   bigint not null references public.reviewers (id),  -- no delete while assigned
  due_on        date,
  invited_at    timestamptz,
  created_at    timestamptz not null default now(),
  unique (submission_id, reviewer_id)
);

-- Trade reviewers get only Trade papers; Theory reviewers only Theory papers.
create function public.check_assignment_program()
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
  return new;
end;
$$;

create trigger assignments_program
before insert or update of submission_id, reviewer_id on public.assignments
for each row execute function public.check_assignment_program();

-- ---------------------------------------------------------------------------
-- Reviews: one per assignment. Score 1–6; comments optional.
-- ---------------------------------------------------------------------------
create table public.reviews (
  assignment_id bigint primary key references public.assignments (id) on delete cascade,
  score         smallint not null check (score between 1 and 6),
  comments      text,
  submitted_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create function public.touch_review()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger reviews_touch
before update on public.reviews
for each row execute function public.touch_review();

-- ---------------------------------------------------------------------------
-- Reviewer helpers. Security definer so the rules can look across tables without
-- the tables' own rules getting in the way (or looping).
-- ---------------------------------------------------------------------------
create function public.signed_in_email()
returns text
language sql
stable
set search_path = ''
as $$
  select lower(auth.jwt() ->> 'email');
$$;

-- Is the signed-in person a reviewer assigned to this submission?
create function public.reviews_submission(sid bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.assignments a
    join public.reviewers r on r.id = a.reviewer_id
    where a.submission_id = sid and r.email = public.signed_in_email()
  );
$$;

-- Is this assignment the signed-in reviewer's own?
create function public.owns_assignment(aid bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.assignments a
    join public.reviewers r on r.id = a.reviewer_id
    where a.id = aid and r.email = public.signed_in_email()
  );
$$;

-- Does the signed-in person organize the paper behind this assignment?
create function public.organizes_assignment(aid bigint)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.assignments a
    where a.id = aid and public.organizes_submission(a.submission_id)
  );
$$;

-- May the signed-in reviewer read this PDF (a paper assigned to them)?
create function public.reviewer_can_read(path text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.submissions s
    join public.assignments a on a.submission_id = s.id
    join public.reviewers r on r.id = a.reviewer_id
    where s.pdf_path = path and r.email = public.signed_in_email()
  );
$$;

-- ---------------------------------------------------------------------------
-- Access rules
-- ---------------------------------------------------------------------------
alter table public.reviewers   enable row level security;
alter table public.assignments enable row level security;
alter table public.reviews     enable row level security;

-- Reviewers can read the papers assigned to them (and their PDFs).
create policy "reviewers read assigned papers"
  on public.submissions for select
  to authenticated
  using (public.reviews_submission(id));

create policy "reviewers read assigned PDFs"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'papers' and public.reviewer_can_read(name));

-- Reviewers table: each program's organizers manage that program's reviewers;
-- a reviewer can see their own row.
create policy "organizers manage their program's reviewers"
  on public.reviewers for all
  to authenticated
  using (public.organizes_program(program))
  with check (public.organizes_program(program));
create policy "reviewers see themselves"
  on public.reviewers for select
  to authenticated
  using (email = public.signed_in_email());

-- Assignments: organizers manage those for their program's papers; a reviewer sees
-- only their own. (The trigger above keeps reviewer and paper in the same program.)
create policy "organizers manage their program's assignments"
  on public.assignments for all
  to authenticated
  using (public.organizes_submission(submission_id))
  with check (public.organizes_submission(submission_id));
create policy "reviewers see own assignments"
  on public.assignments for select
  to authenticated
  using (public.owns_assignment(id));

-- Reviews: a reviewer writes and reads only their own; organizers read (and can
-- delete) those for their program. No one else, so authors never see scores.
create policy "read own reviews or as the program's organizer"
  on public.reviews for select
  to authenticated
  using (public.owns_assignment(assignment_id) or public.organizes_assignment(assignment_id));
create policy "reviewers write own reviews"
  on public.reviews for insert
  to authenticated
  with check (public.owns_assignment(assignment_id));
create policy "reviewers edit own reviews"
  on public.reviews for update
  to authenticated
  using (public.owns_assignment(assignment_id))
  with check (public.owns_assignment(assignment_id));
create policy "organizers delete their program's reviews"
  on public.reviews for delete
  to authenticated
  using (public.organizes_assignment(assignment_id));

revoke all on public.reviewers, public.assignments, public.reviews from anon, authenticated;
grant select, insert, update, delete on public.reviewers to authenticated;
grant select, insert, update, delete on public.assignments to authenticated;
grant select, delete on public.reviews to authenticated;
grant insert (assignment_id, score, comments) on public.reviews to authenticated;
grant update (score, comments) on public.reviews to authenticated;
-- Organizer roles are added by the board in the SQL Editor, never from the portal.
revoke insert, update, delete on public.organizers from authenticated;
