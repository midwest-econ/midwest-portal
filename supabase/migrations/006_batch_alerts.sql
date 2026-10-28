-- 006_batch_alerts.sql
-- Emails a program's organizers each time another 10 of its papers are waiting for a
-- reviewer (Trade only for now; see supabase/functions/submission-email). This table
-- remembers how many tens were last reported, so each ten is reported once, even if
-- two authors submit at the same moment. Only the edge function (service role) uses it.
-- Run once in Supabase: SQL Editor → New query → paste this file → Run.

create table public.batch_alerts (
  meeting_id     text not null references public.meetings (id) on delete cascade,
  program        text not null check (program in ('Trade', 'Theory')),
  alerted_tens   int  not null default 0,   -- waiting papers ÷ 10 when last emailed
  primary key (meeting_id, program)
);

alter table public.batch_alerts enable row level security;   -- no policies: service role only
revoke all on public.batch_alerts from anon, authenticated;
