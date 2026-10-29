// Organizer dashboard: every submission with its reviews, sending batches of
// papers to reviewers or assigning them in a grid, the reviewer list, and meeting settings. Only signed-in
// organizers get data back; the access rules are in the database.
import { sb, $, show, say, esc, fmtStamp, fmtDeadline, people, paperId, openPdf, setupAuth, STATUS } from './common.js';

// Each organizer works on one program (Trade or Theory), for every meeting or for one
// meeting. The database only returns their own program's data; this page also hides
// the other program's controls.
let roles = [], meetings = [], meeting = null, myPrograms = [], subs = [], reviewers = [];
const isAdmin = () => roles.some(r => r.meeting_admin);

const lower = s => (s || '').trim().toLowerCase();
const reviewsOf = s => s.assignments.filter(a => a.review);
const mean = xs => xs.length ? xs.reduce((t, x) => t + x, 0) / xs.length : null;
const reviewerById = id => reviewers.find(r => r.id === id);
// The demo meeting has its own test reviewers (008_demo_reviewers.sql); real meetings never list them.
const sameKind = r => !!r.demo === !!meeting.demo;
const authorEmails = s => [s.presenter_email, ...(s.coauthors || []).map(c => c.email)].map(lower);
const affiliations = s => [s.presenter_affiliation, ...(s.coauthors || []).map(c => c.affiliation)].map(lower).filter(Boolean);
const sameSchool = (s, r) => !!r.affiliation && affiliations(s).some(a => a.includes(lower(r.affiliation)) || lower(r.affiliation).includes(a));

// ---------------------------------------------------------------- loading
async function load() {
  const [s, r] = await Promise.all([
    sb.from('submissions')
      .select('*, assignments(id, reviewer_id, invited_at, created_at, review:reviews(score, comments, updated_at)), decision:decisions(decision, decided_at, sent_at)')
      .eq('meeting_id', meeting.id).order('program', { ascending: false }).order('paper_no'),   // Trade first
    sb.from('reviewers').select('*').order('name'),
  ]);
  if (s.error || r.error) return say('dash-msg', `Couldn't load the data: ${(s.error || r.error).message}`, 'bad');
  subs = s.data.map(x => ({
    ...x,
    assignments: x.assignments.map(a => ({ ...a, review: Array.isArray(a.review) ? a.review[0] || null : a.review })),
    decision: Array.isArray(x.decision) ? x.decision[0] || null : x.decision,
  }));
  reviewers = r.data;
  renderPapers(); renderBatchForm(); renderBatches(); renderGrid(); renderDecisions(); fillDecisionEmails(); renderReviewers(); fillSettings();
}

function pickMeeting(id) {
  meeting = meetings.find(m => m.id === id) || meetings[0];
  myPrograms = ['Trade', 'Theory'].filter(p => roles.some(r => r.program === p && (!r.meeting_id || r.meeting_id === meeting.id)));
  const days = meeting.starts_on ? ` · ${new Date(meeting.starts_on + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}–${new Date(meeting.ends_on + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}` : '';
  $('meeting-line').textContent = `${meeting.name} meetings · ${myPrograms.join(' & ')} program${days}`;
  show('demo-note', meeting.demo);

  // Show only this organizer's program(s).
  for (const el of document.querySelectorAll('[data-prog]')) el.hidden = !myPrograms.includes(el.dataset.prog);
  for (const el of document.querySelectorAll('[data-both]')) el.hidden = myPrograms.length < 2;
  const firstOf = name => document.querySelector(`[name=${name}][value="${myPrograms.length > 1 && name === 'p-prog' ? '' : myPrograms[0]}"]`);
  firstOf('p-prog').checked = true;
  firstOf('b-prog').checked = true;
  firstOf('d-prog').checked = true;
  // The grid is mostly for Theory, where a few reviewers share every paper.
  document.querySelector(`[name=g-prog][value="${myPrograms.includes('Theory') ? 'Theory' : myPrograms[0]}"]`).checked = true;
  show('s-admin', isAdmin());
  show('help-panel', isAdmin());
  if (isAdmin()) loadHelpLog();
  return load();
}

// ---------------------------------------------------------------- tabs
for (const b of document.querySelectorAll('.tabs [data-tab]')) {
  b.addEventListener('click', () => {
    for (const x of document.querySelectorAll('.tabs [data-tab]')) {
      x.classList.toggle('on', x === b);
      show(`tab-${x.dataset.tab}`, x === b);
    }
    show('dash-msg', false);
  });
}
// organizer.html#batch (the link in the "papers waiting" email) opens that tab.
document.querySelector(`.tabs [data-tab="${location.hash.slice(1)}"]`)?.click();

// ---------------------------------------------------------------- papers
$('p-status').append(...Object.entries(STATUS).map(([k, [label]]) => new Option(label, k)));
for (const el of [...document.querySelectorAll('[name=p-prog]'), $('p-status'), $('p-search')]) {
  el.addEventListener('input', renderPapers);
}

function filtered() {
  const prog = document.querySelector('[name=p-prog]:checked').value;
  const st = $('p-status').value;
  const q = lower($('p-search').value);
  return subs.filter(s => (!prog || s.program === prog) && (!st || s.status === st) &&
    (!q || lower([s.title, people(s), s.presenter_affiliation, ...(s.coauthors || []).map(c => c.affiliation)].join(' ')).includes(q)));
}

function renderPapers() {
  const list = filtered();
  const byProg = p => subs.filter(s => s.program === p && s.status !== 'withdrawn').length;
  const scored = subs.filter(s => reviewsOf(s).length).length;
  const split = myPrograms.length > 1 ? ` (${myPrograms.map(p => `${byProg(p)} ${p}`).join(', ')})` : '';
  $('p-summary').textContent = `${subs.length} ${myPrograms.join(' & ')} submissions${split} · ${scored} with at least one score · showing ${list.length}`;

  // Accepted / Not accepted come only from sending decisions (Decisions tab).
  const statusSel = s => `<select data-status="${s.id}" aria-label="Status for paper ${paperId(s)}">` +
    [...new Set([s.status, ...(s.decision?.sent_at ? [] : ['submitted', 'under_review']), 'withdrawn'])]
      .map(k => `<option value="${k}"${k === s.status ? ' selected' : ''}>${STATUS[k]?.[0] || k}</option>`).join('') + '</select>' +
    (s.decision && !s.decision.sent_at ? `<div class="small muted">Decision: ${DECISION[s.decision.decision]} (not emailed yet)</div>` : '');
  const reviewCell = s => {
    const done = reviewsOf(s), n = s.assignments.length;
    if (!n) return '<span class="muted">none</span>';
    const avg = mean(done.map(a => a.review.score));
    return `<button type="button" class="linkbtn" data-open="${s.id}">${done.length}/${n}${avg ? ` · <b>${avg.toFixed(1)}</b>` : ''}</button>`;
  };

  $('p-table').innerHTML = `<thead><tr><th>#</th><th>Program</th><th>Paper</th><th>Submitted</th><th>PDF</th><th>Scores</th><th>Status</th></tr></thead><tbody>` +
    list.map(s => `<tr>
      <td>${paperId(s)}</td>
      <td>${esc(s.program)}</td>
      <td><b>${esc(s.title)}</b><div class="small muted">${esc(people(s))} · ${esc(s.presenter_affiliation)}</div></td>
      <td class="small nowrap">${fmtStamp(s.created_at)}</td>
      <td>${s.pdf_path ? `<button type="button" class="linkbtn" data-pdf="${esc(s.pdf_path)}">PDF</button>` : '<span class="muted">none</span>'}</td>
      <td class="nowrap">${reviewCell(s)}</td>
      <td>${statusSel(s)}</td>
    </tr>
    <tr class="detail" id="d-${s.id}" hidden><td></td><td colspan="6">${detail(s)}</td></tr>`).join('') + '</tbody>';
}

function detail(s) {
  const rows = s.assignments.map(a => {
    const r = reviewerById(a.reviewer_id);
    const what = a.review
      ? `<b>${a.review.score}</b>${a.review.comments ? ` · ${esc(a.review.comments)}` : ''}`
      : `<span class="muted">not scored yet${a.invited_at ? ` · emailed ${fmtStamp(a.invited_at)}` : ' · not emailed'}</span>`;
    return `<li>${esc(r?.name || 'Removed reviewer')}: ${what}</li>`;
  });
  return `<ul class="small reviews-list">${rows.join('')}</ul><details class="small"><summary>Abstract</summary><p class="abstract">${esc(s.abstract)}</p></details>`;
}

$('p-table').addEventListener('click', e => {
  const pdf = e.target.closest('[data-pdf]');
  if (pdf) return openPdf(pdf.dataset.pdf, 'dash-msg');
  const open = e.target.closest('[data-open]');
  if (open) $(`d-${open.dataset.open}`).hidden = !$(`d-${open.dataset.open}`).hidden;
});

$('p-table').addEventListener('change', async e => {
  const sel = e.target.closest('[data-status]');
  if (!sel) return;
  const s = subs.find(x => x.id === Number(sel.dataset.status));
  const { error } = await sb.rpc('set_submission_status', { sid: s.id, new_status: sel.value });
  if (error) { sel.value = s.status; return say('dash-msg', `Status not changed: ${error.message}`, 'bad'); }
  s.status = sel.value;
  renderBatchForm(); renderGrid(); renderDecisions();
  say('dash-msg', `Paper ${paperId(s)} is now "${STATUS[s.status][0]}". Authors see this on their submission page.`, 'ok');
});

$('p-csv').addEventListener('click', () => {
  const cell = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Paper', 'Program', 'Title', 'Presenter', 'Affiliation', 'Email', 'Coauthors', 'Coauthor emails',
    'Abstract', 'Submitted', 'Last edited', 'Status', 'Decision', 'Assigned', 'Scored', 'Mean score', 'Scores and comments'];
  const rows = subs.map(s => {
    const done = reviewsOf(s);
    return [paperId(s), s.program, s.title, s.presenter_name, s.presenter_affiliation, s.presenter_email,
      (s.coauthors || []).map(c => c.affiliation ? `${c.name} (${c.affiliation})` : c.name).join('; '),
      (s.coauthors || []).map(c => c.email).join('; '),
      s.abstract, s.created_at, s.updated_at, STATUS[s.status]?.[0] || s.status,
      s.decision ? `${DECISION[s.decision.decision]}${s.decision.sent_at ? ' (emailed)' : ''}` : '',
      s.assignments.length, done.length, mean(done.map(a => a.review.score))?.toFixed(2) ?? '',
      done.map(a => `${reviewerById(a.reviewer_id)?.name}: ${a.review.score}${a.review.comments ? ` (${a.review.comments})` : ''}`).join(' | ')];
  });
  const csv = [head, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  a.download = `${meeting.id}-submissions.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
});

// ---------------------------------------------------------------- batches
const batchProg = () => document.querySelector('[name=b-prog]:checked').value;
const load_ = r => {
  const mine = subs.flatMap(s => s.assignments).filter(a => a.reviewer_id === r.id);
  return { n: mine.length, done: mine.filter(a => a.review).length };
};

const waitingFor = prog => subs.filter(s => s.program === prog && s.status !== 'withdrawn' && !s.assignments.length);

function renderBatchForm() {
  const prog = batchProg();
  const n = waitingFor(prog).length;
  $('b-waiting').innerHTML = n
    ? `<b>${n} ${prog} paper${n > 1 ? 's' : ''}</b> waiting for a reviewer.`
    : `Every ${prog} paper has a reviewer.`;
  // Reviewers with no papers yet this meeting come first: usually the next batch goes to one of them.
  const pool = reviewers.filter(r => r.active && r.program === prog && sameKind(r));
  const option = r => {
    const { n, done } = load_(r);
    return new Option(`${r.name}${r.affiliation ? `, ${r.affiliation}` : ''}${n ? ` · ${n} papers, ${done} scored` : ''}`, r.id);
  };
  const group = (label, rs) => {
    const g = document.createElement('optgroup');
    g.label = label;
    g.append(...rs.map(option));
    return rs.length ? [g] : [];
  };
  const keep = $('b-rev').value;
  $('b-rev').replaceChildren(new Option(pool.length ? 'Choose a reviewer…' : `No active ${prog} reviewers yet (add them under Reviewers)`, ''),
    ...group('No papers yet this meeting', pool.filter(r => !load_(r).n)),
    ...group('Already have papers this meeting', pool.filter(r => load_(r).n)));
  if (pool.some(r => String(r.id) === keep)) $('b-rev').value = keep;
  suggest();
}

function suggest() {
  const r = reviewerById(Number($('b-rev').value));
  if (!r) { $('b-list').replaceChildren(); $('b-send').disabled = true; $('b-count').textContent = ''; return; }
  const size = Math.max(1, Number($('b-size').value) || 10);
  const all = $('b-all').checked;
  const eligible = subs
    .filter(s => s.program === r.program && s.status !== 'withdrawn' && (all || !s.assignments.length) &&
      !s.assignments.some(a => a.reviewer_id === r.id) && !authorEmails(s).includes(r.email))
    .map(s => ({ s, school: sameSchool(s, r) }))
    .sort((x, y) => x.s.assignments.length - y.s.assignments.length || x.s.paper_no - y.s.paper_no);
  let picked = 0;
  $('b-list').innerHTML = eligible.length ? `<div class="pick-list">` + eligible.map(({ s, school }) => {
    const on = !school && !s.assignments.length && picked < size && ++picked;
    return `<label class="check"><input type="checkbox" value="${s.id}"${on ? ' checked' : ''}>
      <span>${paperId(s)} ${esc(s.title)} <span class="muted small">· ${esc(people(s))}${s.assignments.length ? ` · ${s.assignments.length} already assigned` : ''}</span>
      ${school ? '<span class="pill warn">same school</span>' : ''}</span></label>`;
  }).join('') + '</div>' : `<p class="muted small">${all ? 'No papers left for this reviewer.' : 'Every paper already has a reviewer. To give one a second reviewer, tick "Also list papers that already have a reviewer".'}</p>`;
  countPicked();
}

function countPicked() {
  const n = $('b-list').querySelectorAll('input:checked').length;
  $('b-count').textContent = n ? `${n} papers selected` : '';
  $('b-send').disabled = !n;
}

for (const el of document.querySelectorAll('[name=b-prog]')) el.addEventListener('change', renderBatchForm);
$('b-rev').addEventListener('change', suggest);
$('b-size').addEventListener('change', suggest);
$('b-all').addEventListener('change', suggest);
$('b-list').addEventListener('change', countPicked);

$('b-send').addEventListener('click', async () => {
  const r = reviewerById(Number($('b-rev').value));
  const ids = [...$('b-list').querySelectorAll('input:checked')].map(i => Number(i.value));
  if (!r || !ids.length) return;
  if (!confirm(`Assign ${ids.length} papers to ${r.name} and email them now?`)) return;
  $('b-send').disabled = true;
  const { error } = await sb.from('assignments').insert(ids.map(submission_id => ({ submission_id, reviewer_id: r.id })));
  if (error) { $('b-send').disabled = false; return say('dash-msg', `Nothing was assigned: ${error.message}`, 'bad'); }
  const sent = await emailReviewer(r, 'invite');
  await load();
  if (sent) say('dash-msg', `Assigned ${ids.length} papers to ${r.name} and emailed them at ${r.email}.`, 'ok');
});

async function emailReviewer(r, mode) {
  const { data, error } = await sb.functions.invoke('reviewer-email', { body: { reviewer_id: r.id, meeting_id: meeting.id, mode } });
  if (error || !data?.sent) {
    say('dash-msg', `The papers are assigned, but the email to ${r.name} didn't go out${error ? ` (${error.message})` : ''}. Use "Email again" under Batches sent.`, 'bad');
    return false;
  }
  return true;
}

function renderBatches() {
  const rows = reviewers.map(r => {
    const mine = subs.flatMap(s => s.assignments.map(a => ({ ...a, s }))).filter(a => a.reviewer_id === r.id);
    return { r, mine };
  }).filter(x => x.mine.length);
  $('b-table').innerHTML = rows.length
    ? `<thead><tr><th>Reviewer</th><th>Program</th><th>Papers</th><th>Scored</th><th>Last emailed</th><th></th></tr></thead><tbody>` +
      rows.map(({ r, mine }) => {
        const done = mine.filter(a => a.review).length;
        const last = mine.map(a => a.invited_at).filter(Boolean).sort().pop();
        return `<tr><td>${esc(r.name)}<div class="small muted">${esc(r.email)}</div></td><td>${esc(r.program)}</td>
          <td title="${esc(mine.map(a => paperId(a.s)).join(', '))}">${mine.length}</td>
          <td>${done === mine.length ? `<span class="pill ok">${done}</span>` : done}</td>
          <td class="small nowrap">${last ? fmtStamp(last) : '<span class="pill warn">not emailed</span>'}</td>
          <td>${done < mine.length ? `<button type="button" class="btn ghost sm" data-remind="${r.id}">Email again</button>` : ''}</td></tr>`;
      }).join('') + '</tbody>'
    : '<tbody><tr><td class="muted">No batches sent yet.</td></tr></tbody>';
}

$('b-table').addEventListener('click', async e => {
  const b = e.target.closest('[data-remind]');
  if (!b) return;
  const r = reviewerById(Number(b.dataset.remind));
  if (!confirm(`Email ${r.name} a reminder listing the papers they haven't scored yet?`)) return;
  b.disabled = true;
  if (await emailReviewer(r, 'remind')) { await load(); say('dash-msg', `Reminder sent to ${r.name}.`, 'ok'); }
  else b.disabled = false;
});

// ---------------------------------------------------------------- grid
// Papers × reviewers for one program. Ticking and unticking only changes gridAdd and
// gridDrop ("paperId:reviewerId" keys); the database changes when Save is pressed.
const gridAdd = new Set(), gridDrop = new Set();
const gridProg = () => document.querySelector('[name=g-prog]:checked').value;
const gridKey = (s, r) => `${s.id}:${r.id}`;

function gridData() {
  const prog = gridProg();
  const assigned = new Map(subs.flatMap(s => s.assignments.map(a => [`${s.id}:${a.reviewer_id}`, a])));
  // Edits the data has caught up with (e.g. a batch sent meanwhile) are dropped.
  for (const k of gridAdd) if (assigned.has(k)) gridAdd.delete(k);
  for (const k of gridDrop) if (!assigned.has(k)) gridDrop.delete(k);
  return {
    assigned,
    papers: subs.filter(s => s.program === prog && s.status !== 'withdrawn'),
    // Inactive reviewers stay listed while they hold papers, so those show.
    revs: reviewers.filter(r => r.program === prog && sameKind(r) && (r.active || subs.some(s => s.assignments.some(a => a.reviewer_id === r.id)))),
  };
}
const ticked = (assigned, k) => gridAdd.has(k) || (assigned.has(k) && !gridDrop.has(k));

function renderGrid() {
  const { assigned, papers, revs } = gridData();
  const prog = gridProg();
  if (!papers.length || !revs.length) {
    $('g-table').innerHTML = `<tbody><tr><td class="muted">${!papers.length ? `No ${prog} papers yet.` : `No ${prog} reviewers yet. Add them under Reviewers.`}</td></tr></tbody>`;
    return gridCount();
  }
  const cell = (s, r) => {
    if (authorEmails(s).includes(r.email)) return '<td class="cell muted" title="Their own paper">–</td>';
    const k = gridKey(s, r), a = assigned.get(k), on = ticked(assigned, k);
    if (a?.review) return `<td class="cell scored" title="Scored ${a.review.score}">${a.review.score}</td>`;
    const school = sameSchool(s, r);
    return `<td class="cell${school ? ' school' : ''}${on !== !!a ? ' changed' : ''}"${school ? ' title="Same school as the reviewer"' : ''}>
      <input type="checkbox" data-k="${k}" aria-label="Paper ${paperId(s)} to ${esc(r.name)}"${on ? ' checked' : ''}></td>`;
  };
  $('g-table').innerHTML = `<thead><tr><th>#</th><th>Paper</th>` +
    revs.map(r => `<th class="rev">${esc(r.name)}${r.active ? '' : ' <span class="muted">(inactive)</span>'}
      <div class="small muted" data-colcount="${r.id}"></div>${r.active ? `<button type="button" class="linkbtn" data-col="${r.id}">All</button>` : ''}</th>`).join('') +
    `<th>Reviewers</th></tr></thead><tbody>` +
    papers.map(s => `<tr><td>${paperId(s)}</td>
      <td><b>${esc(s.title)}</b><div class="small muted">${esc(people(s))}</div></td>
      ${revs.map(r => cell(s, r)).join('')}
      <td class="nowrap" data-rowcount="${s.id}"></td></tr>`).join('') + '</tbody>';
  gridCount();
}

// Per-reviewer and per-paper counts, and the pending changes, after every tick.
function gridCount() {
  const { assigned, papers, revs } = gridData();
  for (const r of revs) {
    const el = $('g-table').querySelector(`[data-colcount="${r.id}"]`);
    if (el) el.textContent = `${papers.filter(s => ticked(assigned, gridKey(s, r))).length} papers`;
  }
  for (const s of papers) {
    const el = $('g-table').querySelector(`[data-rowcount="${s.id}"]`);
    if (el) el.textContent = revs.filter(r => ticked(assigned, gridKey(s, r))).length;
  }
  const n = gridAdd.size + gridDrop.size;
  $('g-count').textContent = n
    ? [gridAdd.size && `${gridAdd.size} to assign`, gridDrop.size && `${gridDrop.size} to take back`].filter(Boolean).join(', ') + ' (not saved yet)'
    : '';
  $('g-save').disabled = $('g-undo').disabled = !n;
}

$('g-table').addEventListener('change', e => {
  const box = e.target.closest('[data-k]');
  if (!box) return;
  const { assigned } = gridData();
  const k = box.dataset.k;
  if (assigned.has(k)) box.checked ? gridDrop.delete(k) : gridDrop.add(k);
  else box.checked ? gridAdd.add(k) : gridAdd.delete(k);
  box.closest('td').classList.toggle('changed', box.checked !== assigned.has(k));
  gridCount();
});

$('g-table').addEventListener('click', e => {
  const b = e.target.closest('[data-col]');
  if (!b) return;
  const r = reviewerById(Number(b.dataset.col));
  const { assigned, papers } = gridData();
  for (const s of papers) {
    const k = gridKey(s, r);
    if (authorEmails(s).includes(r.email) || sameSchool(s, r)) continue;
    gridDrop.delete(k);
    if (!assigned.has(k)) gridAdd.add(k);
  }
  renderGrid();
});

for (const el of document.querySelectorAll('[name=g-prog]')) el.addEventListener('change', renderGrid);
$('g-undo').addEventListener('click', () => { gridAdd.clear(); gridDrop.clear(); renderGrid(); });
window.addEventListener('beforeunload', e => { if (gridAdd.size || gridDrop.size) e.preventDefault(); });

$('g-save').addEventListener('click', async () => {
  const { assigned } = gridData();
  const adds = [...gridAdd].map(k => k.split(':').map(Number));
  const drops = [...gridDrop].map(k => assigned.get(k)).filter(a => a && !a.review);
  const emailing = $('g-email').checked;
  const newFor = [...new Set(adds.map(([, rid]) => rid))].map(reviewerById);
  const what = [adds.length && `Assign ${adds.length} paper${adds.length > 1 ? 's' : ''}`,
    drops.length && `${adds.length ? 'take' : 'Take'} back ${drops.length}`].filter(Boolean).join(' and ');
  const mail = emailing && newFor.length ? ` and email ${newFor.map(r => r.name).join(', ')}` : '';
  if (!confirm(`${what}${mail}?${drops.length ? ' Reviewers are not told when a paper is taken back.' : ''}`)) return;

  $('g-save').disabled = true;
  if (drops.length) {
    const { error } = await sb.from('assignments').delete().in('id', drops.map(a => a.id));
    if (error) { $('g-save').disabled = false; return say('dash-msg', `Nothing was changed: ${error.message}`, 'bad'); }
  }
  if (adds.length) {
    const { error } = await sb.from('assignments').insert(adds.map(([submission_id, reviewer_id]) => ({ submission_id, reviewer_id })));
    if (error) { await load(); return say('dash-msg', `${drops.length ? 'Papers were taken back, but n' : 'N'}o new papers were assigned: ${error.message}`, 'bad'); }
  }
  gridAdd.clear(); gridDrop.clear();
  const failed = [];
  if (emailing) for (const r of newFor) if (!await emailReviewer(r, 'invite')) failed.push(r.name);
  await load();
  if (failed.length) return say('dash-msg', `Saved, but the email to ${failed.join(', ')} didn't go out. Use "Email again" under Send a batch → Batches sent.`, 'bad');
  say('dash-msg', `Saved${emailing && newFor.length ? ` and emailed ${newFor.length} reviewer${newFor.length > 1 ? 's' : ''}` : ''}.`, 'ok');
});

// ---------------------------------------------------------------- decisions
// Decisions (010_decisions.sql) stay hidden from authors until decision-email sends them,
// which also sets the paper's status to accepted or declined.
const DECISION = { accepted: 'Accept', declined: 'Decline' };
const meanOf = s => mean(reviewsOf(s).map(a => a.review.score));
const dProg = () => document.querySelector('[name=d-prog]:checked')?.value;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function renderDecisions() {
  const prog = dProg();
  if (!prog) return;
  const papers = subs.filter(s => s.program === prog && s.status !== 'withdrawn')
    .sort((x, y) => (meanOf(y) ?? -1) - (meanOf(x) ?? -1) || x.paper_no - y.paper_no);
  const count = d => papers.filter(s => s.decision?.decision === d).length;
  const undecided = papers.filter(s => !s.decision).length;
  const sent = papers.filter(s => s.decision?.sent_at).length;
  // Withdrawn papers are listed last, out of the counts and the sending.
  const gone = subs.filter(s => s.program === prog && s.status === 'withdrawn').sort((x, y) => x.paper_no - y.paper_no);
  $('d-summary').innerHTML = papers.length
    ? `<b>${plural(papers.length, `${prog} paper`)}</b> · ${count('accepted')} accept · ${count('declined')} decline · ${undecided} undecided · ${sent} emailed` +
      (gone.length ? ` · ${gone.length} withdrawn` : '')
    : `No ${prog} papers yet.`;

  const choice = s => s.status === 'withdrawn'
    ? `<span class="pill bad">Withdrawn</span>${s.decision ? ` <span class="small muted">was ${DECISION[s.decision.decision]}${s.decision.sent_at ? ', emailed' : ''}</span>` : ''}`
    : s.decision?.sent_at
    ? `<span class="pill ${s.decision.decision === 'accepted' ? 'ok' : 'bad'}">${DECISION[s.decision.decision]}</span> <span class="small muted">emailed ${fmtStamp(s.decision.sent_at)}</span>`
    : `<select data-decide="${s.id}" aria-label="Decision for paper ${paperId(s)}">` +
      [['', '—'], ['accepted', 'Accept'], ['declined', 'Decline']]
        .map(([v, label]) => `<option value="${v}"${(s.decision?.decision || '') === v ? ' selected' : ''}>${label}</option>`).join('') + '</select>';
  $('d-table').innerHTML = papers.length + gone.length
    ? `<thead><tr><th>#</th><th>Paper</th><th>Scores</th><th>Mean</th><th>Decision</th></tr></thead><tbody>` +
      [...papers, ...gone].map(s => {
        const scores = reviewsOf(s).map(a => a.review.score), avg = meanOf(s);
        return `<tr><td>${paperId(s)}</td>
          <td><b>${esc(s.title)}</b><div class="small muted">${esc(people(s))} · ${esc(s.presenter_affiliation)}</div></td>
          <td class="nowrap">${scores.length ? scores.join(', ') : '<span class="muted">none</span>'}</td>
          <td>${avg == null ? '' : `<b>${avg.toFixed(1)}</b>`}</td>
          <td class="nowrap">${choice(s)}</td></tr>`;
      }).join('') + '</tbody>'
    : '';

  const ready = d => papers.filter(s => s.decision?.decision === d && !s.decision.sent_at).length;
  const [acc, dec] = [ready('accepted'), ready('declined')];
  $('d-ready').innerHTML = acc || dec
    ? `Ready to send: <b>${plural(acc, 'accept email')}</b>, <b>${plural(dec, 'decline email')}</b>.` +
      (undecided ? ` ${plural(undecided, 'paper')} with no decision won't be emailed.` : '')
    : sent ? 'Every decided paper has been emailed.' : 'No decisions yet.';
  for (const [d, n, word] of [['accepted', acc, 'accept'], ['declined', dec, 'decline']]) {
    $(`d-send-${d}`).disabled = !n;
    $(`d-send-${d}`).textContent = n ? `Send ${plural(n, `${word} email`)}` : `Send the ${word} emails`;
  }
}

$('d-table').addEventListener('change', async e => {
  const sel = e.target.closest('[data-decide]');
  if (!sel) return;
  const s = subs.find(x => x.id === Number(sel.dataset.decide));
  const v = sel.value;
  // Not upsert: that would also rewrite submission_id, which organizers may not update.
  const { error } = !v ? await sb.from('decisions').delete().eq('submission_id', s.id)
    : s.decision ? await sb.from('decisions').update({ decision: v }).eq('submission_id', s.id)
    : await sb.from('decisions').insert({ submission_id: s.id, decision: v });
  if (error) { sel.value = s.decision?.decision || ''; return say('dash-msg', `Decision not saved: ${error.message}`, 'bad'); }
  s.decision = v ? { decision: v, decided_at: new Date().toISOString(), sent_at: null } : null;
  show('dash-msg', false);
  renderDecisions(); renderPapers();
});

function fillDecisionEmails() {
  const prog = dProg();
  if (!prog) return;
  const t = meeting.decision_emails?.[prog] || {};
  $('d-form-prog').textContent = `(${prog})`;
  $('d-acc-subject').value = t.accepted?.subject || '';
  $('d-acc-body').value = t.accepted?.body || '';
  $('d-dec-subject').value = t.declined?.subject || '';
  $('d-dec-body').value = t.declined?.body || '';
}

async function saveDecisionEmails() {
  const prog = dProg();
  const emails = {
    accepted: { subject: $('d-acc-subject').value.trim(), body: $('d-acc-body').value.trim() },
    declined: { subject: $('d-dec-subject').value.trim(), body: $('d-dec-body').value.trim() },
  };
  const { error } = await sb.rpc('set_decision_emails', { m: meeting.id, prog, emails });
  if (error) { say('dash-msg', `Wording not saved: ${error.message}`, 'bad'); return false; }
  meeting.decision_emails = { ...meeting.decision_emails, [prog]: emails };
  return true;
}

for (const r of document.querySelectorAll('[name=d-prog]')) r.addEventListener('change', () => { renderDecisions(); fillDecisionEmails(); });

$('d-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (await saveDecisionEmails()) say('dash-msg', `Saved the ${dProg()} decision emails.`, 'ok');
});

$('d-test').addEventListener('click', async () => {
  if (!await saveDecisionEmails()) return;
  $('d-test').disabled = true;
  const { error } = await sb.functions.invoke('decision-email', { body: { meeting_id: meeting.id, program: dProg(), mode: 'test' } });
  $('d-test').disabled = false;
  say('dash-msg', error ? `Test not sent: ${error.message}` : `Saved, and emailed you one Accept and one Decline example (subjects start with [Test]).`, error ? 'bad' : 'ok');
});

for (const b of document.querySelectorAll('[data-send]')) b.addEventListener('click', async () => {
  const prog = dProg(), decision = b.dataset.send, word = DECISION[decision].toLowerCase();
  const n = subs.filter(s => s.program === prog && s.status !== 'withdrawn' && s.decision?.decision === decision && !s.decision.sent_at).length;
  if (!confirm(`Email ${plural(n, `${prog} ${word} decision`)} now? Each presenting author gets one, with coauthors copied, and then sees the decision on their submission page. This can't be undone.`)) return;
  b.disabled = true;
  say('dash-msg', 'Sending…', 'warn');
  const { data, error } = await sb.functions.invoke('decision-email', { body: { meeting_id: meeting.id, program: prog, mode: 'send', decision } });
  await load();
  if (error) return say('dash-msg', `Sending failed: ${error.message}. Papers not sent are still waiting; you can try again.`, 'bad');
  say('dash-msg', `Sent ${plural(data.sent, `${word} email`)}.${data.failed ? ` ${data.failed} couldn't be sent and are still waiting; try again.` : ''}`, data.failed ? 'warn' : 'ok');
});

// ---------------------------------------------------------------- reviewers
function renderReviewers() {
  const list = reviewers.filter(sameKind);
  $('r-table').innerHTML = list.length
    ? `<thead><tr><th>Name</th><th>Email</th><th>Affiliation</th><th>Program</th><th>This meeting</th><th>Active</th><th></th></tr></thead><tbody>` +
      list.map(r => {
        const { n, done } = load_(r);
        return `<tr><td>${esc(r.name)}</td><td class="small">${esc(r.email)}</td><td class="small">${esc(r.affiliation || '')}</td><td>${esc(r.program)}</td>
          <td class="small">${n ? `${done}/${n} scored` : ''}</td>
          <td><input type="checkbox" data-active="${r.id}"${r.active ? ' checked' : ''} aria-label="${esc(r.name)} active"></td>
          <td>${n ? '' : `<button type="button" class="linkbtn" data-remove="${r.id}">Remove</button>`}</td></tr>`;
      }).join('') + '</tbody>'
    : `<tbody><tr><td class="muted">${meeting.demo ? 'No test reviewers yet. Add some below, with test email addresses.' : 'No reviewers yet. Add the scientific committee below.'}</td></tr></tbody>`;
}

$('r-table').addEventListener('change', async e => {
  const box = e.target.closest('[data-active]');
  if (!box) return;
  const { error } = await sb.from('reviewers').update({ active: box.checked }).eq('id', Number(box.dataset.active));
  if (error) { box.checked = !box.checked; return say('dash-msg', `Not changed: ${error.message}`, 'bad'); }
  reviewerById(Number(box.dataset.active)).active = box.checked;
  renderBatchForm();
});

$('r-table').addEventListener('click', async e => {
  const b = e.target.closest('[data-remove]');
  if (!b) return;
  const r = reviewerById(Number(b.dataset.remove));
  if (!confirm(`Remove ${r.name} from the reviewer list?`)) return;
  const { error } = await sb.from('reviewers').delete().eq('id', r.id);
  if (error?.code === '23503') return say('dash-msg', `${r.name} has papers from an earlier meeting, so they stay on the list. Untick Active instead.`, 'warn');
  if (error) return say('dash-msg', `Not removed: ${error.message}`, 'bad');
  await load();
});

// "Name, email, affiliation (may contain commas), Trade|Theory" per line.
function parseReviewers(text) {
  const rows = [], bad = [];
  for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
    const parts = line.split(/\t|,/).map(p => p.trim()).filter(Boolean);
    const at = parts.findIndex(p => /^\S+@\S+\.\S+$/.test(p));
    const prog = parts.at(-1) && ['trade', 'theory'].includes(parts.at(-1).toLowerCase()) ? parts.at(-1) : null;
    if (at < 1 || !prog) { bad.push(line); continue; }
    rows.push({
      name: parts.slice(0, at).join(' '),
      email: parts[at].toLowerCase(),
      affiliation: parts.slice(at + 1, -1).join(', ') || null,
      program: prog[0].toUpperCase() + prog.slice(1).toLowerCase(),
    });
  }
  return { rows, bad };
}

$('r-add').addEventListener('click', async () => {
  const { rows, bad } = parseReviewers($('r-bulk').value);
  if (bad.length) return say('dash-msg', `Couldn't read: "${bad[0]}". Use: name, email, affiliation, Trade or Theory.`, 'bad');
  if (!rows.length) return;
  const other = rows.find(r => !myPrograms.includes(r.program));
  if (other) return say('dash-msg', `${other.name} is listed for ${other.program}, which isn't your program. Each program adds its own reviewers.`, 'bad');
  const clash = rows.find(x => reviewers.some(r => r.email === x.email && !sameKind(r)));
  if (clash) return say('dash-msg', meeting.demo
    ? `${clash.email} is a real reviewer. Use a test address for the demo (for example name+demo@gmail.com).`
    : `${clash.email} is a test reviewer for the demo meeting. Real reviewers need a different address.`, 'bad');
  for (const x of rows) x.demo = !!meeting.demo;
  const { error } = await sb.from('reviewers').upsert(rows, { onConflict: 'email' });
  // An address already used by a reviewer this organizer can't see (a real one, for a demo-only organizer).
  if (error?.code === '42501') return say('dash-msg', 'Not saved: one of these addresses is already a reviewer outside the demo. Use a test address.', 'bad');
  if (error) return say('dash-msg', `Not saved: ${error.message}`, 'bad');
  $('r-bulk').value = '';
  await load();
  say('dash-msg', `Saved ${rows.length} reviewer${rows.length > 1 ? 's' : ''}.`, 'ok');
});

// ---------------------------------------------------------------- settings
function fillSettings() {
  $('s-open').checked = meeting.submissions_open;
  if (meeting.submission_deadline) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(new Date(meeting.submission_deadline)).map(x => [x.type, x.value]));
    $('s-date').value = `${p.year}-${p.month}-${p.day}`;
    $('s-time').value = `${p.hour}:${p.minute}`;
  }
  $('s-decide').value = meeting.decisions_on || '';
  $('s-now').textContent = meeting.submission_deadline ? `Now: ${fmtDeadline(meeting.submission_deadline)}` : 'No deadline set.';
  $('s-trade').value = meeting.review_instructions?.Trade || '';
  $('s-theory').value = meeting.review_instructions?.Theory || '';
}

$('s-form').addEventListener('submit', async e => {
  e.preventDefault();
  // Instructions: each program's organizers save only their own program's text.
  for (const p of myPrograms) {
    const body = $(p === 'Trade' ? 's-trade' : 's-theory').value.trim();
    const { error } = await sb.rpc('set_review_instructions', { m: meeting.id, prog: p, body });
    if (error) return say('dash-msg', `${p} instructions not saved: ${error.message}`, 'bad');
  }
  // Opening/closing and the deadline are meeting-wide: meeting admins only.
  if (isAdmin()) {
    const d = $('s-date').value, t = $('s-time').value || '23:59';
    const { error } = await sb.from('meetings').update({
      submissions_open: $('s-open').checked,
      // Postgres reads the zone name, so the deadline is exactly this time in Eastern.
      submission_deadline: d ? `${d} ${t}:59 America/New_York` : null,
      decisions_on: $('s-decide').value || null,
    }).eq('id', meeting.id);
    if (error) return say('dash-msg', `Deadline not saved: ${error.message}`, 'bad');
  }
  const { data } = await sb.from('meetings').select('*').eq('id', meeting.id).single();
  Object.assign(meeting, data);
  fillSettings();
  say('dash-msg', 'Settings saved.', 'ok');
});

// ---------------------------------------------------------------- sign-in help
// Meeting admins get a code for someone whose code emails aren't arriving
// (supabase/functions/signin-code); they send it on themselves.
const PORTAL = 'https://portal.midwesttradetheory.org/';

async function loadHelpLog() {
  const { data } = await sb.from('signin_codes_given').select('*').order('given_at', { ascending: false }).limit(8);
  $('h-log').innerHTML = data?.length
    ? data.map(g => `<li>${esc(g.email)} <span class="muted">· ${fmtStamp(g.given_at)} · by ${esc(g.given_by_email)}</span></li>`).join('')
    : '<li class="muted">None yet.</li>';
}

$('h-get').addEventListener('click', async () => {
  const email = $('h-email').value.trim();
  if (!email || !$('h-email').checkValidity()) return say('dash-msg', 'Enter their email address first.', 'bad');
  if (!confirm(`Get a sign-in code for ${email}? Any code they already have stops working.`)) return;
  $('h-get').disabled = true;
  const { data, error } = await sb.functions.invoke('signin-code', { body: { email } });
  $('h-get').disabled = false;
  if (error || !data?.code) {
    let why = error?.message || 'no code came back';
    try { why = (await error.context.json()).error || why; } catch {}
    return say('dash-msg', `Couldn't get a code: ${why}`, 'bad');
  }
  const page = PORTAL + $('h-page').value;
  $('h-code').textContent = data.code;
  $('h-text').value = `Your sign-in code for the Midwest Trade & Theory Conference portal is ${data.code}.

Go to ${page}, enter ${data.email}, click "I already have a code" and type in the code. It works once and expires in an hour, so please use it soon. (Asking the page to email you a new code would replace this one.)`;
  show('h-result');
  show('dash-msg', false);
  loadHelpLog();
});

$('h-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('h-text').value);
    say('dash-msg', 'Message copied. Paste it into an email to them.', 'ok');
  } catch {
    $('h-text').select();
  }
});

// ---------------------------------------------------------------- start
$('meeting-sel').addEventListener('change', e => pickMeeting(e.target.value));

async function onUser(user) {
  show('loading', false);
  show('signin', !user);
  show('dash', false);
  show('notice', false);
  if (!user) return;
  const { data: mine } = await sb.from('organizers').select('program, meeting_id, meeting_admin').eq('user_id', user.id);
  roles = mine || [];
  if (!roles.length) return say('notice', `${user.email} isn't an organizer account. Authors submit at the Submissions page; reviewers use the Review page.`, 'warn');

  const { data, error } = await sb.from('meetings').select('*').order('starts_on', { ascending: false });
  if (error) return say('notice', `Couldn't load meetings: ${error.message}`, 'bad');
  // Only the meetings this person organizes (all of them for an unscoped role).
  // Real meetings first; the demo meeting (if any) last.
  meetings = data.filter(m => roles.some(r => !r.meeting_id || r.meeting_id === m.id))
    .sort((a, b) => a.demo - b.demo);
  if (!meetings.length) return say('notice', 'Your organizer role is for a meeting that no longer exists. Write to mwittconference@utk.edu.', 'warn');
  $('meeting-sel').replaceChildren(...meetings.map(m => new Option(m.name, m.id)));
  show('meeting-pick', meetings.length > 1);
  show('dash');
  const named = meetings.find(m => m.id === new URLSearchParams(location.search).get('meeting'));
  const current = named || meetings.find(m => m.submissions_open && !m.demo) || meetings[0];
  $('meeting-sel').value = current.id;
  await pickMeeting(current.id);
}

setupAuth(onUser);
