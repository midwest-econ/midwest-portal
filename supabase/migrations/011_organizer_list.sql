-- 011: who organizes a meeting, for the Settings tab (James, Nov 3, 2026).
-- Run once in Supabase -> SQL Editor.
--
-- Organizers can read only their own rows, and the page can't read account emails, so
-- this function hands meeting admins the list for one meeting. Anyone else gets no rows.
-- It only reads: organizers are still changed by SQL (README, "Adding an organizer").
--
-- meeting_admin is about the person, not the row: admin rights cover every meeting and
-- both programs (is_meeting_admin), so it's true on all of an admin's rows.

create function public.meeting_organizers(m text)
returns table (email text, program text, all_meetings boolean, meeting_admin boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select u.email::text,
         o.program,
         o.meeting_id is null,
         exists (select 1 from public.organizers a where a.user_id = o.user_id and a.meeting_admin)
  from public.organizers o
  join auth.users u on u.id = o.user_id
  where public.is_meeting_admin()
    and (o.meeting_id is null or o.meeting_id = m)
  order by u.email, o.program desc;   -- Trade before Theory
$$;

revoke execute on function public.meeting_organizers(text) from public, anon;
grant execute on function public.meeting_organizers(text) to authenticated;
