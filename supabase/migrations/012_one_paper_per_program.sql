-- 012: one paper per presenting author in EACH program (James, Nov 23, 2026).
-- An author may submit and present one Trade paper and one Theory paper at the same
-- meeting. 001 allowed only one paper per author per meeting across both programs.
--
-- Nothing else changes: PDFs are stored under <meeting>/<user_id>/<random>.pdf, so two
-- papers by one author never share a file name, and every organizer, reviewer and
-- decision rule already works per paper and per program. Moving a paper to the other
-- program is refused when the author already has a paper there (by this constraint) or
-- once the paper has a reviewer (009).

alter table public.submissions drop constraint submissions_meeting_id_user_id_key;

alter table public.submissions
  add constraint submissions_meeting_user_program_key unique (meeting_id, user_id, program);
