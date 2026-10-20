# Midwest Submission Portal

Submissions, review, decisions and the program for the Midwest International
Trade and Theory meetings. The public site stays on Google Sites; its
**Submissions** menu item links here.

- **Pages:** plain HTML/JS in this repository, served by GitHub Pages at
  <https://midwest-econ.github.io/midwest-portal/>.
- **Backend:** Supabase (project `nvparnlljxvgapsddqzf`): email sign-in links,
  Postgres database, private PDF storage, and the access rules.
- **Plan and roles:** see the shared memo "Midwest Submission Portal: Plan and Roles".

## Layout

```
index.html                 Submit a Paper (sign-in + submission form)
assets/config.js           Supabase URL + publishable key (public by design)
assets/app.js              page logic
assets/style.css           styles matching the Google Site
assets/banner.jpg          header photo
supabase/migrations/       database setup, run in order in the Supabase SQL Editor
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

then open <http://localhost:8000>. Sign-in links come back to the page they were
requested from, so `http://localhost:8000/**` must be in Supabase →
Authentication → URL Configuration → Redirect URLs.

## Database changes

Each file in `supabase/migrations/` is run once, in order, in Supabase →
SQL Editor. Never edit a file that has already been run; add a new numbered one.

| File | What it sets up |
|---|---|
| `001_submissions.sql` | meetings, organizers, submissions, the `papers` PDF bucket, access rules |

## Adding an organizer

After the person has signed in once, run in the SQL Editor:

```sql
insert into public.organizers (user_id)
select id from auth.users where email = 'name@example.edu';
```
