// Shared by the organizer dashboard and the review page: the Supabase client,
// email sign-in, and small display helpers. (Submit a Paper predates this file
// and keeps its own copies in app.js.)
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { wireSignIn } from './signin.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
export const $ = id => document.getElementById(id);

export function show(id, on = true) { $(id).hidden = !on; }

export function say(id, text, kind) {
  const el = $(id);
  el.textContent = text;
  el.className = 'msg ' + kind;
  el.hidden = !text;
}

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const fmtDate = d => new Date(d + 'T12:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
export const fmtStamp = t => new Date(t).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtDeadline = t => new Date(t).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short' });

export const SCALE = {
  6: 'Excellent paper of general interest; definitely should be on the program',
  5: 'Good paper; should be on the program',
  4: 'Competent paper; should be on the program if there is room',
  3: 'Of interest only to those working in the area; on the program if there is space',
  2: 'Marginal paper; on the program only if there is room',
  1: 'Should not be on the program',
};

export const STATUS = {
  submitted:    ['Received', 'info'],
  under_review: ['Under review', 'info'],
  accepted:     ['Accepted', 'ok'],
  waitlisted:   ['Waitlisted', 'warn'],
  declined:     ['Not accepted', 'bad'],
  withdrawn:    ['Withdrawn', 'bad'],
};

export const people = s => [s.presenter_name, ...(s.coauthors || []).map(c => c.name)].join(', ');

// Opens a private PDF through a short-lived link.
export async function openPdf(path, msgId) {
  const { data, error } = await sb.storage.from('papers').createSignedUrl(path, 300);
  if (error) say(msgId, `Couldn't open the PDF: ${error.message}`, 'bad');
  else window.open(data.signedUrl, '_blank', 'noopener');
}

// Wires the standard sign-in form (see signin.js) and sign-out link, and calls
// onUser(user or null) whenever the signed-in person changes.
export function setupAuth(onUser) {
  wireSignIn(sb, say);
  $('sign-out').addEventListener('click', () => sb.auth.signOut());

  let current;
  sb.auth.onAuthStateChange((_event, session) => {
    const user = session?.user || null;
    if (location.href.endsWith('#')) history.replaceState(null, '', location.pathname + location.search);
    if ((user?.id || null) === current) return;
    current = user?.id || null;
    show('userbar', !!user);
    if (user) $('user-email').textContent = user.email;
    setTimeout(() => onUser(user), 0);
  });
}
