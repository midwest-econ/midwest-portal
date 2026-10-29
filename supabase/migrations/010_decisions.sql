-- 010: decisions and decision emails (James, Oct 29, 2026).
-- Run once in Supabase -> SQL Editor.
--
-- Organizers record Accept or Decline for each paper in their program. Authors don't see
-- it until the decision emails go out (Decisions tab -> supabase/functions/decision-email);
-- sending sets the paper's status to accepted or declined, which the author then sees.
-- A sent decision can't be changed from the portal. There is no waitlist.
-- Each program's emails (one for Accept, one for Decline) are stored per meeting and
-- edited on the Decisions tab; new meetings start from the default wording below.

create table public.decisions (
  submission_id bigint primary key references public.submissions (id) on delete cascade,
  decision      text not null check (decision in ('accepted', 'declined')),
  decided_at    timestamptz not null default now(),
  sent_at       timestamptz            -- set by decision-email when the email goes out
);

create function public.touch_decided_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.decision is distinct from old.decision then
    new.decided_at := now();
  end if;
  return new;
end;
$$;

create trigger decisions_touch
before update on public.decisions
for each row execute function public.touch_decided_at();

alter table public.decisions enable row level security;

-- Only the paper's program organizers, and only until the email has gone out.
create policy "organizers read their program's decisions"
  on public.decisions for select
  to authenticated
  using (public.organizes_submission(submission_id));
create policy "organizers decide until sent"
  on public.decisions for insert
  to authenticated
  with check (public.organizes_submission(submission_id) and sent_at is null);
create policy "organizers change decisions until sent"
  on public.decisions for update
  to authenticated
  using (public.organizes_submission(submission_id) and sent_at is null)
  with check (public.organizes_submission(submission_id) and sent_at is null);
create policy "organizers clear decisions until sent"
  on public.decisions for delete
  to authenticated
  using (public.organizes_submission(submission_id) and sent_at is null);

revoke all on public.decisions from anon, authenticated;
grant select, delete on public.decisions to authenticated;
grant insert (submission_id, decision) on public.decisions to authenticated;
grant update (decision) on public.decisions to authenticated;

-- Statuses organizers set by hand: Received, Under review, Withdrawn. Accepted and
-- Not accepted come only from sending the decision emails; after that a paper can
-- still be marked withdrawn (an accepted author who can't come).
create or replace function public.set_submission_status(sid bigint, new_status text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.organizes_submission(sid) then
    raise exception 'Only this program''s organizers can change its status';
  end if;
  if new_status not in ('submitted', 'under_review', 'withdrawn') then
    raise exception 'Accept and decline go out from the Decisions tab';
  end if;
  if new_status <> 'withdrawn'
     and exists (select 1 from public.decisions where submission_id = sid and sent_at is not null) then
    raise exception 'This paper''s decision has been emailed, so it can only be marked withdrawn';
  end if;
  update public.submissions set status = new_status where id = sid;
end;
$$;

-- ---------------------------------------------------------------------------
-- Email wording. Placeholders: {name} (presenting author), {title}, {paper} (IT3, ET5),
-- {program} (International Trade / Economic Theory), {meeting} (Spring 2027),
-- {where} (place and dates). The presenting author gets the email, coauthors are copied.
-- ---------------------------------------------------------------------------
create function public.default_decision_emails()
returns jsonb
language sql
immutable
set search_path = ''
as $$
  with one as (
    select jsonb_build_object(
      'accepted', jsonb_build_object(
        'subject', 'Accepted: your paper for the {meeting} Midwest {program} meetings',
        'body', $txt$Dear {name},

We are pleased to let you know that your paper "{title}" ({paper}) has been accepted for the {meeting} Midwest {program} meetings ({where}).

The program, with your session and time, will follow later. If you or a coauthor can no longer present the paper, please let us know as soon as possible by replying to this email.

We look forward to seeing you there.

The Midwest {program} organizers$txt$),
      'declined', jsonb_build_object(
        'subject', 'Your submission to the {meeting} Midwest {program} meetings',
        'body', $txt$Dear {name},

Thank you for submitting "{title}" ({paper}) to the {meeting} Midwest {program} meetings. We received many more strong submissions than we have room for on the program, and we regret that we are unable to accept your paper this time.

We hope you will submit your work to a future meeting.

The Midwest {program} organizers$txt$)) as e
  )
  select jsonb_build_object('Trade', e, 'Theory', e) from one;
$$;

alter table public.meetings
  add column decision_emails jsonb not null default public.default_decision_emails();

create function public.set_decision_emails(m text, prog text, emails jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.organizes(prog, m) then
    raise exception 'Only this program''s organizers can edit its decision emails';
  end if;
  if coalesce(length(trim(emails #>> '{accepted,subject}')), 0) = 0
     or coalesce(length(trim(emails #>> '{accepted,body}')), 0) = 0
     or coalesce(length(trim(emails #>> '{declined,subject}')), 0) = 0
     or coalesce(length(trim(emails #>> '{declined,body}')), 0) = 0 then
    raise exception 'Each email needs a subject and a message';
  end if;
  update public.meetings
  set decision_emails = decision_emails || jsonb_build_object(prog, jsonb_build_object(
    'accepted', jsonb_build_object('subject', emails #>> '{accepted,subject}', 'body', emails #>> '{accepted,body}'),
    'declined', jsonb_build_object('subject', emails #>> '{declined,subject}', 'body', emails #>> '{declined,body}')))
  where id = m;
end;
$$;
revoke execute on function public.set_decision_emails(text, text, jsonb) from public, anon;
grant execute on function public.set_decision_emails(text, text, jsonb) to authenticated;
