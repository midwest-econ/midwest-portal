# Midwest Submission Portal

Submissions, review, decisions and the program for the Midwest International
Trade and Theory meetings. The public site stays on Google Sites; its
**Submissions** menu item links here.

- **Pages:** plain HTML/JS in this repository, served by GitHub Pages at
  <https://portal.midwesttradetheory.org/> (custom domain, set in the `CNAME` file;
  DNS at Namecheap). Email goes out through Resend from `mail.midwesttradetheory.org`.
- **Backend:** Supabase (project `nvparnlljxvgapsddqzf`): email sign-in codes,
  Postgres database, private PDF storage, and the access rules.
- **Plan and roles:** see the shared memo "Midwest Submission Portal: Plan and Roles".

## Layout

```
index.html                 Submit a Paper (sign-in + submission form)
organizer.html             Organizer Dashboard (papers, batches to reviewers, assigning by grid,
                           decisions and decision emails, reviewers, settings)
review.html                Review Papers (scientific committee scores assigned papers 1–6)
assets/config.js           Supabase URL + publishable key (public by design)
assets/app.js              Submit a Paper logic
assets/organizer.js, review.js, common.js   dashboard, review page, shared helpers
assets/style.css           styles matching the Google Site
assets/banner.jpg          header photo
supabase/migrations/       database setup, run in order in the Supabase SQL Editor
supabase/email-templates/  sign-in emails, pasted into Supabase → Authentication → Emails
supabase/functions/        Edge Functions: submission-email (author receipts, coauthor notices,
                           "10 papers waiting" alert to Trade organizers),
                           reviewer-email (batch invitations, reminders), decision-email
                           (Accept/Decline emails, coauthors copied), signin-code
```

## Security rules

- The **publishable key** in `config.js` is meant to be public. What anyone can
  read or change is decided by the row level security rules in
  `supabase/migrations/`, not by hiding the key.
- The **secret / service_role key never goes in this repository**, in OneDrive,
  or in a web page. It lives only in Supabase's secret settings.
- Authors see only their own submissions and never see scores or reviewer
  names. Authors can't change a submission's status.
- No real submissions in OneDrive or in this repository: they live only in Supabase.

## Running it locally

```
py -m http.server 8000
```

then open <http://localhost:8000>. Sign-in is by a code emailed to the person (no
link: university mail filters hold sign-in links or use them up when scanning), so
it works the same locally as on the live site.

## Database changes

Each file in `supabase/migrations/` is run once, in order, in Supabase →
SQL Editor. Never edit a file that has already been run; add a new numbered one.

| File | What it sets up |
|---|---|
| `001_submissions.sql` | meetings, organizers, submissions, the `papers` PDF bucket, access rules |
| `002_emails_and_form_trim.sql` | tracks which coauthors were emailed; drops the removed form questions |
| `003_review.sql` | paper numbers, reviewers, assignments, 1–6 reviews, review instructions, organizer tools |
| `004_signin_help.sql` | log of sign-in codes given out by meeting admins (Settings → Sign-in help) |
| `005_decision_date.sql` | decision notification date for each meeting (Settings; shown under Key dates) |
| `006_batch_alerts.sql` | remembers when Trade organizers were last told another 10 papers are waiting for a reviewer |
| `007_demo_meeting.sql` | a demo meeting for trying the portal with test papers |
| `008_demo_reviewers.sql` | test reviewers for the demo meeting, kept apart from the real ones |
| `009_paper_numbers_by_program.sql` | paper numbers count within each program: IT1, IT2, … (Trade) and ET1, ET2, … (Theory) |
| `010_decisions.sql` | Accept/Decline per paper, hidden from authors until the decision emails go out; each program's email wording |

## The demo meeting

For showing the portal to colleagues with test papers, kept apart from the real
meetings. Submit test papers at https://portal.midwesttradetheory.org/?meeting=demo
(the plain address never shows it). Organizers choose "Demo" from the Meeting menu,
or open `organizer.html?meeting=demo`. Emails are really sent, with "[Demo]" at the
start of the subject, so use test addresses: Gmail's `name+anything@gmail.com` reaches
`name@gmail.com` and counts as a different author. The demo has its own test
reviewers: those added while Demo is chosen are test reviewers, never listed for
the real meetings, and the real committee never appears in the demo. The database
refuses to give a demo paper to a real reviewer or a real paper to a test one, and
someone who organizes only the demo can't see the real reviewers.

To let someone try the organizer page on the demo meeting only (they sign in once first):

```sql
insert into public.organizers (user_id, program, meeting_id, meeting_admin)
select id, 'Trade', 'demo', true from auth.users where email = 'name@example.edu';
```

Deleting the demo meeting: first delete the `demo` folder in Storage → `papers`, then

```sql
delete from public.organizers  where meeting_id = 'demo';
delete from public.submissions where meeting_id = 'demo';   -- their assignments and reviews go too
delete from public.reviewers   where demo;
delete from public.meetings    where id = 'demo';
```

and remove the test accounts in Authentication → Users.

## Adding an organizer

Trade and Theory are kept completely apart: an organizer sees only their own
program's papers, reviewers and scores. Theory is usually run by the local host's
theorists for one meeting. After the person has signed in once, run in the SQL Editor:

```sql
-- Theory organizer for one meeting (the usual case for the local host):
insert into public.organizers (user_id, program, meeting_id)
select id, 'Theory', 'spring2027' from auth.users where email = 'name@example.edu';

-- Trade organizer for every meeting (the board); meeting_admin also lets them
-- open/close submissions and set the deadline:
insert into public.organizers (user_id, program, meeting_admin)
select id, 'Trade', true from auth.users where email = 'name@example.edu';
```
