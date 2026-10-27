// signin-code: a meeting admin gets a one-time sign-in code for someone whose code
// emails aren't arriving, to pass on from their own email or by phone. Nothing is
// emailed. The person enters it on any portal page under "I already have a code".
// It works once, for an hour (the Supabase email-code expiry), and asking for
// another code, here or on a sign-in page, replaces it. Each code given out is
// logged in signin_codes_given (004_signin_help.sql).
//
// Deploy: npx -y supabase@2.121.0 functions deploy signin-code --no-verify-jwt --use-api
//         --project-ref nvparnlljxvgapsddqzf   (the function checks the sign-in itself)
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

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

Deno.serve(async req => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  const reply = (status: number, body: object) =>
    new Response(JSON.stringify(body), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
  if (req.method !== 'POST') return reply(405, { error: 'POST only' });

  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const { data: auth } = await admin.auth.getUser(token);
  if (!auth?.user) return reply(401, { error: 'Not signed in' });

  const { data: roles } = await admin.from('organizers').select('meeting_admin').eq('user_id', auth.user.id);
  if (!roles?.some(r => r.meeting_admin)) return reply(403, { error: 'Only meeting admins can give out sign-in codes' });

  const { email: raw } = await req.json().catch(() => ({}));
  const email = String(raw || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply(400, { error: 'Enter a valid email address' });

  // The account must exist and be confirmed: someone whose first code email never
  // arrived has an unconfirmed account, or none at all.
  const { data: id, error: lookupErr } = await admin.rpc('user_id_for_email', { e: email });
  if (lookupErr) return reply(500, { error: lookupErr.message });
  const { error: accountErr } = id
    ? await admin.auth.admin.updateUserById(id, { email_confirm: true })
    : await admin.auth.admin.createUser({ email, email_confirm: true });
  if (accountErr) return reply(500, { error: accountErr.message });

  // Makes a code without sending anything.
  const { data, error } = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  const code = data?.properties?.email_otp;
  if (error || !code) return reply(500, { error: error?.message || 'No code came back' });

  const { error: logErr } = await admin.from('signin_codes_given').insert({ email, given_by_email: auth.user.email });
  if (logErr) console.error('signin_codes_given', logErr.message);
  return reply(200, { email, code });
});
