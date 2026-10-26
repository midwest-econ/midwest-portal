// Review page: a committee member signs in with the email they were invited at
// and scores each assigned paper 1–6, with an optional comment. Access rules
// (supabase/migrations/003_review.sql) limit them to their own assignments.
import { sb, $, show, say, esc, fmtDate, people, openPdf, setupAuth, SCALE } from './common.js';

let assignments = [];

function scoreRow(a) {
  const name = `score-${a.id}`;
  return `<div class="scale" role="radiogroup" aria-label="Score">` +
    [6, 5, 4, 3, 2, 1].map(n => `
      <label title="${esc(SCALE[n])}"><input type="radio" name="${name}" value="${n}"${a.review?.score === n ? ' checked' : ''}><b>${n}</b></label>`).join('') +
    `</div><p class="hint" id="scale-${a.id}">${a.review ? esc(SCALE[a.review.score]) : 'Choose a score from 6 (highest) to 1.'}</p>`;
}

function card(a) {
  const s = a.submission;
  const done = !!a.review;
  return `<article class="panel stack paper" id="a-${a.id}">
    <div class="paper-head">
      <div>
        <div class="eyebrow">Paper #${s.paper_no} · ${esc(s.program)}</div>
        <h3>${esc(s.title)}</h3>
        <p class="muted small">${esc(people(s))}</p>
      </div>
      <span class="pill ${done ? 'ok' : 'warn'}" id="pill-${a.id}">${done ? 'Score saved' : 'To review'}</span>
    </div>
    <details><summary class="small">Abstract</summary><p class="small abstract">${esc(s.abstract)}</p></details>
    <div class="btnrow">${s.pdf_path
      ? `<button type="button" class="btn ghost sm" data-pdf="${esc(s.pdf_path)}">Open the PDF</button>`
      : '<span class="muted small">No PDF uploaded</span>'}</div>
    <form class="stack" id="f-${a.id}" data-id="${a.id}">
      <div class="field"><span class="lbl">Score</span>${scoreRow(a)}</div>
      <div class="field">
        <label for="c-${a.id}">Comments <span class="opt">(optional; for the organizers)</span></label>
        <textarea id="c-${a.id}" name="comments" rows="3">${esc(a.review?.comments || '')}</textarea>
      </div>
      <p class="hint" id="saved-${a.id}" aria-live="polite">${done ? `Saved ${stamp(a.review.updated_at)}` : 'Your score saves as soon as you choose it.'}</p>
    </form>
  </article>`;
}

function render() {
  // Group by meeting, newest first.
  const byMeeting = new Map();
  for (const a of assignments) {
    const m = a.submission.meeting;
    if (!byMeeting.has(m.id)) byMeeting.set(m.id, { m, list: [] });
    byMeeting.get(m.id).list.push(a);
  }
  const groups = [...byMeeting.values()].sort((x, y) => (y.m.starts_on || '').localeCompare(x.m.starts_on || ''));

  lede();

  $('rv-meetings').innerHTML = groups.map(({ m, list }) => {
    list.sort((x, y) => x.submission.paper_no - y.submission.paper_no);
    const programs = [...new Set(list.map(a => a.submission.program))];
    const due = list.map(a => a.due_on).filter(Boolean).sort()[0];
    const instr = programs.map(p => m.review_instructions?.[p]).filter(Boolean)[0] || '';
    return `<section class="stack">
      <h2 class="meeting-h">${esc(m.name)} meetings${due ? ` <span class="muted small">· scores due ${fmtDate(due)}</span>` : ''}</h2>
      ${instr ? `<details class="panel tint" open><summary><b>Instructions</b></summary><p class="instructions small">${esc(instr)}</p></details>` : ''}
      ${list.map(card).join('')}
    </section>`;
  }).join('');

  for (const b of $('rv-meetings').querySelectorAll('[data-pdf]')) {
    b.addEventListener('click', () => openPdf(b.dataset.pdf, 'rv-msg'));
  }
  for (const f of $('rv-meetings').querySelectorAll('form[data-id]')) {
    const id = Number(f.dataset.id);
    f.addEventListener('submit', e => e.preventDefault());
    f.addEventListener('change', e => {
      if (e.target.type !== 'radio') return;
      $(`scale-${id}`).textContent = SCALE[e.target.value];
      edited(id, 0);
    });
    f.elements.comments.addEventListener('input', () => edited(id, 1200));
    f.elements.comments.addEventListener('blur', () => flush(id));
    restoreDraft(id, f);
  }
}

function lede() {
  const open = assignments.filter(a => !a.review).length;
  $('rv-lede').textContent = assignments.length
    ? `${assignments.length - open} of ${assignments.length} scored. Scores and comments save automatically as you go, and you can change them until the organizers make decisions.`
    : '';
}

// Saving is automatic: a score saves as soon as it's chosen, comments shortly after
// typing stops (or on leaving the box). One save per paper runs at a time, always
// with the latest values, so quick changes can't race each other. Until the server
// has a change it is also kept in this browser, so a dropped connection or a closed
// tab doesn't lose it; failed saves retry on their own.
const timers = new Map();    // assignment id → pending save timer
const saving = new Map();    // assignment id → save in flight
const unsaved = new Set();   // ids with changes the server doesn't have yet
const failed = new Set();    // ids whose last save attempt failed
const draftKey = id => `mwitt-review-${id}`;
const stamp = t => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const values = f => ({
  score: Number(f.querySelector('input[type=radio]:checked')?.value) || null,
  comments: f.elements.comments.value.trim() || null,
});
const matchesSaved = (a, v) => !!a.review && a.review.score === v.score && (a.review.comments || null) === v.comments;

function keepDraft(id, v) { try { localStorage.setItem(draftKey(id), JSON.stringify(v)); } catch {} }
function dropDraft(id) { try { localStorage.removeItem(draftKey(id)); } catch {} }
function readDraft(id) { try { return JSON.parse(localStorage.getItem(draftKey(id)) || 'null'); } catch { return null; } }

function edited(id, delay) {
  const a = assignments.find(x => x.id === id);
  const v = values($(`f-${id}`));
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (matchesSaved(a, v) || (!a.review && !v.score && !v.comments)) {
    unsaved.delete(id);
    dropDraft(id);
    $(`saved-${id}`).textContent = a.review ? `Saved ${stamp(a.review.updated_at)}` : 'Your score saves as soon as you choose it.';
    return;
  }
  unsaved.add(id);
  keepDraft(id, v);
  if (!v.score) {
    $(`saved-${id}`).textContent = 'Choose a score and your comment will save with it.';
    return;
  }
  $(`saved-${id}`).textContent = 'Unsaved changes…';
  timers.set(id, setTimeout(() => flush(id), delay));
}

function flush(id) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (!unsaved.has(id)) return saving.get(id);
  const run = (saving.get(id) || Promise.resolve()).then(() => saveNow(id));
  saving.set(id, run);
  run.finally(() => { if (saving.get(id) === run) saving.delete(id); });
  return run;
}

async function saveNow(id) {
  const a = assignments.find(x => x.id === id);
  const f = $(`f-${id}`);
  if (!f) return;
  const v = values(f);
  if (!v.score) return;
  if (matchesSaved(a, v)) { unsaved.delete(id); dropDraft(id); return; }
  $(`saved-${id}`).textContent = 'Saving…';
  let res;
  try {
    res = a.review
      ? await sb.from('reviews').update(v).eq('assignment_id', id).select().single()
      : await sb.from('reviews').insert({ ...v, assignment_id: id }).select().single();
  } catch (err) {
    res = { error: err };
  }
  if (res.error) {
    failed.add(id);
    $(`saved-${id}`).textContent = 'Not saved yet. Trying again…';
    say('rv-msg', `Your latest changes to paper #${a.submission.paper_no} aren't saved yet (${res.error.message}). They are kept in this browser and the page keeps retrying. Please leave it open until it says "Saved".`, 'bad');
    if (!timers.has(id)) timers.set(id, setTimeout(() => flush(id), 10000));
    return;
  }
  a.review = res.data;
  failed.delete(id);
  if (!failed.size) show('rv-msg', false);
  $(`pill-${id}`).textContent = 'Score saved';
  $(`pill-${id}`).className = 'pill ok';
  lede();
  // If they kept typing during the save, that change has its own timer.
  if (matchesSaved(a, values(f))) {
    unsaved.delete(id);
    dropDraft(id);
    $(`saved-${id}`).textContent = `Saved ${stamp(a.review.updated_at)}`;
  }
}

// Bring back changes from an earlier visit that never reached the server.
function restoreDraft(id, f) {
  const d = readDraft(id);
  if (!d) return;
  const a = assignments.find(x => x.id === id);
  if (matchesSaved(a, d) || (!d.score && !d.comments)) return dropDraft(id);
  const r = d.score && f.querySelector(`input[type=radio][value="${d.score}"]`);
  if (r) {
    r.checked = true;
    $(`scale-${id}`).textContent = SCALE[d.score];
  }
  f.elements.comments.value = d.comments || '';
  edited(id, 0);
}

// Save anything pending when the tab is hidden or closed, and warn before leaving
// with changes the server doesn't have.
const flushAll = () => { for (const id of [...timers.keys(), ...unsaved]) flush(id); };
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushAll(); });
window.addEventListener('online', flushAll);
window.addEventListener('beforeunload', e => {
  flushAll();
  if (unsaved.size || saving.size) { e.preventDefault(); e.returnValue = ''; }
});

async function onUser(user) {
  show('loading', false);
  show('signin', !user);
  show('reviews', false);
  show('notice', false);
  if (!user) return;

  // Filter by email: organizers can read every reviewer row, not just their own.
  const { data: me } = await sb.from('reviewers').select('id, name')
    .eq('email', user.email.toLowerCase()).maybeSingle();
  if (!me) {
    return say('notice', `${user.email} isn't on the review committee's list. If your invitation went to a different address, sign out and sign in with that one, or write to mwittconference@utk.edu.`, 'warn');
  }
  const { data, error } = await sb.from('assignments')
    .select(`id, due_on, submission:submissions(id, paper_no, program, title, presenter_name, presenter_affiliation, coauthors, abstract, pdf_path,
             meeting:meetings(id, name, starts_on, review_instructions)), review:reviews(score, comments, submitted_at, updated_at)`)
    .eq('reviewer_id', me.id);
  if (error) return say('notice', `Couldn't load your papers: ${error.message}`, 'bad');

  assignments = data.filter(a => a.submission).map(a => ({ ...a, review: Array.isArray(a.review) ? a.review[0] || null : a.review }));
  $('rv-heading').textContent = `Welcome, ${me.name.split(' ')[0]}`;
  show('reviews');
  if (!assignments.length) {
    $('rv-lede').textContent = 'You have no papers to review right now. You will get an email when a batch is assigned to you.';
    $('rv-meetings').replaceChildren();
    return;
  }
  render();
}

setupAuth(onUser);
