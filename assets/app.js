// Submit a Paper: email sign-in, then one submission per author per meeting,
// with the PDF kept in private storage. Access rules live in the database
// (supabase/migrations/001_submissions.sql); this page only shows and sends.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY, MAX_PDF_MB, MAX_ABSTRACT_WORDS } from './config.js';
import { wireSignIn, wireSignOut } from './signin.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = id => document.getElementById(id);

const STATUS = {
  submitted:    ['Received', 'info'],
  under_review: ['Under review', 'info'],
  accepted:     ['Accepted', 'ok'],
  waitlisted:   ['Waitlisted', 'warn'],
  declined:     ['Not accepted', 'bad'],
  withdrawn:    ['Withdrawn', 'bad'],
};

let meeting = null;     // the meeting open for submissions
let mine = null;        // this author's submission for it, if any
let user = null;

// ---------------------------------------------------------------- helpers
function show(id, on = true) { $(id).hidden = !on; }

function say(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg ' + kind;
  el.hidden = !text;
}

const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const fmtStamp = t => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
// Deadlines are announced in Eastern time, so show them that way wherever the reader is.
const fmtDeadline = t => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' });
const wordCount = s => (s.trim().match(/\S+/g) || []).length;

function isOpen() {
  return meeting.submissions_open &&
    (!meeting.submission_deadline || new Date() < new Date(meeting.submission_deadline));
}

// ---------------------------------------------------------------- meeting
// The demo meeting (007_demo_meeting.sql) is only reached by name: ?meeting=demo.
async function loadMeeting() {
  const named = new URLSearchParams(location.search).get('meeting');
  let q = sb.from('meetings').select('*').eq('submissions_open', true);
  q = named ? q.eq('id', named) : q.eq('demo', false);
  const { data, error } = await q.order('starts_on', { ascending: true }).limit(1);
  if (error) throw error;
  meeting = data[0] || null;
  if (!meeting) return;
  if (meeting.demo) say('demo-note', 'This is the demo meeting, for trying out the portal. Papers here are test papers, not real submissions. Emails are really sent (marked [Demo]), so give coauthors test addresses.', 'warn');

  const days = meeting.starts_on && meeting.ends_on
    ? ` · ${fmtDate(meeting.starts_on).replace(/, \d{4}$/, '')}–${fmtDate(meeting.ends_on)}` : '';
  $('meeting-line').textContent = `${meeting.name} meetings · ${meeting.location || meeting.host}${days}`;

  const rows = [['Submission deadline',
    meeting.submission_deadline ? fmtDeadline(meeting.submission_deadline) : 'To be announced']];
  if (meeting.decisions_on) rows.push(['Decision notification',
    new Date(meeting.decisions_on + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })]);
  if (meeting.starts_on) rows.push(['Conference', `${fmtDate(meeting.starts_on)} – ${fmtDate(meeting.ends_on)}`]);
  $('dates').replaceChildren(...rows.flatMap(([k, v]) => {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    return [dt, dd];
  }));
}

// ---------------------------------------------------------------- sign-in
wireSignIn(sb, say);

wireSignOut(sb);

// ---------------------------------------------------------------- coauthors
function addCoauthor(c = {}) {
  const row = document.createElement('div');
  row.className = 'coauthor';
  row.innerHTML = `
    <div class="field"><label>Name</label><input data-k="name"></div>
    <div class="field"><label>Affiliation</label><input data-k="affiliation"></div>
    <div class="field"><label>Email</label><input data-k="email" type="email"></div>
    <button type="button" class="btn ghost sm" aria-label="Remove coauthor">Remove</button>`;
  for (const input of row.querySelectorAll('input')) input.value = c[input.dataset.k] || '';
  row.querySelector('button').addEventListener('click', () => row.remove());
  $('coauthors').append(row);
}

function readCoauthors() {
  return [...$('coauthors').children]
    .map(row => Object.fromEntries([...row.querySelectorAll('input')].map(i => [i.dataset.k, i.value.trim()])))
    .filter(c => c.name || c.email);
}

$('add-coauthor').addEventListener('click', () => addCoauthor());

// ---------------------------------------------------------------- abstract counter
function updateCount() {
  const n = wordCount($('f-abs').value);
  $('abs-count').textContent = `${n} / ${MAX_ABSTRACT_WORDS} words`;
  $('abs-count').classList.toggle('over', n > MAX_ABSTRACT_WORDS);
}
$('f-abs').addEventListener('input', updateCount);

// ---------------------------------------------------------------- form fill + status
function fillForm() {
  const form = $('paper-form'), f = form.elements;
  $('coauthors').replaceChildren();
  if (!mine) {
    form.reset();
    f.presenter_name.value = user.user_metadata?.full_name || '';
    $('pdf-current').hidden = true;
    $('submit-heading').textContent = 'Submit a paper';
    $('save-btn').textContent = 'Submit paper';
    show('status-panel', false);
    updateCount();
    return;
  }
  for (const k of ['title', 'presenter_name', 'presenter_affiliation', 'abstract']) {
    if (f[k]) f[k].value = mine[k] || '';
  }
  for (const r of f.program) r.checked = r.value === mine.program;
  (mine.coauthors || []).forEach(addCoauthor);
  updateCount();

  $('pdf-current').hidden = !mine.pdf_path;
  if (mine.pdf_path) {
    $('pdf-current').innerHTML = 'Current file: <a href="#" id="pdf-view">view your PDF</a>. Choose a new file below to replace it.';
    $('pdf-view').addEventListener('click', viewPdf);
  }

  $('submit-heading').textContent = 'Your submission';
  $('save-btn').textContent = 'Save changes';
  const [label, kind] = STATUS[mine.status] || [mine.status, 'info'];
  $('status-title').textContent = mine.title;
  $('status-pill').textContent = label;
  $('status-pill').className = 'pill ' + kind;
  $('status-created').textContent = fmtStamp(mine.created_at);
  $('status-updated').textContent = fmtStamp(mine.updated_at);
  show('status-panel');
}

async function viewPdf(e) {
  e.preventDefault();
  const { data, error } = await sb.storage.from('papers').createSignedUrl(mine.pdf_path, 300);
  if (error) say('form-msg', `Couldn't open the PDF: ${error.message}`, 'bad');
  else window.open(data.signedUrl, '_blank', 'noopener');
}

function lockIfClosed() {
  const closed = !isOpen();
  for (const el of $('paper-form').elements) el.disabled = closed;
  $('add-coauthor').disabled = closed;
  if (closed) say('form-msg', 'The submission deadline has passed, so this submission can no longer be edited.', 'warn');
}

// ---------------------------------------------------------------- save
function validate(f, pdf) {
  if (!f.program.value) return 'Choose the Trade or Theory program.';
  for (const [k, label] of [['title', 'paper title'], ['presenter_name', 'presenting author'],
                            ['presenter_affiliation', 'affiliation'], ['abstract', 'abstract']]) {
    if (!f[k].value.trim()) return `Please fill in the ${label}.`;
  }
  if (wordCount(f.abstract.value) > MAX_ABSTRACT_WORDS) return `The abstract is over ${MAX_ABSTRACT_WORDS} words.`;
  for (const c of readCoauthors()) {
    if (!c.name) return 'Each coauthor needs a name.';
    if (!c.email || !/^\S+@\S+\.\S+$/.test(c.email)) return `Please add a valid email for ${c.name}.`;
  }
  if (!mine?.pdf_path && !pdf) return 'Please attach a PDF: your paper, or an extended abstract if the paper is not ready yet.';
  if (pdf && pdf.type !== 'application/pdf' && !/\.pdf$/i.test(pdf.name)) return 'The paper must be a PDF.';
  if (pdf && pdf.size > MAX_PDF_MB * 1024 * 1024) return `The PDF is over ${MAX_PDF_MB} MB.`;
  return null;
}

$('paper-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target.elements;
  const pdf = $('f-pdf').files[0];
  const problem = validate(f, pdf);
  if (problem) return say('form-msg', problem, 'bad');

  $('save-btn').disabled = true;
  say('form-msg', pdf ? 'Uploading your PDF…' : 'Saving…', 'warn');

  // Upload the new PDF first, so a failed upload changes nothing.
  let newPath = null;
  if (pdf) {
    newPath = `${meeting.id}/${user.id}/${crypto.randomUUID()}.pdf`;
    const up = await sb.storage.from('papers').upload(newPath, pdf, { contentType: 'application/pdf' });
    if (up.error) {
      $('save-btn').disabled = false;
      return say('form-msg', `The PDF didn't upload: ${up.error.message}`, 'bad');
    }
  }

  const row = {
    program: f.program.value,
    title: f.title.value.trim(),
    presenter_name: f.presenter_name.value.trim(),
    presenter_affiliation: f.presenter_affiliation.value.trim(),
    presenter_email: user.email,
    coauthors: readCoauthors(),
    abstract: f.abstract.value.trim(),
  };
  if (newPath) row.pdf_path = newPath;

  const oldPath = mine?.pdf_path;
  const res = mine
    ? await sb.from('submissions').update(row).eq('id', mine.id).select().single()
    : await sb.from('submissions').insert({ ...row, meeting_id: meeting.id }).select().single();

  $('save-btn').disabled = false;
  if (res.error) {
    if (newPath) await sb.storage.from('papers').remove([newPath]);
    return say('form-msg', `Your submission wasn't saved: ${res.error.message}`, 'bad');
  }
  if (newPath && oldPath) await sb.storage.from('papers').remove([oldPath]);

  const first = !mine;
  mine = res.data;
  $('f-pdf').value = '';
  fillForm();
  say('form-msg', first
    ? `Thank you, your paper has been submitted. A confirmation is on its way to ${user.email}. You can come back to edit it until the deadline.`
    : `Your changes have been saved. We've emailed an updated copy to ${user.email}.`, 'ok');

  // Receipt + coauthor notices (supabase/functions/submission-email). The save
  // already succeeded, so a failure here is only logged.
  sb.functions.invoke('submission-email', { body: { id: mine.id } })
    .then(({ error }) => { if (error) console.warn('Confirmation email failed:', error.message); });
});

// ---------------------------------------------------------------- render by state
async function render(session) {
  user = session?.user || null;
  show('loading', false);
  show('userbar', !!user);
  if (user) $('user-email').textContent = user.email;

  if (!meeting) {
    show('signin', false); show('submit', false);
    say('notice', 'Submissions are not open right now. Please check back when the call for papers is announced.', 'warn');
    return;
  }
  show('notice', false);
  show('signin', !user);
  show('submit', !!user);
  if (!user) return;

  const { data, error } = await sb.from('submissions')
    .select('*').eq('meeting_id', meeting.id).eq('user_id', user.id).maybeSingle();
  if (error) return say('form-msg', `Couldn't load your submission: ${error.message}`, 'bad');
  mine = data;
  fillForm();
  lockIfClosed();
}

try {
  await loadMeeting();
} catch (err) {
  show('loading', false);
  say('notice', `The portal couldn't reach its database (${err.message}). Please try again shortly.`, 'bad');
  throw err;
}

let current;
sb.auth.onAuthStateChange((_event, session) => {
  // Re-render only when the signed-in person changes, not on token refresh.
  const id = session?.user?.id || null;
  // supabase-js clears the sign-in tokens from the URL but leaves a bare "#".
  if (location.href.endsWith('#')) history.replaceState(null, '', location.pathname + location.search);
  if (id === current) return;
  current = id;
  setTimeout(() => render(session), 0);
});
