# Classroom Arena — *Think. Move. Win.*

A real-time multiplayer **3-Piece Tic-Tac-Toe** platform for classrooms: local
pass-and-play, online matchmaking, classroom codes, Elo ratings, ranks,
leaderboards, and match history — built on plain HTML/CSS/JS + Supabase.

This is a working codebase, not a mockup. The game engine has an automated
unit-test suite (12 groups / 20+ assertions, all passing), and the entire
Supabase schema — RLS policies, triggers, and every RPC function — was
verified against a real, throwaway PostgreSQL 16 instance during development:
challenge → accept → play a full game → win detection → Elo rating update →
match history → idempotency, a blocked direct-table write, an out-of-turn
move, a post-game move, a move-limit draw, and quick-match pairing all ran
and produced the expected results. See "How this was tested" below for the
exact scenarios.

---

## 1. What you need to provide

This app needs a **Supabase project** (free tier is enough for a classroom).
You cannot run the online features without one — Claude cannot provision a
live Supabase project on your behalf. Local Game works with zero setup.

### Step-by-step setup

1. Create a project at [supabase.com](https://supabase.com) (free tier is fine).
2. In the Supabase dashboard, open **SQL Editor** → paste in the entire
   contents of `sql/schema.sql` → **Run**. This creates every table, RLS
   policy, trigger, and function in one shot. It's safe to re-run.
3. In **Authentication → Providers**, make sure **Email** is enabled. For a
   fast classroom setup, also turn **off** "Confirm email" under
   **Authentication → Sign In / Providers → Email** so students can sign up
   and play immediately without checking an inbox.
4. In **Project Settings → API**, copy:
   - **Project URL**
   - **anon / public** key (do **not** use the `service_role` key anywhere
     in this app — that key must never reach the browser)
5. Copy `config.example.js` to `config.js` (same folder as `index.html`) and
   paste those two values in:

   ```js
   window.CLASSROOM_ARENA_CONFIG = {
     SUPABASE_URL: 'https://your-project-ref.supabase.co',
     SUPABASE_ANON_KEY: 'eyJ...',
   };
   ```
6. In **Database → Replication**, confirm `matches`, `challenges`, and
   `profiles` are enabled for Realtime (the schema's final lines already do
   this via `alter publication supabase_realtime add table ...`, but it's
   worth a glance if live sync doesn't seem to update).
7. Serve the folder over HTTP (not `file://`, since ES modules and the
   Supabase SDK require it):

   ```bash
   npx serve .
   # or: python3 -m http.server 8080
   ```

   Then deploy the static folder anywhere (Vercel, Netlify, GitHub Pages,
   Cloudflare Pages, a plain S3 bucket) — it's pure static HTML/CSS/JS, no
   build step, no server code beyond Supabase itself.

If `config.js` is missing or still has placeholder values, the app shows a
banner at the top and Local Game still works — nothing else silently fails
or fakes data.

---

## 2. Project structure

```
/index.html                Single-page app shell — every screen lives here
/config.example.js         Copy to config.js and fill in your Supabase keys
/css/styles.css            All styling (dark competitive-gaming theme)
/js/
  game.js                  Pure 3-piece Tic-Tac-Toe rules engine (no DOM, no network)
  rating.js                Elo math + rank tiers (client-side preview only)
  supabaseClient.js         Supabase SDK bootstrap
  auth.js                  Sign up / log in / log out / session
  classroom.js             Classroom-code create/join
  lobby.js                 Presence, online player list, challenges
  multiplayer.js            Quick match, live match sync, move submission, timer, rematch
  leaderboard.js            Classroom + global rankings
  profile.js                Profile stats + match history
  ui.js                    DOM rendering helpers (board renderer, screens, toasts)
  app.js                   Wires everything together — the only file that touches the DOM directly
/sql/schema.sql            Full Postgres schema: tables, indexes, RLS, triggers, RPC functions
```

---

## 3. How the security model works (spec section 27)

The browser is **never** trusted with rating, win/loss records, or the
board itself. Every table that matters is locked down:

- `matches`, `match_history` have **no** client `INSERT`/`UPDATE`/`DELETE`
  privileges at all (`REVOKE ... FROM authenticated`). A user with dev tools
  open cannot set `winner = 'me'` or `rating = 99999`, because the database
  itself refuses the write before RLS is even consulted.
- The **only** way to affect a match is through `SECURITY DEFINER` RPC
  functions (`make_move`, `forfeit_on_timeout`, `try_matchmake`,
  `respond_to_challenge`, ...) that re-validate everything server-side:
  whose turn it is, which pieces belong to whom, whether a cell is empty,
  whether the placement/movement phase rules were followed, whether the
  turn timer's real (server clock) deadline has passed, and — on game end —
  compute the Elo change and streaks themselves.
- `profiles` allows a user to update only their own row, and the scoring
  columns (`rating`, `wins`, `losses`, ...) are only ever touched inside
  `finalize_match()`, which runs once per match (guarded by checking
  `match_history` for an existing row — verified idempotent in testing).
- RLS `SELECT` policies scope what a user can even read: a match is only
  visible to its two participants; match history rows are only visible to
  the player they belong to.

## 4. How this was tested

I don't have a live Supabase project to point at, so I couldn't test the
deployed app end-to-end in a browser. What I *could* do, and did:

- **Game engine (`js/game.js`)** — ran a 12-group Node.js test suite
  directly against the module: placement limits, illegal moves, all 8 win
  lines, move-limit draws, 3-fold repeated-position draws, serialize
  round-trips, and turn/ownership rules. All passing.
- **Full SQL schema** — spun up a real, disposable PostgreSQL 16 instance,
  shimmed a minimal `auth.users` / `auth.uid()` / role setup to approximate
  Supabase's environment, loaded `sql/schema.sql` with zero errors, and ran
  it through actual gameplay via the same RPC calls the browser makes:
  - two users sign up → profiles auto-created by trigger
  - challenge sent → accepted → match created
  - a direct client `UPDATE` on `matches` is rejected (privilege system)
  - a full game played move-by-move through `make_move()`, alternating
    turns, ending in a real 3-in-a-row win with the correct `win_line`
  - an out-of-turn move is rejected
  - Elo ratings updated correctly and symmetrically (+16 / −16 at equal
    1000/1000 ratings, K=32) with matching `match_history` rows
  - calling `finalize_match()` again does **not** double-apply the rating
    change (idempotency)
  - a move submitted after the game already ended is rejected
  - a move-limit (100-move) draw is correctly detected and recorded
  - `try_matchmake()` correctly leaves a lone queued player unmatched and
    pairs the second player the moment they queue, emptying the queue
- **All 11 JS modules** — syntax-checked cleanly.

What I could **not** test without a live project: the actual browser UI
end-to-end, Supabase Realtime message delivery over a real socket, and
Supabase Auth's email flow. The RPC/RLS layer those features sit on top of
is exactly what was verified above.

## 5. Known follow-ups / things to sanity-check after deploying

- `challenges.expires_at` (30s) and `matches.turn_deadline` (30s) are both
  currently hard-coded in `sql/schema.sql` — tune these if 30 seconds feels
  too fast for your classroom.
- The turn-timeout forfeit currently relies on a connected client calling
  `forfeit_on_timeout()` once its local countdown hits 0 (either player can
  trigger it, and the server independently checks the real deadline, so
  this can't be gamed by a tampered client). If **both** players disconnect
  before either calls it, the match will just sit expired until someone
  reconnects — a Supabase Edge Function on a cron schedule would be the
  natural place to sweep these server-side if that matters for your use case.
- `getMatchHistory()` in `js/profile.js` joins `profiles` via the
  `match_history_opponent_id_fkey` constraint name that Postgres generates
  by default from `sql/schema.sql`. If you rename that column/constraint,
  update the join hint in `js/profile.js` to match.

## Classroom Management Fix

The classroom management screen now:
- shows each classroom only once in the UI, including protection against legacy duplicate classroom codes;
- makes ENTER switch the active classroom reliably;
- shows DELETE only to the user whose `created_by` matches their authenticated user ID;
- keeps the classroom creator badge visible;
- deletes classroom membership via the guarded `delete_classroom` RPC while preserving match history by detaching its classroom reference;
- blocks creation of a new classroom when its code already exists, including databases that contain legacy duplicate codes.

### Supabase SQL

Run the current `sql/schema.sql` in the Supabase SQL Editor once after updating the project. The `delete_classroom(uuid)` RPC is restricted to authenticated users and still verifies ownership inside the database.
