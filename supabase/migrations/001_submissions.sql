-- 001_submissions.sql
-- Meetings, organizers, submissions, and private PDF storage, with access rules.
-- Run once in Supabase: SQL Editor → New query → paste this file → Run.
-- Safe to read top to bottom; nothing here deletes data.

-- ---------------------------------------------------------------------------
-- Meetings: one row per conference. The portal shows the meeting whose
-- submissions are open.
-- ---------------------------------------------------------------------------
create table public.meetings (
  id                  text primary key,          -- e.g. 'spring2027'
  name                text not null,             -- e.g. 'Spring 2027'
  host                text not null,             -- archive-style host name
  location            text,
  starts_on           date,
  ends_on             date,
  submissions_open    boolean not null default false,
  submission_deadline timestamptz                -- null = no deadline set yet
);

insert into public.meetings
  (id, name, host, location, starts_on, ends_on, submissions_open)
values
  ('spring2027', 'Spring 2027', 'Colorado', 'University of Colorado Boulder',
   '2027-04-16', '2027-04-18', true);

-- ---------------------------------------------------------------------------
-- Organizers: signed-in users listed here can see every submission.
-- Add someone after they have signed in once:
--   insert into public.organizers (user_id)
--   select id from auth.users where email = 'name@example.edu';
-- ---------------------------------------------------------------------------
create table public.organizers (
  user_id uuid primary key references auth.users (id) on delete cascade
);

create function public.is_organizer()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.organizers where user_id = auth.uid());
$$;

-- True while a meeting is open and its deadline (if any) has not passed.
create function public.submissions_open(m text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.meetings
    where id = m
      and submissions_open
      and (submission_deadline is null or now() < submission_deadline)
  );
$$;

-- ---------------------------------------------------------------------------
-- Submissions: one paper per presenting author per meeting.
-- ---------------------------------------------------------------------------
create table public.submissions (
  id                    bigint generated always as identity primary key,
  meeting_id            text not null references public.meetings (id),
  user_id               uuid not null default auth.uid()
                          references auth.users (id) on delete cascade,
  program               text not null check (program in ('Trade', 'Theory')),
  title                 text not null check (char_length(title) between 3 and 300),
  presenter_name        text not null,
  presenter_affiliation text not null,
  presenter_email       text not null,
  coauthors             jsonb not null default '[]'::jsonb,  -- [{name, affiliation, email}]
  jel_codes             text,
  keywords              text,
  abstract              text not null,
  pdf_path              text,
  willing_discussant    boolean not null default false,
  willing_chair         boolean not null default false,
  willing_review        boolean not null default false,
  attendance            text,
  conflicts             text,
  status                text not null default 'submitted'
                          check (status in ('submitted', 'under_review', 'accepted',
                                            'waitlisted', 'declined', 'withdrawn')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (meeting_id, user_id)
);

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger submissions_touch
before update on public.submissions
for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Access rules (row level security)
-- ---------------------------------------------------------------------------
alter table public.meetings    enable row level security;
alter table public.organizers  enable row level security;
alter table public.submissions enable row level security;

-- Anyone, signed in or not, can read the meeting list.
create policy "meetings are public"
  on public.meetings for select
  using (true);

-- Organizers can see the organizer list; no one changes it from the portal.
create policy "organizers see organizers"
  on public.organizers for select
  to authenticated
  using (public.is_organizer());

-- Authors see their own submissions; organizers see all.
create policy "read own or as organizer"
  on public.submissions for select
  to authenticated
  using (user_id = auth.uid() or public.is_organizer());

-- Authors submit only for themselves, only while the meeting is open.
create policy "submit while open"
  on public.submissions for insert
  to authenticated
  with check (user_id = auth.uid() and public.submissions_open(meeting_id));

-- Authors edit their own submission only while the meeting is open.
create policy "edit own while open"
  on public.submissions for update
  to authenticated
  using (user_id = auth.uid() and public.submissions_open(meeting_id))
  with check (user_id = auth.uid() and public.submissions_open(meeting_id));

-- Column rights: authors can never set status, user_id or timestamps.
-- (Organizer tools that change status will run with elevated rights later.)
revoke all on public.submissions from anon, authenticated;
grant select on public.submissions to authenticated;
grant insert (meeting_id, program, title, presenter_name, presenter_affiliation,
              presenter_email, coauthors, jel_codes, keywords, abstract, pdf_path,
              willing_discussant, willing_chair, willing_review, attendance, conflicts)
  on public.submissions to authenticated;
grant update (program, title, presenter_name, presenter_affiliation,
              presenter_email, coauthors, jel_codes, keywords, abstract, pdf_path,
              willing_discussant, willing_chair, willing_review, attendance, conflicts)
  on public.submissions to authenticated;

revoke all on public.organizers from anon, authenticated;
grant select on public.organizers to authenticated;

revoke all on public.meetings from anon, authenticated;
grant select on public.meetings to anon, authenticated;

-- ---------------------------------------------------------------------------
-- PDF storage: a private bucket. Each author's files live under
--   <meeting_id>/<user_id>/<file>.pdf
-- PDFs only, 20 MB maximum.
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('papers', 'papers', false, 20971520, array['application/pdf']);

create policy "authors upload own papers"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'papers'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.submissions_open((storage.foldername(name))[1])
  );

create policy "authors read own papers, organizers read all"
  on storage.objects for select
  to authenticated
  using (
    bucket_id = 'papers'
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_organizer())
  );

create policy "authors delete own papers while open"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'papers'
    and (storage.foldername(name))[2] = auth.uid()::text
    and public.submissions_open((storage.foldername(name))[1])
  );
