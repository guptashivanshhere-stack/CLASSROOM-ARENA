-- ============================================================================
-- CLASSROOM ARENA — Supabase schema
-- Run this whole file once in the Supabase SQL editor (or via `supabase db push`).
-- It creates tables, indexes, RLS policies, triggers, and the authoritative
-- RPC functions that are the ONLY way match/rating state is ever written.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Extensions
-- ---------------------------------------------------------------------------
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. profiles
-- One row per auth.users row. Created automatically on signup (trigger below).
-- ---------------------------------------------------------------------------
create table if not exists profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  username         text not null unique,
  avatar_url       text,
  rating           integer not null default 1000,
  wins             integer not null default 0,
  losses           integer not null default 0,
  draws            integer not null default 0,
  games_played     integer not null default 0,
  current_streak   integer not null default 0,
  best_streak      integer not null default 0,
  status           text not null default 'offline' check (status in ('available','in_game','offline')),
  created_at       timestamptz not null default now(),
  last_seen        timestamptz not null default now()
);

create index if not exists idx_profiles_rating on profiles (rating desc);
create index if not exists idx_profiles_username on profiles (lower(username));

alter table profiles enable row level security;

-- Anyone authenticated can read public profile info (needed for lobby/leaderboard).
create policy "profiles are readable by authenticated users"
  on profiles for select
  to authenticated
  using (true);

-- A user may only ever update their own row, and never the scoring columns —
-- those are only ever touched by the SECURITY DEFINER functions below.
create policy "users update only their own non-scoring profile fields"
  on profiles for update
  to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- Row is created by the handle_new_user trigger, not by direct client insert.
revoke insert on profiles from authenticated;

-- ---------------------------------------------------------------------------
-- 2. classrooms
-- ---------------------------------------------------------------------------
create table if not exists classrooms (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  code        text not null unique,
  created_by  uuid not null references profiles(id),
  created_at  timestamptz not null default now()
);

create index if not exists idx_classrooms_code on classrooms (upper(code));

alter table classrooms enable row level security;

create policy "classrooms are readable by authenticated users"
  on classrooms for select
  to authenticated
  using (true);

create policy "authenticated users can create a classroom"
  on classrooms for insert
  to authenticated
  with check (created_by = auth.uid());

-- ---------------------------------------------------------------------------
-- 3. classroom_members
-- ---------------------------------------------------------------------------
create table if not exists classroom_members (
  id             uuid primary key default gen_random_uuid(),
  classroom_id   uuid not null references classrooms(id) on delete cascade,
  user_id        uuid not null references profiles(id) on delete cascade,
  joined_at      timestamptz not null default now(),
  unique (classroom_id, user_id)
);

create index if not exists idx_classroom_members_classroom on classroom_members (classroom_id);
create index if not exists idx_classroom_members_user on classroom_members (user_id);

alter table classroom_members enable row level security;

create policy "members readable by authenticated users"
  on classroom_members for select
  to authenticated
  using (true);

create policy "a user may add only themselves to a classroom"
  on classroom_members for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "a user may remove only themselves from a classroom"
  on classroom_members for delete
  to authenticated
  using (user_id = auth.uid());

-- ---------------------------------------------------------------------------
-- 4. matches
-- board_state is a JSON array of 9 cells: null | 'X' | 'O'.
-- phase: 'placement' | 'movement' (tracked per player via piece counts, but we
-- also store it directly per side for cheap client rendering).
-- ---------------------------------------------------------------------------
create table if not exists matches (
  id                 uuid primary key default gen_random_uuid(),
  player_x           uuid not null references profiles(id),
  player_o           uuid not null references profiles(id),
  classroom_id       uuid references classrooms(id),
  board_state        jsonb not null default '[null,null,null,null,null,null,null,null,null]',
  current_turn       text not null default 'X' check (current_turn in ('X','O')),
  status             text not null default 'placement_phase'
                        check (status in (
                          'game_starting','placement_phase','movement_phase',
                          'game_over','draw','abandoned','rematch_pending'
                        )),
  winner              text check (winner in ('X','O','draw',null)),
  win_line             jsonb,
  move_count           integer not null default 0,
  x_pieces_placed       integer not null default 0,
  o_pieces_placed       integer not null default 0,
  selected_cell         integer,
  position_history       jsonb not null default '[]', -- for repeated-position draw detection
  turn_deadline           timestamptz,
  rematch_requested_by    uuid references profiles(id),
  started_at              timestamptz not null default now(),
  ended_at                timestamptz
);

create index if not exists idx_matches_player_x on matches (player_x);
create index if not exists idx_matches_player_o on matches (player_o);
create index if not exists idx_matches_status on matches (status);
create index if not exists idx_matches_classroom on matches (classroom_id);

alter table matches enable row level security;

create policy "participants can read their own match"
  on matches for select
  to authenticated
  using (auth.uid() = player_x or auth.uid() = player_o);

-- No direct insert/update/delete from clients — only via SECURITY DEFINER RPCs.
revoke insert, update, delete on matches from authenticated;

-- ---------------------------------------------------------------------------
-- 5. match_history
-- ---------------------------------------------------------------------------
create table if not exists match_history (
  id              uuid primary key default gen_random_uuid(),
  match_id        uuid not null references matches(id),
  player_id       uuid not null references profiles(id),
  opponent_id     uuid not null references profiles(id),
  result          text not null check (result in ('win','loss','draw')),
  rating_before   integer not null,
  rating_change   integer not null,
  rating_after    integer not null,
  duration_seconds integer,
  created_at      timestamptz not null default now()
);

create index if not exists idx_match_history_player on match_history (player_id, created_at desc);

alter table match_history enable row level security;

create policy "a user can read only their own match history"
  on match_history for select
  to authenticated
  using (player_id = auth.uid());

revoke insert, update, delete on match_history from authenticated;

-- ---------------------------------------------------------------------------
-- 6. challenges
-- ---------------------------------------------------------------------------
create table if not exists challenges (
  id              uuid primary key default gen_random_uuid(),
  challenger_id   uuid not null references profiles(id),
  challenged_id   uuid not null references profiles(id),
  status          text not null default 'pending' check (status in ('pending','accepted','declined','expired','cancelled')),
  match_id        uuid references matches(id),
  created_at      timestamptz not null default now(),
  expires_at      timestamptz not null default (now() + interval '30 seconds')
);

create index if not exists idx_challenges_challenged on challenges (challenged_id, status);
create index if not exists idx_challenges_challenger on challenges (challenger_id, status);

alter table challenges enable row level security;

create policy "participants can read their own challenges"
  on challenges for select
  to authenticated
  using (auth.uid() = challenger_id or auth.uid() = challenged_id);

create policy "a user can create a challenge as themselves"
  on challenges for insert
  to authenticated
  with check (challenger_id = auth.uid() and challenged_id <> auth.uid());

-- Status changes (accept/decline/cancel) go through RPCs below so the match
-- creation side-effect stays consistent; block direct client updates.
revoke update on challenges from authenticated;

-- ---------------------------------------------------------------------------
-- 7. matchmaking_queue (backing table for Quick Match)
-- ---------------------------------------------------------------------------
create table if not exists matchmaking_queue (
  user_id       uuid primary key references profiles(id) on delete cascade,
  rating        integer not null,
  classroom_id  uuid references classrooms(id),
  joined_at     timestamptz not null default now()
);

alter table matchmaking_queue enable row level security;

create policy "a user can see their own queue row"
  on matchmaking_queue for select
  to authenticated
  using (user_id = auth.uid());

create policy "a user can enqueue only themselves"
  on matchmaking_queue for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "a user can dequeue only themselves"
  on matchmaking_queue for delete
  to authenticated
  using (user_id = auth.uid());

-- ============================================================================
-- TRIGGERS
-- ============================================================================

-- Auto-create a profile row when a new auth user signs up.
-- Username is taken from the signup metadata the client passes in.
create or replace function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into profiles (id, username, avatar_url)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'player_' || substr(new.id::text, 1, 8)),
    new.raw_user_meta_data->>'avatar_url'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ============================================================================
-- RANK TIER HELPER
-- ============================================================================
create or replace function rank_for_rating(p_rating integer)
returns text
language sql
immutable
as $$
  select case
    when p_rating >= 2000 then 'Grandmaster'
    when p_rating >= 1800 then 'Master'
    when p_rating >= 1600 then 'Diamond'
    when p_rating >= 1400 then 'Platinum'
    when p_rating >= 1200 then 'Gold'
    when p_rating >= 1000 then 'Silver'
    else 'Bronze'
  end;
$$;

-- ============================================================================
-- CHALLENGE FLOW RPCs
-- ============================================================================

create or replace function respond_to_challenge(p_challenge_id uuid, p_accept boolean)
returns uuid -- returns new match id if accepted, null if declined
language plpgsql
security definer set search_path = public
as $$
declare
  v_challenge challenges%rowtype;
  v_match_id uuid;
begin
  select * into v_challenge from challenges where id = p_challenge_id for update;

  if v_challenge is null then
    raise exception 'Challenge not found';
  end if;
  if v_challenge.challenged_id <> auth.uid() then
    raise exception 'Only the challenged player may respond';
  end if;
  if v_challenge.status <> 'pending' then
    raise exception 'Challenge is no longer pending';
  end if;
  if v_challenge.expires_at < now() then
    update challenges set status = 'expired' where id = p_challenge_id;
    raise exception 'Challenge has expired';
  end if;

  if not p_accept then
    update challenges set status = 'declined' where id = p_challenge_id;
    return null;
  end if;

  insert into matches (player_x, player_o, status, turn_deadline)
  values (v_challenge.challenger_id, v_challenge.challenged_id, 'placement_phase', now() + interval '30 seconds')
  returning id into v_match_id;

  update challenges set status = 'accepted', match_id = v_match_id where id = p_challenge_id;
  update profiles set status = 'in_game' where id in (v_challenge.challenger_id, v_challenge.challenged_id);

  return v_match_id;
end;
$$;

create or replace function cancel_challenge(p_challenge_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
begin
  update challenges
  set status = 'cancelled'
  where id = p_challenge_id
    and status = 'pending'
    and challenger_id = auth.uid();
end;
$$;

-- ============================================================================
-- QUICK MATCH / MATCHMAKING RPCs
-- ============================================================================

-- Call repeatedly (e.g. every 2s) from the client while "Searching..." is shown.
-- Server-authoritative: rating range widens with wait time, not client input.
create or replace function try_matchmake(p_classroom_id uuid default null)
returns uuid -- returns match id once matched, else null
language plpgsql
security definer set search_path = public
as $$
declare
  v_me profiles%rowtype;
  v_my_queue matchmaking_queue%rowtype;
  v_opponent matchmaking_queue%rowtype;
  v_wait_seconds integer;
  v_range integer;
  v_match_id uuid;
begin
  select * into v_me from profiles where id = auth.uid();

  select * into v_my_queue from matchmaking_queue where user_id = auth.uid();
  if v_my_queue is null then
    insert into matchmaking_queue (user_id, rating, classroom_id)
    values (auth.uid(), v_me.rating, p_classroom_id)
    returning * into v_my_queue;
  end if;

  v_wait_seconds := extract(epoch from (now() - v_my_queue.joined_at));
  -- Widen the search window the longer a player waits: 100 -> 200 -> 400 -> 800.
  v_range := least(800, 100 * power(2, floor(v_wait_seconds / 5))::integer);

  select * into v_opponent
  from matchmaking_queue
  where user_id <> auth.uid()
    and abs(rating - v_me.rating) <= v_range
    and (p_classroom_id is null or classroom_id = p_classroom_id)
  order by abs(rating - v_me.rating) asc, joined_at asc
  limit 1
  for update skip locked;

  if v_opponent is null then
    return null;
  end if;

  delete from matchmaking_queue where user_id in (auth.uid(), v_opponent.user_id);

  insert into matches (player_x, player_o, classroom_id, status, turn_deadline)
  values (auth.uid(), v_opponent.user_id, p_classroom_id, 'placement_phase', now() + interval '30 seconds')
  returning id into v_match_id;

  update profiles set status = 'in_game' where id in (auth.uid(), v_opponent.user_id);

  return v_match_id;
end;
$$;

create or replace function leave_matchmaking_queue()
returns void
language sql
security definer set search_path = public
as $$
  delete from matchmaking_queue where user_id = auth.uid();
$$;

-- ============================================================================
-- CORE GAME MOVE RPC — the single authoritative write path for gameplay.
-- action:
--   {"type": "place", "cell": 4}
--   {"type": "move",  "from": 2, "to": 5}
-- ============================================================================

create or replace function make_move(p_match_id uuid, p_action jsonb)
returns matches
language plpgsql
security definer set search_path = public
as $$
declare
  v_match matches%rowtype;
  v_symbol text;
  v_board jsonb;
  v_cell integer;
  v_from integer;
  v_to integer;
  v_placed_count integer;
  v_winner text;
  v_win_line jsonb;
  v_is_draw boolean := false;
  v_repeat_count integer;
begin
  select * into v_match from matches where id = p_match_id for update;

  if v_match is null then
    raise exception 'Match not found';
  end if;
  if v_match.status not in ('placement_phase','movement_phase') then
    raise exception 'Match is not in progress';
  end if;
  if v_match.turn_deadline is not null and v_match.turn_deadline < now() then
    raise exception 'Turn timer has expired — call forfeit_on_timeout instead';
  end if;

  if auth.uid() = v_match.player_x then
    v_symbol := 'X';
  elsif auth.uid() = v_match.player_o then
    v_symbol := 'O';
  else
    raise exception 'You are not a participant in this match';
  end if;

  if v_symbol <> v_match.current_turn then
    raise exception 'It is not your turn';
  end if;

  v_board := v_match.board_state;

  if p_action->>'type' = 'place' then
    v_cell := (p_action->>'cell')::integer;

    v_placed_count := case when v_symbol = 'X' then v_match.x_pieces_placed else v_match.o_pieces_placed end;
    if v_placed_count >= 3 then
      raise exception 'All 3 pieces already placed — you must move, not place';
    end if;
    if v_cell < 0 or v_cell > 8 then
      raise exception 'Invalid cell';
    end if;
    if v_board->v_cell <> 'null'::jsonb then
      raise exception 'Cell is occupied';
    end if;

    v_board := jsonb_set(v_board, array[v_cell::text], to_jsonb(v_symbol));

    if v_symbol = 'X' then
      v_match.x_pieces_placed := v_match.x_pieces_placed + 1;
    else
      v_match.o_pieces_placed := v_match.o_pieces_placed + 1;
    end if;

  elsif p_action->>'type' = 'move' then
    v_from := (p_action->>'from')::integer;
    v_to := (p_action->>'to')::integer;

    v_placed_count := case when v_symbol = 'X' then v_match.x_pieces_placed else v_match.o_pieces_placed end;
    if v_placed_count < 3 then
      raise exception 'You must finish placing all 3 pieces before moving';
    end if;
    if v_from < 0 or v_from > 8 or v_to < 0 or v_to > 8 then
      raise exception 'Invalid cell';
    end if;
    if v_board->v_from <> to_jsonb(v_symbol) then
      raise exception 'You can only move your own piece';
    end if;
    if v_board->v_to <> 'null'::jsonb then
      raise exception 'Destination cell is occupied';
    end if;

    v_board := jsonb_set(v_board, array[v_from::text], 'null');
    v_board := jsonb_set(v_board, array[v_to::text], to_jsonb(v_symbol));
  else
    raise exception 'Unknown action type';
  end if;

  v_match.board_state := v_board;
  v_match.move_count := v_match.move_count + 1;
  v_match.selected_cell := null;

  -- Advance phase once both players have placed all 3.
  if v_match.x_pieces_placed >= 3 and v_match.o_pieces_placed >= 3 then
    v_match.status := 'movement_phase';
  end if;

  -- --- Win check: all 8 lines ---
  select line, sym into v_win_line, v_winner
  from (
    values
      ('[0,1,2]'::jsonb),('[3,4,5]'::jsonb),('[6,7,8]'::jsonb),
      ('[0,3,6]'::jsonb),('[1,4,7]'::jsonb),('[2,5,8]'::jsonb),
      ('[0,4,8]'::jsonb),('[2,4,6]'::jsonb)
  ) as lines(line)
  cross join lateral (
    select v_board->(line->>0)::int as a, v_board->(line->>1)::int as b, v_board->(line->>2)::int as c
  ) cells
  cross join lateral (
    select case
      when cells.a is not null and cells.a <> 'null'::jsonb and cells.a = cells.b and cells.b = cells.c
      then cells.a #>> '{}'
      else null
    end as sym
  ) result
  where result.sym is not null
  limit 1;

  if v_winner is not null then
    v_match.status := 'game_over';
    v_match.winner := v_winner;
    v_match.win_line := v_win_line;
    v_match.ended_at := now();
  else
    -- --- Draw check: move limit ---
    if v_match.move_count >= 100 then
      v_is_draw := true;
    else
      -- --- Draw check: repeated position (3-fold) ---
      v_match.position_history := v_match.position_history || jsonb_build_array(v_board);
      select count(*) into v_repeat_count
      from jsonb_array_elements(v_match.position_history) as pos
      where pos = v_board;
      if v_repeat_count >= 3 then
        v_is_draw := true;
      end if;
    end if;

    if v_is_draw then
      v_match.status := 'draw';
      v_match.winner := 'draw';
      v_match.ended_at := now();
    else
      v_match.current_turn := case when v_symbol = 'X' then 'O' else 'X' end;
      v_match.turn_deadline := now() + interval '30 seconds';
    end if;
  end if;

  update matches set
    board_state = v_match.board_state,
    status = v_match.status,
    winner = v_match.winner,
    win_line = v_match.win_line,
    move_count = v_match.move_count,
    x_pieces_placed = v_match.x_pieces_placed,
    o_pieces_placed = v_match.o_pieces_placed,
    selected_cell = v_match.selected_cell,
    position_history = v_match.position_history,
    current_turn = v_match.current_turn,
    turn_deadline = v_match.turn_deadline,
    ended_at = v_match.ended_at
  where id = p_match_id;

  if v_match.status in ('game_over','draw') then
    perform finalize_match(p_match_id);
  end if;

  select * into v_match from matches where id = p_match_id;
  return v_match;
end;
$$;

-- Lets a client mark which piece is "selected" for the movement-phase UI.
-- Purely cosmetic/shared state — not security sensitive beyond "own match".
create or replace function set_selected_cell(p_match_id uuid, p_cell integer)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_match matches%rowtype;
begin
  select * into v_match from matches where id = p_match_id;
  if v_match is null or (auth.uid() <> v_match.player_x and auth.uid() <> v_match.player_o) then
    raise exception 'Not a participant';
  end if;
  update matches set selected_cell = p_cell where id = p_match_id;
end;
$$;

-- ============================================================================
-- TIMEOUT / FORFEIT — server checks the real clock, so a client can't call
-- this early to force a win.
-- ============================================================================

create or replace function forfeit_on_timeout(p_match_id uuid)
returns matches
language plpgsql
security definer set search_path = public
as $$
declare
  v_match matches%rowtype;
begin
  select * into v_match from matches where id = p_match_id for update;

  if v_match is null then
    raise exception 'Match not found';
  end if;
  if auth.uid() <> v_match.player_x and auth.uid() <> v_match.player_o then
    raise exception 'Not a participant';
  end if;
  if v_match.status not in ('placement_phase','movement_phase') then
    raise exception 'Match already finished';
  end if;
  if v_match.turn_deadline is null or v_match.turn_deadline > now() then
    raise exception 'Turn has not timed out yet';
  end if;

  -- The player whose turn it was forfeits the game.
  update matches set
    status = 'game_over',
    winner = case when v_match.current_turn = 'X' then 'O' else 'X' end,
    ended_at = now()
  where id = p_match_id;

  perform finalize_match(p_match_id);

  select * into v_match from matches where id = p_match_id;
  return v_match;
end;
$$;

-- Called when a player leaves/disconnects and does not return within the
-- grace period. p_leaving_symbol identifies who left.
create or replace function abandon_match(p_match_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_match matches%rowtype;
  v_leaver_symbol text;
begin
  select * into v_match from matches where id = p_match_id for update;
  if v_match is null or v_match.status not in ('placement_phase','movement_phase') then
    return;
  end if;
  if auth.uid() <> v_match.player_x and auth.uid() <> v_match.player_o then
    raise exception 'Not a participant';
  end if;

  v_leaver_symbol := case when auth.uid() = v_match.player_x then 'X' else 'O' end;

  update matches set
    status = 'abandoned',
    winner = case when v_leaver_symbol = 'X' then 'O' else 'X' end,
    ended_at = now()
  where id = p_match_id;

  perform finalize_match(p_match_id);
end;
$$;

-- ============================================================================
-- RATING (Elo, K=32) + STATS + MATCH HISTORY — applied exactly once per match.
-- ============================================================================

create or replace function finalize_match(p_match_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_match matches%rowtype;
  v_px profiles%rowtype;
  v_po profiles%rowtype;
  v_score_x numeric;
  v_score_o numeric;
  v_expected_x numeric;
  v_expected_o numeric;
  v_change_x integer;
  v_change_o integer;
  v_k constant integer := 32;
  v_duration integer;
begin
  select * into v_match from matches where id = p_match_id;
  if v_match.status not in ('game_over','draw','abandoned') then
    return;
  end if;
  -- Idempotency guard: skip if already recorded.
  if exists (select 1 from match_history where match_id = p_match_id) then
    return;
  end if;

  select * into v_px from profiles where id = v_match.player_x;
  select * into v_po from profiles where id = v_match.player_o;

  if v_match.winner = 'X' then
    v_score_x := 1; v_score_o := 0;
  elsif v_match.winner = 'O' then
    v_score_x := 0; v_score_o := 1;
  else
    v_score_x := 0.5; v_score_o := 0.5;
  end if;

  v_expected_x := 1.0 / (1.0 + power(10, (v_po.rating - v_px.rating) / 400.0));
  v_expected_o := 1.0 / (1.0 + power(10, (v_px.rating - v_po.rating) / 400.0));

  v_change_x := round(v_k * (v_score_x - v_expected_x));
  v_change_o := round(v_k * (v_score_o - v_expected_o));

  v_duration := extract(epoch from (coalesce(v_match.ended_at, now()) - v_match.started_at));

  -- Player X update
  update profiles set
    rating = rating + v_change_x,
    wins = wins + case when v_score_x = 1 then 1 else 0 end,
    losses = losses + case when v_score_x = 0 then 1 else 0 end,
    draws = draws + case when v_score_x = 0.5 then 1 else 0 end,
    games_played = games_played + 1,
    current_streak = case when v_score_x = 1 then current_streak + 1 else 0 end,
    best_streak = greatest(best_streak, case when v_score_x = 1 then current_streak + 1 else 0 end),
    status = 'available'
  where id = v_match.player_x;

  -- Player O update
  update profiles set
    rating = rating + v_change_o,
    wins = wins + case when v_score_o = 1 then 1 else 0 end,
    losses = losses + case when v_score_o = 0 then 1 else 0 end,
    draws = draws + case when v_score_o = 0.5 then 1 else 0 end,
    games_played = games_played + 1,
    current_streak = case when v_score_o = 1 then current_streak + 1 else 0 end,
    best_streak = greatest(best_streak, case when v_score_o = 1 then current_streak + 1 else 0 end),
    status = 'available'
  where id = v_match.player_o;

  insert into match_history (match_id, player_id, opponent_id, result, rating_before, rating_change, rating_after, duration_seconds)
  values
    (p_match_id, v_match.player_x, v_match.player_o,
      case when v_score_x = 1 then 'win' when v_score_x = 0 then 'loss' else 'draw' end,
      v_px.rating, v_change_x, v_px.rating + v_change_x, v_duration),
    (p_match_id, v_match.player_o, v_match.player_x,
      case when v_score_o = 1 then 'win' when v_score_o = 0 then 'loss' else 'draw' end,
      v_po.rating, v_change_o, v_po.rating + v_change_o, v_duration);
end;
$$;

-- ============================================================================
-- REMATCH
-- ============================================================================

create or replace function request_rematch(p_match_id uuid)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_match matches%rowtype;
begin
  select * into v_match from matches where id = p_match_id;
  if v_match is null or (auth.uid() <> v_match.player_x and auth.uid() <> v_match.player_o) then
    raise exception 'Not a participant';
  end if;
  update matches set status = 'rematch_pending', rematch_requested_by = auth.uid() where id = p_match_id;
end;
$$;

create or replace function respond_to_rematch(p_match_id uuid, p_accept boolean)
returns uuid
language plpgsql
security definer set search_path = public
as $$
declare
  v_match matches%rowtype;
  v_new_match_id uuid;
begin
  select * into v_match from matches where id = p_match_id;
  if v_match is null or v_match.status <> 'rematch_pending' then
    raise exception 'No rematch pending';
  end if;
  if auth.uid() = v_match.rematch_requested_by then
    raise exception 'Waiting on the other player to respond';
  end if;

  if not p_accept then
    update matches set status = 'game_over' where id = p_match_id;
    return null;
  end if;

  -- Swap X/O each rematch so it's fair over a series.
  insert into matches (player_x, player_o, classroom_id, status, turn_deadline)
  values (v_match.player_o, v_match.player_x, v_match.classroom_id, 'placement_phase', now() + interval '30 seconds')
  returning id into v_new_match_id;

  update profiles set status = 'in_game' where id in (v_match.player_x, v_match.player_o);
  update matches set status = 'game_over' where id = p_match_id;

  return v_new_match_id;
end;
$$;

-- ============================================================================
-- PRESENCE HELPER — client calls this on lobby enter/heartbeat/leave.
-- ============================================================================
create or replace function set_my_status(p_status text)
returns void
language sql
security definer set search_path = public
as $$
  update profiles
  set status = p_status, last_seen = now()
  where id = auth.uid() and p_status in ('available','in_game','offline');
$$;

-- ============================================================================
-- REALTIME — publish the tables the client subscribes to.
-- ============================================================================
alter publication supabase_realtime add table matches;
alter publication supabase_realtime add table challenges;
alter publication supabase_realtime add table profiles;
