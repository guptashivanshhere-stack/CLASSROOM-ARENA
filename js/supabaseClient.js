// supabaseClient.js
// Loads the Supabase JS SDK from a CDN as an ES module and creates a single
// shared client, configured from window.CLASSROOM_ARENA_CONFIG (see config.js).
//
// config.js is intentionally NOT committed with real values — copy
// config.example.js to config.js and fill in your own project's URL and
// anon (public) key. See README.md "Setup" for exactly where to find these.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = window.CLASSROOM_ARENA_CONFIG;

if (!cfg || !cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY || cfg.SUPABASE_URL.includes('YOUR-PROJECT')) {
  // Fail loudly and visibly rather than silently pretending to work.
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('config-warning');
    if (el) el.hidden = false;
  });
  console.error(
    'Classroom Arena: missing/placeholder Supabase config. ' +
    'Copy config.example.js to config.js and fill in your project URL + anon key.'
  );
}

export const supabase = createClient(
  cfg?.SUPABASE_URL || 'https://placeholder.supabase.co',
  cfg?.SUPABASE_ANON_KEY || 'placeholder',
  {
    auth: { persistSession: true, autoRefreshToken: true },
    realtime: { params: { eventsPerSecond: 10 } },
  }
);

export function isConfigured() {
  return Boolean(cfg && cfg.SUPABASE_URL && !cfg.SUPABASE_URL.includes('YOUR-PROJECT'));
}
