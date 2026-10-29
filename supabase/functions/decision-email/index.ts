// decision-email: called from the organizer dashboard's Decisions tab.
//   mode "test": emails the calling organizer one Accept and one Decline example, using
//                this program's wording and its first decided papers. Nothing is marked.
//   mode "send": emails every paper in the program at this meeting with the given decision
//                ("accepted" or "declined"; accepts usually go days before declines) that
//                isn't emailed yet or withdrawn: to the presenting author only. Each sent paper
//                gets decisions.sent_at and its status set to accepted/declined, which is
//                when the author first sees the decision.
// Only the program's organizers at this meeting can call it.
//
// Secrets: RESEND_API_KEY (shared with the other email functions).
// Deploy: npx -y supabase@2.121.0 functions deploy decision-email --no-verify-jwt --use-api
//         --project-ref nvparnlljxvgapsddqzf   (the function checks the sign-in itself)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const FROM = 'Midwest Trade & Theory Conference <portal@mail.midwesttradetheory.org>';
const REPLY_TO = 'mwittconference@utk.edu';
const ORIGINS = ['https://portal.midwesttradetheory.org', 'http://localhost:8000'];
const PROGRAM_NAME: Record<string, string> = { Trade: 'International Trade', Theory: 'Economic Theory' };
const BATCH = 50;   // emails per Resend batch call (its limit is 100)

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
  { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

// Same look as the other portal emails.
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
const p = (html: string) => `<p style="margin:0 0 16px;">${html}</p>`;

// Fills the placeholders. {where} is left out (with its brackets) when the meeting has
// no place or dates yet.
function render(tpl: { subject: string; body: string }, s: any, m: any) {
  // "April 16–18, 2027", or "March 30–April 1, 2027" across a month end.
  const start = m.starts_on ? fmtDay(m.starts_on).replace(/, \d{4}$/, '') : '';
  const dates = !m.starts_on ? '' : m.starts_on.slice(0, 7) === m.ends_on?.slice(0, 7)
    ? `${start}–${Number(m.ends_on.slice(8, 10))}, ${m.ends_on.slice(0, 4)}`
    : `${start}–${fmtDay(m.ends_on)}`;
  const where = [m.location || m.host, dates].filter(Boolean).join(', ');
  const values: Record<string, string> = {
    name: s.presenter_name, title: s.title, paper: (s.program === 'Theory' ? 'ET' : 'IT') + s.paper_no,
    program: PROGRAM_NAME[s.program] || s.program, meeting: m.name, where,
  };
  const fill = (t: string) => (where ? t : t.replace(/\s*\(\{where\}\)/g, '').replace(/,?\s*\{where\}/g, ''))
    .replace(/\{(\w+)\}/g, (all, k) => k in values ? values[k] : all);
  const subject = (m.demo ? '[Demo] ' : '') + oneLine(fill(tpl.subject));
  const text = fill(tpl.body).trim();
  const html = layout(esc(oneLine(fill(tpl.subject))),
    text.split(/\n\s*\n/).map(par => p(esc(par.trim()).replace(/\n/g, '<br>'))).join(''));
  return { subject, text: `${text}\n\nQuestions? Reply to this email or write to ${REPLY_TO}.`, html };
}

async function sha256(s: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function resendBatch(emails: object[], key: string) {
  const res = await fetch('https://api.resend.com/emails/batch', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': key,   // a retry of the same batch within 24 hours isn't sent twice
    },
    body: JSON.stringify(emails),
  });
  if (!res.ok) console.error('Resend', res.status, await res.text());
  return res.ok;
}

// The author's page may go away while this runs; finish anyway (see submission-email).
declare const EdgeRuntime: { waitUntil(p: Promise<unknown>): void };
Deno.serve(req => {
  const done = handle(req);
  EdgeRuntime.waitUntil(done);
  return done;
});

async function handle(req: Request) {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const reply = (status: number, body: object) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await admin.auth.getUser(token);
  if (!auth?.user?.email) return reply(401, { error: 'Not signed in' });

  const { meeting_id, program, mode, decision } = await req.json().catch(() => ({}));
  if (!['Trade', 'Theory'].includes(program) || !['test', 'send'].includes(mode)
      || (mode === 'send' && !['accepted', 'declined'].includes(decision))) return reply(400, { error: 'Bad request' });
  const { data: m } = await admin.from('meetings').select('*').eq('id', meeting_id).maybeSingle();
  if (!m) return reply(404, { error: 'No such meeting' });
  const { data: roles } = await admin.from('organizers').select('meeting_id')
    .eq('user_id', auth.user.id).eq('program', program);
  if (!roles?.some(o => !o.meeting_id || o.meeting_id === m.id)) return reply(403, { error: "Not an organizer of this program" });

  const tpls = m.decision_emails?.[program];
  if (!tpls?.accepted || !tpls?.declined) return reply(400, { error: 'This program has no decision emails yet' });

  const { data: rows, error } = await admin.from('submissions')
    .select('id, paper_no, program, title, presenter_name, presenter_email, status, decision:decisions!inner(decision, sent_at)')
    .eq('meeting_id', m.id).eq('program', program).neq('status', 'withdrawn')
    .is('decision.sent_at', null).order('paper_no');
  if (error) return reply(500, { error: error.message });
  const papers = (rows || []).map(s => ({ ...s, decision: Array.isArray(s.decision) ? s.decision[0] : s.decision }));

  if (mode === 'test') {
    const example = (d: string) => papers.find(s => s.decision.decision === d) || {
      paper_no: 1, program, title: 'An Example Paper Title', presenter_name: 'Jane Author', presenter_email: '',
    };
    const emails = ['accepted', 'declined'].map(d => {
      const e = render(tpls[d], example(d), m);
      return { from: FROM, reply_to: REPLY_TO, to: auth.user!.email, subject: `[Test] ${e.subject}`, text: e.text, html: e.html };
    });
    const ok = await resendBatch(emails, `decision-test-${crypto.randomUUID()}`);
    return ok ? reply(200, { sent: 2 }) : reply(502, { error: 'The email service refused the message' });
  }

  const toSend = papers.filter(s => s.decision.decision === decision);
  let sent = 0, failed = 0;
  for (let i = 0; i < toSend.length; i += BATCH) {
    const chunk = toSend.slice(i, i + BATCH);
    const emails = chunk.map(s => {
      const e = render(tpls[s.decision.decision], s, m);
      return { from: FROM, reply_to: REPLY_TO, to: s.presenter_email, subject: e.subject, text: e.text, html: e.html };
    });
    const key = 'decisions-' + await sha256(chunk.map(s => `${s.id}:${s.decision.decision}`).join(','));
    if (!await resendBatch(emails, key)) { failed += chunk.length; continue; }
    const ids = chunk.map(s => s.id);
    await admin.from('decisions').update({ sent_at: new Date().toISOString() }).in('submission_id', ids);
    await admin.from('submissions').update({ status: decision }).in('id', ids);
    sent += chunk.length;
  }
  return reply(failed && !sent ? 502 : 200, { sent, failed });
}
