// reviewer-email: called from the organizer dashboard after assigning a batch.
//   mode "invite": tells the reviewer how many new papers (not yet emailed) they have
//                  for this meeting, with the instructions, the due date and the review link.
//   mode "remind": reminds the reviewer how many they haven't scored yet.
// Paper titles aren't listed; the reviewer sees them on the review page.
// Only organizers can call it; the reviewer and papers are read from the database.
//
// Secrets: RESEND_API_KEY (shared with submission-email).
// Deploy: npx -y supabase@2.121.0 functions deploy reviewer-email --no-verify-jwt --use-api
//         --project-ref nvparnlljxvgapsddqzf   (the function checks the sign-in itself)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const REVIEW = 'https://portal.midwesttradetheory.org/review.html';
const FROM = 'Midwest Trade & Theory Conference <portal@mail.midwesttradetheory.org>';
const REPLY_TO = 'mwittconference@utk.edu';
const ORIGINS = ['https://portal.midwesttradetheory.org', 'http://localhost:8000'];

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
const fmtDue = (d: string) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US',
  { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

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
const p = (html: string, style = '') => `<p style="margin:0 0 16px;${style}">${html}</p>`;

Deno.serve(async req => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const reply = (status: number, body: object) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await admin.auth.getUser(token);
  if (!auth?.user) return reply(401, { error: 'Not signed in' });

  const { reviewer_id, meeting_id, mode = 'invite' } = await req.json().catch(() => ({}));
  const [{ data: r }, { data: m }] = await Promise.all([
    admin.from('reviewers').select('*').eq('id', reviewer_id).maybeSingle(),
    admin.from('meetings').select('*').eq('id', meeting_id).maybeSingle(),
  ]);
  if (!r || !m) return reply(404, { error: 'No such reviewer or meeting' });

  // Only organizers of this reviewer's program at this meeting (Trade and Theory are
  // kept apart, and a Theory host's role may cover one meeting only).
  const { data: roles } = await admin.from('organizers').select('meeting_id')
    .eq('user_id', auth.user.id).eq('program', r.program);
  if (!roles?.some(o => !o.meeting_id || o.meeting_id === m.id)) return reply(403, { error: "Not an organizer of this reviewer's program" });

  const { data: rows, error } = await admin.from('assignments')
    .select('id, due_on, invited_at, submission:submissions!inner(meeting_id), review:reviews(score)')
    .eq('reviewer_id', r.id).eq('submission.meeting_id', m.id);
  if (error) return reply(500, { error: error.message });

  const scored = (a: any) => Array.isArray(a.review) ? a.review.length > 0 : !!a.review;
  const list = (rows || [])
    .filter(a => mode === 'remind' ? !scored(a) : !a.invited_at);
  if (!list.length) return reply(200, { sent: 0, note: 'Nothing to send' });

  const n = list.length;
  const due = list.map(a => a.due_on).filter(Boolean).sort()[0];
  const first = r.name.split(' ')[0];
  const papers = `${n} ${r.program} paper${n > 1 ? 's' : ''}`;
  const instructions = (m.review_instructions?.[r.program] || '').trim();

  const heading = mode === 'remind' ? 'A reminder about your reviews' : 'Papers to review';
  const lead = mode === 'remind'
    ? `Dear ${first}, this is a reminder that ${n === 1 ? 'one paper is' : `${n} papers are`} still waiting for your score for the ${m.name} meetings${due ? `, due ${fmtDue(due)}` : ''}.`
    : `Dear ${first}, thank you for reviewing for the ${m.name} meetings. We've assigned you ${papers}${due ? `, with scores due ${fmtDue(due)}` : ''}.`;
  const how = `Open the review page and sign in with this email address (${r.email}). We'll email you a sign-in code; there is no password. Each paper's PDF, abstract and score form are on the page, and your scores save as you go.`;

  const html = layout(heading,
    p(esc(lead)) +
    p(`<a href="${REVIEW}" style="display:inline-block;background:#226e93;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:4px;font-family:Arial,Helvetica,sans-serif;font-size:15px;">Open the review page</a>`) +
    p(esc(how), 'font-size:14px;color:#55626d;') +
    (instructions && mode === 'invite'
      ? `<div style="margin:0 0 16px;padding:14px 16px;background:#f4f8fa;border-left:3px solid #226e93;font-size:14px;line-height:1.5;">${esc(instructions).replace(/\n/g, '<br>')}</div>`
      : ''));
  const text = [lead, '', `Review page: ${REVIEW}`, how,
    ...(instructions && mode === 'invite' ? ['', instructions] : []), '',
    `Questions? Reply to this email or write to ${REPLY_TO}.`].join('\n');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${Deno.env.get('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM, reply_to: REPLY_TO, to: r.email, text, html,
      subject: mode === 'remind'
        ? `Reminder: ${n} ${r.program} paper${n > 1 ? 's' : ''} to score for the ${m.name} meetings`
        : `${papers} to review for the ${m.name} meetings`,
    }),
  });
  if (!res.ok) {
    console.error('Resend', res.status, await res.text());
    return reply(502, { sent: 0, error: 'The email service refused the message' });
  }

  await admin.from('assignments').update({ invited_at: new Date().toISOString() }).in('id', list.map(a => a.id));
  return reply(200, { sent: 1, papers: n });
});
