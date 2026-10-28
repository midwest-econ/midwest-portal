// submission-email: called by the portal right after an author saves a submission.
// Sends the author a receipt ("received" on first submit, "updated" on edits) and
// tells each newly listed coauthor, once, that they're on the paper. A new Trade paper
// that makes another 10 waiting for a reviewer also emails the Trade organizers.
//
// It reads the submission from the database itself (never trusts the request body
// beyond the id) and only acts on the caller's own submission, saved in the last
// few minutes, so it can't be used to send arbitrary email.
//
// Secrets (Supabase → Edge Functions → Secrets): RESEND_API_KEY.
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase automatically.
// Deploy: npx supabase functions deploy submission-email --no-verify-jwt --use-api
//         --project-ref nvparnlljxvgapsddqzf   (the function checks the sign-in itself)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const PORTAL = 'https://portal.midwesttradetheory.org/';
const FROM = 'Midwest Trade & Theory Conference <portal@mail.midwesttradetheory.org>';
const REPLY_TO = 'mwittconference@utk.edu';
const ORIGINS = ['https://portal.midwesttradetheory.org', 'http://localhost:8000'];
const FRESH_MS = 5 * 60 * 1000;   // only email about saves made in the last 5 minutes

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

function cors(req: Request) {
  const origin = req.headers.get('origin') || '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(origin) ? origin : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

const fmtDay = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US',
  { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const fmtDeadline = (t: string) => new Date(t).toLocaleString('en-US',
  { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric',
    minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' });

// ---------------------------------------------------------------- email layout
// Same look as the sign-in emails in supabase/email-templates/.
function layout(heading: string, body: string) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6f8;padding:24px 0;font-family:Georgia,'Times New Roman',serif;">
  <tr><td align="center">
    <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-top:4px solid #226e93;">
      <tr><td style="padding:28px 32px 8px;">
        <p style="margin:0;font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#226e93;font-family:Arial,Helvetica,sans-serif;">Midwest Trade &amp; Theory Conference</p>
        <h1 style="margin:8px 0 0;font-size:22px;font-weight:normal;color:#1f2a33;">${heading}</h1>
      </td></tr>
      <tr><td style="padding:16px 32px;font-size:16px;line-height:1.5;color:#1f2a33;">${body}</td></tr>
      <tr><td style="padding:16px 32px 28px;border-top:1px solid #e3e7ea;font-size:13px;line-height:1.5;color:#55626d;font-family:Arial,Helvetica,sans-serif;">
        Questions? Reply to this email or write to <a href="mailto:${REPLY_TO}" style="color:#226e93;">${REPLY_TO}</a>.
      </td></tr>
    </table>
  </td></tr>
</table>`;
}

const p = (html: string, small = false) => small
  ? `<p style="margin:0 0 16px;font-size:14px;color:#55626d;">${html}</p>`
  : `<p style="margin:0 0 16px;">${html}</p>`;

function summary(rows: [string, string][]) {
  const tr = rows.map(([k, v]) => `<tr>
    <td style="padding:6px 12px 6px 0;vertical-align:top;font-size:13px;color:#55626d;font-family:Arial,Helvetica,sans-serif;white-space:nowrap;">${k}</td>
    <td style="padding:6px 0;vertical-align:top;font-size:15px;color:#1f2a33;">${v}</td></tr>`).join('');
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px;border-top:1px solid #e3e7ea;width:100%;">${tr}</table>`;
}

// ---------------------------------------------------------------- sending
async function send(msg: { to: string | string[]; subject: string; html: string; text: string }, key?: string) {
  const headers: Record<string, string> = {
    'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
    'Content-Type': 'application/json',
  };
  if (key) headers['Idempotency-Key'] = key;   // Resend drops repeats for 24 hours
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify({ from: FROM, reply_to: REPLY_TO, ...msg, subject: oneLine(msg.subject) }),
  });
  if (!res.ok) console.error('Resend', res.status, await res.text());
  return res.ok;
}

// ---------------------------------------------------------------- handler
Deno.serve(async req => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const reply = (status: number, body: object) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  // Who is calling? The portal sends the signed-in author's session token.
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await admin.auth.getUser(token);
  const user = auth?.user;
  if (!user?.email) return reply(401, { error: 'Not signed in' });

  const { id } = await req.json().catch(() => ({}));
  const { data: s } = await admin.from('submissions')
    .select('*, meeting:meetings(*)').eq('id', id).maybeSingle();
  if (!s || s.user_id !== user.id) return reply(404, { error: 'No such submission' });
  if (Date.now() - new Date(s.updated_at).getTime() > FRESH_MS) return reply(200, { sent: 0 });

  const m = s.meeting;
  const tag = m.demo ? '[Demo] ' : '';
  const portal = m.demo ? `${PORTAL}?meeting=${m.id}` : PORTAL;
  const first = s.created_at === s.updated_at;   // only inserts leave these equal
  const where = [m.location || m.host,
    m.starts_on ? `${fmtDay(m.starts_on).replace(/, \d{4}$/, '')}–${fmtDay(m.ends_on)}` : '']
    .filter(Boolean).join(', ');
  const meetingText = `the ${m.name} meetings${where ? ` (${where})` : ''}`;
  const deadline = m.submission_deadline ? fmtDeadline(m.submission_deadline) : 'to be announced';
  const coauthors: { name: string; affiliation?: string; email: string }[] = s.coauthors || [];
  const person = (c: { name: string; affiliation?: string }) =>
    c.affiliation ? `${c.name} (${c.affiliation})` : c.name;
  const presenter = person({ name: s.presenter_name, affiliation: s.presenter_affiliation });
  let sent = 0;

  // 1. Receipt to the presenting author.
  const rows: [string, string][] = [   // label, plain value (escaped for the HTML copy)
    ['Program', s.program],
    ['Title', s.title],
    ['Presenting', presenter],
    ['Coauthors', coauthors.map(person).join('\n') || 'None'],
    ['Paper', s.pdf_path ? 'PDF uploaded' : 'No PDF yet'],
    ['Abstract', s.abstract],
  ];
  const heading = first ? 'Submission received' : 'Submission updated';
  const lead = first
    ? `Thank you. We've received your paper for ${meetingText}.`
    : `Your submission for ${meetingText} has been updated. This is what we now have:`;
  const editNote = `You can edit your submission and replace the PDF until the deadline (${deadline}) at`;
  const coNote = coauthors.length && first ? 'We\'re letting your coauthors know they are listed on the paper.' : '';
  if (await send({
    to: user.email,
    subject: `${tag}${heading}: ${s.title}`,
    html: layout(heading,
      p(esc(lead)) +
      summary(rows.map(([k, v]) => [k, esc(v).replace(/\n/g, '<br>')])) +
      p(`${esc(editNote)} <a href="${portal}" style="color:#226e93;">${portal.replace(/^https:\/\/|\/$/g, '')}</a>.`, true) +
      (coNote ? p(coNote, true) : '')),
    text: [lead, '', ...rows.map(([k, v]) => `${k}: ${v.replace(/\n/g, '; ')}`), '',
      `${editNote} ${portal}`, ...(coNote ? ['', coNote] : []),
      '', `Questions? Reply to this email or write to ${REPLY_TO}.`].join('\n'),
  })) sent++;

  // 2. One notice to each coauthor not told before (and not the presenter).
  const told = new Set<string>(s.notified_coauthors || []);
  const fresh = coauthors.filter(c => {
    const e = c.email?.trim().toLowerCase();
    return e && !told.has(e) && e !== user.email!.toLowerCase();
  });
  for (const c of fresh) {
    const e = c.email.trim().toLowerCase();
    const body =
      p(`${esc(presenter)} has submitted <b>${esc(s.title)}</b> to the ${esc(s.program)} program of ${esc(meetingText)} and listed you, ${esc(c.name)}, as a coauthor.`) +
      p(`You don't need to do anything. The presenting author submits and edits the paper. If something isn't right, please contact ${esc(s.presenter_name)} at <a href="mailto:${esc(user.email)}" style="color:#226e93;">${esc(user.email)}</a>.`, true);
    const ok = await send({
      to: c.email.trim(),
      subject: `${tag}You're listed as a coauthor: ${s.title}`,
      html: layout('You\'re listed as a coauthor', body),
      text: `${presenter} has submitted "${s.title}" to the ${s.program} program of ${meetingText} and listed you, ${c.name}, as a coauthor.\n\n` +
        `You don't need to do anything. The presenting author submits and edits the paper. If something isn't right, please contact ${s.presenter_name} at ${user.email}.\n\n` +
        `Questions? Reply to this email or write to ${REPLY_TO}.`,
    }, `coauthor-${s.id}-${e}`);
    if (ok) { told.add(e); sent++; }
  }
  if (fresh.length) {
    await admin.from('submissions').update({ notified_coauthors: [...told] }).eq('id', s.id);
  }

  // 3. A new paper may make another 10 waiting for a reviewer: tell the organizers.
  if (first && ALERT_PROGRAMS.includes(s.program)) sent += await batchAlert(m, s.program);

  return reply(200, { sent });
});

// ---------------------------------------------------------------- batch alert
// Each time the number of papers with no reviewer reaches another multiple of 10
// (10, 20, ...), every organizer of the program gets one email. batch_alerts
// (006_batch_alerts.sql) holds the last multiple reported; it comes back down as
// papers are assigned, so the next 10 to arrive are reported again.
const ALERT_PROGRAMS = ['Trade'];
const BATCH = 10;

async function batchAlert(m: any, program: string) {
  const { data: subs, error } = await admin.from('submissions')
    .select('id, assignments(id)').eq('meeting_id', m.id).eq('program', program).neq('status', 'withdrawn');
  if (error) { console.error('batchAlert', error.message); return 0; }
  const waiting = (subs || []).filter(x => !x.assignments?.length).length;
  const tens = Math.floor(waiting / BATCH);

  const key = { meeting_id: m.id, program };
  await admin.from('batch_alerts').upsert(key, { onConflict: 'meeting_id,program', ignoreDuplicates: true });
  await admin.from('batch_alerts').update({ alerted_tens: tens }).match(key).gt('alerted_tens', tens);
  // Only one of two simultaneous calls can raise it, so only one emails.
  const { data: won } = await admin.from('batch_alerts').update({ alerted_tens: tens })
    .match(key).lt('alerted_tens', tens).select();
  if (!won?.length) return 0;

  const { data: roles } = await admin.from('organizers').select('user_id, meeting_id').eq('program', program);
  const ids = [...new Set((roles || []).filter(o => !o.meeting_id || o.meeting_id === m.id).map(o => o.user_id))];
  const emails = (await Promise.all(ids.map(id => admin.auth.admin.getUserById(id))))
    .map(r => r.data?.user?.email).filter(Boolean) as string[];
  if (!emails.length) return 0;

  const page = PORTAL + 'organizer.html' + (m.demo ? `?meeting=${m.id}` : '') + '#batch';
  const lead = `${waiting} ${program} papers for the ${m.name} meetings are waiting for a reviewer.`;
  const how = `Open the organizer page and choose "Send a batch": it lists the papers with no reviewer, oldest first, with the first ${BATCH} ticked. This email goes to every ${program} organizer, so someone may already be on it.`;
  const ok = await send({
    to: emails,
    subject: `${m.demo ? '[Demo] ' : ''}${waiting} ${program} papers are waiting for a reviewer`,
    html: layout(`${waiting} ${esc(program)} papers are waiting`,
      p(esc(lead)) +
      p(`<a href="${page}" style="display:inline-block;background:#226e93;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;">Send a batch</a>`) +
      p(esc(how), true)),
    text: [lead, '', `Organizer page: ${page}`, how].join('\n'),
  });
  // Unsent: let the next new paper try again.
  if (!ok) await admin.from('batch_alerts').update({ alerted_tens: tens - 1 }).match(key).eq('alerted_tens', tens);
  return ok ? 1 : 0;
}
