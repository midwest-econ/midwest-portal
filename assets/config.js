// Public connection settings for the Supabase project.
// The publishable key is meant to be public: access is controlled by the
// database's row level security rules, not by hiding this key.
// Never put the secret / service_role key in this repository.
export const SUPABASE_URL = 'https://nvparnlljxvgapsddqzf.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_TLN2xy5eVmEqxJP386r77w_huBr6uKw';

// The public Google Site the portal links back to.
export const SITE = 'https://sites.google.com/view/midwesttradetheoryconference';

// The two conferences. Each has its own Submit a Paper page, /trade and /theory
// (trade.html and theory.html send people to index.html?program=trade or =theory).
// The email functions in supabase/functions/ keep their own copy of these names.
export const CONFERENCES = {
  Trade:  { name: 'Midwest International Trade Conference', field: 'international trade', path: 'trade' },
  Theory: { name: 'Midwest Economic Theory Conference',     field: 'economic theory',     path: 'theory' },
};

export const MAX_PDF_MB = 20;
export const MAX_ABSTRACT_WORDS = 250;
