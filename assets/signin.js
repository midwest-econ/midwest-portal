// Email sign-in with a one-time code, used by every page. Step 1 emails a code;
// step 2 checks it, and Supabase signs the person in (each page's auth listener
// takes it from there). The email has no link on purpose: university mail filters
// hold messages with sign-in links, or open the links to scan them and use them up.
// "I already have a code" skips sending, for a code an organizer gave out (sending
// one would replace it).
// Pages provide #signin-form, #signin-email, #signin-msg, the send step (#send-row,
// #signin-btn, #code-have) and the code step (#code-step, #signin-code, #code-btn,
// #code-resend, #code-change).
const $ = id => document.getElementById(id);
const HELP = 'Having trouble signing in? Email mwittconference@utk.edu and we will help.';

export function wireSignIn(sb, say) {
  const email = $('signin-email'), code = $('signin-code');
  let sentTo = null;

  function codeStep(on) {
    $('code-step').hidden = !on;
    $('send-row').hidden = on;
    email.readOnly = on;
    code.value = '';
    if (on) code.focus();
  }

  async function send() {
    const addr = email.value.trim();
    if (!addr) return;
    $('signin-btn').disabled = $('code-resend').disabled = true;
    const { error } = await sb.auth.signInWithOtp({ email: addr });
    $('signin-btn').disabled = $('code-resend').disabled = false;
    if (error) return say('signin-msg', `Couldn't send the code: ${error.message.replace(/\.$/, '')}. ${HELP}`, 'bad');
    sentTo = addr;
    codeStep(true);
    say('signin-msg', `We emailed a sign-in code to ${addr}. It can take a minute or two. If it doesn't arrive, check your spam or quarantine folder for mail from portal@mail.midwesttradetheory.org. ${HELP}`, 'ok');
  }

  async function verify() {
    const token = code.value.replace(/\D/g, '');
    if (token.length < 6) return say('signin-msg', 'Enter the code from the email.', 'bad');
    $('code-btn').disabled = true;
    const { error } = await sb.auth.verifyOtp({ email: sentTo, token, type: 'email' });
    $('code-btn').disabled = false;
    if (error) return say('signin-msg', `That code didn't work. It may be mistyped, expired (codes last an hour) or already used. Check it, or send a new code. ${HELP}`, 'bad');
    // Signed in: reset the form for the next sign-in after a sign-out.
    say('signin-msg', '', 'ok');
    codeStep(false);
  }

  $('signin-form').addEventListener('submit', e => {
    e.preventDefault();
    $('code-step').hidden ? send() : verify();
  });
  $('code-resend').addEventListener('click', send);
  $('code-have').addEventListener('click', () => {
    if (!email.checkValidity() || !email.value.trim()) return say('signin-msg', 'Enter your email address first.', 'bad');
    sentTo = email.value.trim();
    codeStep(true);
    say('signin-msg', '', 'ok');
  });
  $('code-change').addEventListener('click', () => {
    sentTo = null;
    codeStep(false);
    say('signin-msg', '', 'ok');
    email.focus();
  });
}

// Sign out of this browser's session only. If that fails (a network problem) or
// hangs (supabase-js can get stuck in a tab left open), drop the stored session
// and reload the page signed out.
export function wireSignOut(sb) {
  $('sign-out').addEventListener('click', async () => {
    const done = sb.auth.signOut({ scope: 'local' }).then(r => !r.error, () => false);
    const ok = await Promise.race([done, new Promise(r => setTimeout(() => r(false), 3000))]);
    if (ok) return;
    try {
      for (const k of Object.keys(localStorage)) if (/^sb-.*-auth-token$/.test(k)) localStorage.removeItem(k);
    } catch {}
    location.reload();
  });
}
