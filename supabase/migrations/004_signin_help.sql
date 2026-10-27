-- 004_signin_help.sql
-- Sign-in help: a meeting admin can get a one-time sign-in code for someone whose
-- code emails aren't arriving (a school's mail filter holding them) and pass it on
-- from their own email or by phone. The signin-code edge function makes the code;
-- this file adds what it needs.
-- Run once in Supabase: SQL Editor → New query → paste this file → Run.

-- Every code given out: for whom, by whom, when. Meeting admins can read it; only
-- the edge function (service role) writes it.
create table public.signin_codes_given (
  id             bigint generated always as identity primary key,
  email          text not null,
  given_by_email text not null,
  given_at       timestamptz not null default now()
);
alter table public.signin_codes_given enable row level security;
create policy "meeting admins read sign-in help log"
  on public.signin_codes_given for select
  to authenticated
  using (public.is_meeting_admin());
revoke all on public.signin_codes_given from anon, authenticated;
grant select on public.signin_codes_given to authenticated;

-- The account for an email address, if there is one. For the edge function only:
-- nobody signed in to the portal can look up accounts.
create function public.user_id_for_email(e text)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select id from auth.users where lower(email) = lower(e) limit 1;
$$;
revoke execute on function public.user_id_for_email(text) from public, anon, authenticated;
grant execute on function public.user_id_for_email(text) to service_role;
