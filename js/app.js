// app.js — Classroom Arena entry point & screen controller.
//
// This file wires together every other module. It intentionally contains
// no game rules (game.js), no rating math (rating.js), and no raw Supabase
// calls beyond what the feature modules already expose — it's the glue.

import * as G from './game.js';
import * as Rating from './rating.js';
import * as UI from './ui.js';
import * as Auth from './auth.js';
import * as Classroom from './classroom.js';
import * as Lobby from './lobby.js';
import * as MP from './multiplayer.js';
import * as Leaderboard from './leaderboard.js';
import * as ProfileApi from './profile.js';
import { supabase, isConfigured } from './supabaseClient.js';

// ---------------------------------------------------------------------------
// Global app state (in-memory only — never localStorage, per project rules)
// ---------------------------------------------------------------------------
const state = {
  localGame: null,        // game.js state for pass-and-play
  onlineMatch: null,       // latest matches row from the server
  onlineMatchId: null,
  onlineUnsub: null,
  mySymbol: null,          // 'X' | 'O' in the current online match
  turnTimerHandle: null,
  turnDeadline: null,
  quickMatchAbort: null,
  lobbyRefresh: null,
};

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function boot() {
  wireStaticHandlers();
  UI.showScreen('onboarding');

  if (!isConfigured()) {
    return; // config-warning banner already shown by supabaseClient.js
  }

  await Auth.initAuth();
  Auth.onAuthChange(renderHomeStats);
  renderHomeStats();

  window.addEventListener('beforeunload', () => {
    if (state.onlineMatchId) MP.abandonMatch(state.onlineMatchId);
  });
}

function renderHomeStats() {
  const profile = Auth.getProfile();
  const box = UI.$('#home-stats');
  if (!box) return;
  if (!profile) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const tier = Rating.rankForRating(profile.rating);
  box.innerHTML = '';
  box.appendChild(UI.el('div', { class: 'home-stats__rating' }, [
    UI.el('span', { text: `Rating: ${profile.rating}` }),
    UI.rankBadge(profile.rating),
  ]));
  box.appendChild(UI.el('div', { class: 'home-stats__streak', text: profile.current_streak > 0 ? `🔥 ${profile.current_streak} Win Streak` : '' }));
  box.appendChild(UI.el('div', { class: 'home-stats__quick', text: `${profile.wins} Wins · ${profile.losses} Losses · ${Rating.winRate(profile.wins, profile.games_played)}% Win Rate` }));
}

// ---------------------------------------------------------------------------
// Static (always-present) button wiring
// ---------------------------------------------------------------------------
function wireStaticHandlers() {
  UI.$('#btn-local-game').addEventListener('click', () => startLocalGameSetup());
  UI.$('#btn-play-online').addEventListener('click', () => goOnlineFromHome());
  UI.$('#btn-how-to-play').addEventListener('click', () => UI.showScreen('how-to-play'));

  UI.$all('[data-nav-home]').forEach((b) => b.addEventListener('click', () => UI.showScreen('onboarding')));

  UI.$('#leaderboard-scope-classroom').addEventListener('click', () => setLeaderboardScope('classroom'));
  UI.$('#leaderboard-scope-global').addEventListener('click', () => setLeaderboardScope('global'));

  UI.$('#auth-tab-login').addEventListener('click', () => setAuthTab('login'));
  UI.$('#auth-tab-signup').addEventListener('click', () => setAuthTab('signup'));
  UI.$('#login-form').addEventListener('submit', onLoginSubmit);
  UI.$('#signup-form').addEventListener('submit', onSignupSubmit);

  UI.$('#classroom-join-form').addEventListener('submit', onJoinClassroomSubmit);
  UI.$('#classroom-create-form').addEventListener('submit', onCreateClassroomSubmit);

  // Classroom management screen handlers (optional so older HTML still boots).
  UI.$('#management-create-classroom-form')?.addEventListener('submit', onManagementCreateClassroomSubmit);
  UI.$('#management-join-classroom-form')?.addEventListener('submit', onManagementJoinClassroomSubmit);

  UI.$('#btn-quick-match').addEventListener('click', onQuickMatchClick);
  UI.$('#btn-cancel-search').addEventListener('click', onCancelSearch);

  UI.$all('.bottom-nav__item').forEach((btn) => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.screen));
  });

  UI.$('#btn-logout').addEventListener('click', async () => {
    await Lobby.leaveLobby();
    await Auth.logOut();
    UI.showScreen('onboarding');
    UI.toast('Signed out.');
  });

  UI.$('#local-restart').addEventListener('click', () => startLocalGameSetup());
  UI.$('#result-rematch').addEventListener('click', onRematchClick);
  UI.$('#result-lobby').addEventListener('click', () => goToLobbyScreen());

  UI.$('#history-filter').addEventListener('change', (e) => renderHistory(e.target.value));
  UI.$('#btn-view-history').addEventListener('click', () => { UI.showScreen('history'); renderHistory('all'); });
  UI.$('#btn-enter-lobby').addEventListener('click', () => goToLobbyScreen());
  UI.$('#btn-classroom-management')?.addEventListener('click', () => renderClassroomManagement());
  UI.$('#screen-classroom-management [data-screen="dashboard"]')?.addEventListener('click', () => navigateTo('dashboard'));
}

function setAuthTab(tab) {
  UI.$('#login-form').hidden = tab !== 'login';
  UI.$('#signup-form').hidden = tab !== 'signup';
  UI.$('#auth-tab-login').classList.toggle('is-active', tab === 'login');
  UI.$('#auth-tab-signup').classList.toggle('is-active', tab === 'signup');
}

async function navigateTo(screen) {
  if (!Auth.isLoggedIn() && screen !== 'onboarding') {
    UI.showScreen('auth');
    return;
  }
  if (screen === 'dashboard') return renderDashboard();
  if (screen === 'classroom-management') return renderClassroomManagement();
  if (screen === 'lobby') return goToLobbyScreen();
  if (screen === 'leaderboard') return renderLeaderboard();
  if (screen === 'profile') return renderProfile();
  UI.showScreen(screen);
}

// ---------------------------------------------------------------------------
// Auth flow
// ---------------------------------------------------------------------------
function goOnlineFromHome() {
  if (Auth.isLoggedIn()) {
    ensureClassroomThenDashboard();
  } else {
    setAuthTab('login');
    UI.showScreen('auth');
  }
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const email = UI.$('#login-email').value.trim();
  const password = UI.$('#login-password').value;
  try {
    await Auth.logIn({ email, password });
    UI.toast(`Welcome back, ${Auth.getProfile()?.username || 'player'}!`);
    await ensureClassroomThenDashboard();
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

async function onSignupSubmit(e) {
  e.preventDefault();
  const username = UI.$('#signup-username').value.trim();
  const email = UI.$('#signup-email').value.trim();
  const password = UI.$('#signup-password').value;
  try {
    await Auth.signUp({ email, password, username });
    UI.toast('Account created — welcome to Classroom Arena!');
    await ensureClassroomThenDashboard();
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

async function ensureClassroomThenDashboard() {
  renderHomeStats();
  try {
    const rooms = await Classroom.getMyClassrooms();
    if (rooms.length === 0) {
      UI.showScreen('classroom');
    } else {
      Classroom.setCurrentClassroom(rooms[0]);
      await renderDashboard();
    }
  } catch (err) {
    UI.toast(err.message, 'error');
    UI.showScreen('classroom');
  }
}

async function onJoinClassroomSubmit(e) {
  e.preventDefault();
  const code = UI.$('#classroom-code-input').value;
  try {
    await Classroom.joinClassroomByCode(code);
    UI.toast('Joined classroom!');
    await renderDashboard();
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

async function onCreateClassroomSubmit(e) {
  e.preventDefault();
  const name = UI.$('#classroom-name-input').value;
  const code = UI.$('#classroom-newcode-input').value;
  try {
    await Classroom.createClassroom({ name, code });
    UI.toast('Classroom created!');
    await renderDashboard();
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Classroom Management
// ---------------------------------------------------------------------------
async function renderClassroomManagement() {
  UI.showScreen('classroom-management');

  const list = UI.$('#my-classrooms-list');
  if (!list) return;

  list.innerHTML = '<p class="muted">Loading classrooms...</p>';

  try {
    const rooms = await Classroom.getMyClassrooms();
    list.innerHTML = '';

    if (!rooms.length) {
      list.appendChild(UI.el('p', {
        class: 'muted',
        text: 'You have not joined any classrooms yet.',
      }));
      return;
    }

    const current = Classroom.getCurrentClassroom();

    for (const room of rooms) {
      const isCurrent = current?.id === room.id;

      const card = UI.el('div', { class: 'management-classroom-card' }, [
        UI.el('div', { class: 'management-classroom-card__info' }, [
          UI.el('strong', { text: room.name }),
          UI.el('span', { text: `Code: ${room.code}` }),
        ]),
        UI.el('button', {
          class: isCurrent
            ? 'btn btn--small btn--ghost'
            : 'btn btn--small btn--primary',
          type: 'button',
          text: isCurrent ? 'CURRENT' : 'ENTER',
          disabled: isCurrent,
          onclick: async () => {
            try {
              await Lobby.leaveLobby();
              Classroom.setCurrentClassroom(room);
              await renderDashboard();
            } catch (err) {
              UI.toast(err.message, 'error');
            }
          },
        }),
      ]);

      list.appendChild(card);
    }
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(UI.el('p', {
      class: 'muted',
      text: err.message,
    }));
  }
}

async function onManagementCreateClassroomSubmit(e) {
  e.preventDefault();

  const name = UI.$('#management-classroom-name').value.trim();
  const code = UI.$('#management-classroom-code').value.trim();

  try {
    const classroom = await Classroom.createClassroom({ name, code });
    Classroom.setCurrentClassroom(classroom);
    UI.toast(`Created ${classroom.name}!`);
    e.target.reset();
    await renderClassroomManagement();
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

async function onManagementJoinClassroomSubmit(e) {
  e.preventDefault();

  const code = UI.$('#management-join-code').value.trim();

  try {
    const classroom = await Classroom.joinClassroomByCode(code);
    Classroom.setCurrentClassroom(classroom);
    UI.toast(`Joined ${classroom.name}!`);
    e.target.reset();
    await renderClassroomManagement();
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------
async function renderDashboard() {
  await Auth.refreshProfile();
  const profile = Auth.getProfile();
  const classroom = Classroom.getCurrentClassroom();
  if (!profile) return UI.showScreen('auth');

  UI.$('#dashboard-welcome').textContent = `Welcome, ${profile.username}`;
  UI.$('#dashboard-classroom').textContent = classroom ? classroom.name + ' · ' + classroom.code : '';
  UI.$('#dashboard-rating').textContent = profile.rating;
  UI.$('#dashboard-rank-badge').innerHTML = '';
  UI.$('#dashboard-rank-badge').appendChild(UI.rankBadge(profile.rating));
  UI.$('#dashboard-wins').textContent = profile.wins;
  UI.$('#dashboard-losses').textContent = profile.losses;
  UI.$('#dashboard-winrate').textContent = `${Rating.winRate(profile.wins, profile.games_played)}%`;
  UI.$('#dashboard-streak').textContent = profile.current_streak > 0 ? `🔥 ${profile.current_streak} win streak` : 'No active streak';

  UI.showScreen('dashboard');
}

// ---------------------------------------------------------------------------
// Lobby
// ---------------------------------------------------------------------------
async function goToLobbyScreen() {
  const classroom = Classroom.getCurrentClassroom();
  if (!classroom) return ensureClassroomThenDashboard();

  UI.showScreen('lobby');
  UI.$('#lobby-count').textContent = 'Connecting…';

  try {
    await Lobby.enterLobby(classroom.id, {
      onPlayersChange: renderLobbyPlayers,
      onChallengeReceived: showIncomingChallenge,
      onChallengeUpdated: handleChallengeUpdate,
    });
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

function renderLobbyPlayers(players) {
  const me = Auth.getUser();
  const list = UI.$('#lobby-players');

  // Actual Supabase Presence count.
  const onlinePlayers = players.filter(
    (p) => p.online
  );

  UI.$('#lobby-count').textContent =
    `${onlinePlayers.length} Player${
      onlinePlayers.length === 1 ? '' : 's'
    } Online`;

  list.innerHTML = '';

  const myUsername = Auth.getProfile()?.username;
  const opponents = players.filter(
    (p) => !p.isCurrentUser && p.id !== me?.id && p.username !== myUsername && p.online
  );

  if (opponents.length === 0) {
    list.appendChild(
      UI.el('div', {
        class: 'empty-state',
        text: 'No other players are online.',
      })
    );

    return;
  }

  for (const p of opponents) {
    const card = UI.el(
      'div',
      {
        class: 'player-card',
      },
      [
        UI.el(
          'div',
          {
            class:
              'player-card__main',
          },
          [
            UI.el(
              'span',
              {
                class:
                  'player-card__status',
                text:
                  p.status ===
                  'in_game'
                    ? '🔴'
                    : '🟢',
              }
            ),

            UI.el(
              'span',
              {
                class:
                  'player-card__name',
                text:
                  p.username,
              }
            ),

            UI.rankBadge(
              p.rating
            ),
          ]
        ),

        UI.el(
          'div',
          {
            class:
              'player-card__meta',
            text:
              `${p.rating} rating · ${
                p.status ===
                'in_game'
                  ? 'In Game'
                  : 'Available'
              }`,
          }
        ),

        p.status ===
        'available'
          ? UI.el(
              'button',
              {
                class:
                  'btn btn--small',
                type: 'button',
                text:
                  'Challenge',
                onclick: () =>
                  onChallengeClick(
                    p
                  ),
              }
            )
          : null,
      ]
    );

    list.appendChild(card);
  }
}

async function onChallengeClick(player) {
  try {
    await Lobby.sendChallenge(player.id);
    UI.toast(`Challenge sent to ${player.username}.`);
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

function showIncomingChallenge(challenge) {
  supabase.from('profiles').select('username').eq('id', challenge.challenger_id).single().then(({ data }) => {
    const name = data?.username || 'A player';
    const box = UI.el('div', { class: 'challenge-toast' }, [
      UI.el('div', { text: `${name} wants to play against you.` }),
      UI.el('div', { class: 'challenge-toast__actions' }, [
        UI.el('button', { class: 'btn btn--small', text: 'Accept', onclick: async () => {
          box.remove();
          try {
            const matchId = await Lobby.respondToChallenge(challenge.id, true);
            if (matchId) enterOnlineMatch(matchId);
          } catch (err) { UI.toast(err.message, 'error'); }
        } }),
        UI.el('button', { class: 'btn btn--ghost btn--small', text: 'Decline', onclick: async () => {
          box.remove();
          await Lobby.respondToChallenge(challenge.id, false).catch(() => {});
        } }),
      ]),
    ]);
    UI.$('#challenge-inbox').appendChild(box);
    setTimeout(() => box.remove(), 30000);
  });
}

function handleChallengeUpdate(challenge) {
  if (challenge.status === 'accepted' && challenge.match_id) {
    enterOnlineMatch(challenge.match_id);
  } else if (challenge.status === 'declined') {
    UI.toast('Your challenge was declined.');
  }
}

// ---------------------------------------------------------------------------
// Quick Match
// ---------------------------------------------------------------------------
async function onQuickMatchClick() {
  const classroom = Classroom.getCurrentClassroom();
  UI.$('#quick-match-search').hidden = false;
  UI.$('#btn-quick-match').hidden = true;
  state.quickMatchAbort = new AbortController();

  try {
    const matchId = await MP.startQuickMatch({
      classroomId: classroom?.id ?? null,
      signal: state.quickMatchAbort.signal,
      onSearching: (secs) => {
        UI.$('#quick-match-status').textContent = `Searching for a worthy opponent… (${secs}s)`;
      },
    });
    UI.$('#quick-match-search').hidden = true;
    UI.$('#btn-quick-match').hidden = false;
    if (matchId) enterOnlineMatch(matchId);
  } catch (err) {
    UI.$('#quick-match-search').hidden = true;
    UI.$('#btn-quick-match').hidden = false;
    UI.toast(err.message, 'error');
  }
}

function onCancelSearch() {
  state.quickMatchAbort?.abort();
  UI.$('#quick-match-search').hidden = true;
  UI.$('#btn-quick-match').hidden = false;
}

// ---------------------------------------------------------------------------
// Online game
// ---------------------------------------------------------------------------
async function enterOnlineMatch(matchId) {
  state.onlineMatchId = matchId;
  UI.showScreen('game-online');
  UI.$('#online-board-status').textContent = 'Loading match…';

  state.onlineUnsub = MP.watchMatch(matchId, onOnlineMatchUpdate);
}

function onOnlineMatchUpdate(match) {
  state.onlineMatch = match;
  const me = Auth.getUser();
  state.mySymbol = match.player_x === me?.id ? 'X' : 'O';

  const opponentId = state.mySymbol === 'X' ? match.player_o : match.player_x;
  loadOpponentName(opponentId);

  UI.$('#online-you-symbol').textContent = state.mySymbol;
  UI.$('#online-opponent-symbol').textContent = state.mySymbol === 'X' ? 'O' : 'X';

  const myTurn = match.current_turn === state.mySymbol;
  const placedByMe = state.mySymbol === 'X' ? match.x_pieces_placed : match.o_pieces_placed;

  let statusText;
  if (match.status === 'game_over' || match.status === 'draw' || match.status === 'abandoned') {
    statusText = 'Game over';
  } else if (!myTurn) {
    statusText = `${match.current_turn}'s Turn — waiting for opponent…`;
  } else if (placedByMe < 3) {
    statusText = 'Your turn — place a piece';
  } else {
    statusText = match.selected_cell != null && isMine(match, match.selected_cell)
      ? 'Now choose an empty square'
      : 'Your turn — select one of your pieces to move';
  }
  UI.$('#online-board-status').textContent = statusText;

  const validDestinations = new Set();
  if (myTurn && match.selected_cell != null && match.board_state[match.selected_cell] === state.mySymbol) {
    match.board_state.forEach((v, i) => { if (v === null) validDestinations.add(i); });
  }

  UI.renderBoard(
    UI.$('#online-board'),
    match.board_state,
    { onCellClick: (i) => onOnlineCellClick(match, i) },
    { selectedCell: match.selected_cell, winLine: match.win_line || [], validDestinations, mySymbol: state.mySymbol }
  );

  updateTurnTimer(match);

  if (['game_over', 'draw', 'abandoned'].includes(match.status)) {
    stopTurnTimer();
    showOnlineResult(match);
  }
  if (match.status === 'rematch_pending') {
    handleRematchPending(match);
  }
}

function isMine(match, cell) {
  return match.board_state[cell] === state.mySymbol;
}

async function loadOpponentName(opponentId) {
  const { data } = await supabase.from('profiles').select('username').eq('id', opponentId).single();
  if (data) UI.$('#online-opponent-name').textContent = data.username;
}

async function onOnlineCellClick(match, index) {
  if (match.status !== 'placement_phase' && match.status !== 'movement_phase') return;
  if (match.current_turn !== state.mySymbol) return UI.toast("It's not your turn.", 'error');

  const placedByMe = state.mySymbol === 'X' ? match.x_pieces_placed : match.o_pieces_placed;

  try {
    if (placedByMe < 3) {
      if (match.board_state[index] !== null) return UI.toast('That cell is occupied.', 'error');
      await MP.submitPlacement(state.onlineMatchId, index);
      return;
    }

    // Movement phase
    if (match.selected_cell == null) {
      if (match.board_state[index] !== state.mySymbol) return UI.toast('Select one of your own pieces.', 'error');
      await MP.setSelectedCell(state.onlineMatchId, index);
      return;
    }
    if (match.board_state[index] === state.mySymbol) {
      // switch selection to a different own piece
      await MP.setSelectedCell(state.onlineMatchId, index);
      return;
    }
    if (match.board_state[index] !== null) return UI.toast('Destination is occupied.', 'error');
    await MP.submitMove(state.onlineMatchId, match.selected_cell, index);
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

function updateTurnTimer(match) {
  stopTurnTimer();
  if (!match.turn_deadline || !['placement_phase', 'movement_phase'].includes(match.status)) {
    UI.$('#online-timer').textContent = '';
    return;
  }
  const tick = () => {
    const remaining = Math.max(0, Math.ceil((new Date(match.turn_deadline) - Date.now()) / 1000));
    UI.$('#online-timer').textContent = remaining;
    UI.$('#online-timer').classList.toggle('is-urgent', remaining <= 5);
    if (remaining <= 0) {
      stopTurnTimer();
      if (match.current_turn === state.mySymbol) {
        // Either player may report the timeout — the server verifies the clock itself.
      }
      MP.claimTimeoutForfeit(state.onlineMatchId).catch(() => {});
    }
  };
  tick();
  state.turnTimerHandle = setInterval(tick, 250);
}

function stopTurnTimer() {
  if (state.turnTimerHandle) clearInterval(state.turnTimerHandle);
  state.turnTimerHandle = null;
}

function showOnlineResult(match) {
  const won = match.winner === state.mySymbol;
  const isDraw = match.winner === 'draw';
  const opponentName = UI.$('#online-opponent-name').textContent;

  UI.$('#result-title').textContent = isDraw ? 'DRAW' : won ? 'VICTORY 🎉' : 'DEFEAT';
  UI.$('#result-title').className = 'result-title ' + (isDraw ? 'is-draw' : won ? 'is-win' : 'is-loss');
  UI.$('#result-subtitle').textContent = isDraw
    ? `Drew against ${opponentName}`
    : won ? `You defeated ${opponentName}` : `You lost to ${opponentName}`;

  // Show the definitive rating change once match_history has been written
  // server-side (finalize_match runs synchronously inside the same RPC call
  // that ended the game, so it's already there by the time we query).
  const me = Auth.getUser();
  supabase
    .from('match_history')
    .select('rating_before, rating_change, rating_after')
    .eq('match_id', match.id)
    .eq('player_id', me.id)
    .single()
    .then(({ data }) => {
      if (!data) return;
      UI.$('#result-rating').textContent = `${data.rating_before} → ${data.rating_after}`;
      UI.$('#result-rating-delta').textContent = `${data.rating_change >= 0 ? '+' : ''}${data.rating_change} Rating`;
      Auth.refreshProfile().then(renderHomeStats);
    });

  UI.showScreen('result');
}

async function onRematchClick() {
  if (!state.onlineMatchId) return;
  try {
    await MP.requestRematch(state.onlineMatchId);
    UI.toast('Rematch requested — waiting for your opponent…');
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

function handleRematchPending(match) {
  const me = Auth.getUser();
  if (match.rematch_requested_by === me.id) return; // waiting on opponent
  const box = UI.el('div', { class: 'challenge-toast' }, [
    UI.el('div', { text: 'Your opponent wants a rematch.' }),
    UI.el('div', { class: 'challenge-toast__actions' }, [
      UI.el('button', { class: 'btn btn--small', text: 'Accept', onclick: async () => {
        box.remove();
        const newId = await MP.respondToRematch(match.id, true);
        if (newId) enterOnlineMatch(newId);
      } }),
      UI.el('button', { class: 'btn btn--ghost btn--small', text: 'Decline', onclick: async () => {
        box.remove();
        await MP.respondToRematch(match.id, false).catch(() => {});
        goToLobbyScreen();
      } }),
    ]),
  ]);
  UI.$('#challenge-inbox').appendChild(box);
}

// ---------------------------------------------------------------------------
// Local game (pass-and-play, no login required)
// ---------------------------------------------------------------------------
function startLocalGameSetup() {
  state.localGame = G.initializeGame();
  UI.showScreen('game-local');
  renderLocalGame();
}

function renderLocalGame() {
  const s = state.localGame;
  const placedByCurrent = s.currentTurn === 'X' ? s.xPlaced : s.oPlaced;
  const inMovementPhase = placedByCurrent >= 3;

  let statusText;
  if (s.status === 'game_over') statusText = `${s.winner} WINS!`;
  else if (s.status === 'draw') statusText = `DRAW — ${s.drawReason === 'move_limit' ? 'Move Limit Reached' : 'Repeated Position'}`;
  else if (!inMovementPhase) statusText = `${s.currentTurn}'s Turn — place a piece`;
  else statusText = s.selectedCell != null ? 'Now choose an empty square' : `${s.currentTurn}'s Turn — select one of your pieces to move`;

  UI.$('#local-status').textContent = statusText;
  UI.$('#local-restart').hidden = !(s.status === 'game_over' || s.status === 'draw');

  const validDestinations = new Set();
  if (s.selectedCell != null) {
    G.getValidMoves(s, s.selectedCell).forEach((c) => validDestinations.add(c));
  }

  UI.renderBoard(
    UI.$('#local-board'),
    s.board,
    { onCellClick: onLocalCellClick },
    { selectedCell: s.selectedCell, winLine: s.winLine || [], validDestinations }
  );
}

function onLocalCellClick(index) {
  const s = state.localGame;
  if (s.status === 'game_over' || s.status === 'draw') return;

  const placedByCurrent = s.currentTurn === 'X' ? s.xPlaced : s.oPlaced;
  try {
    if (placedByCurrent < 3) {
      state.localGame = G.placePiece(s, index);
    } else if (s.selectedCell == null) {
      if (s.board[index] !== s.currentTurn) return UI.toast('Select one of your own pieces.', 'error');
      state.localGame = G.selectPiece(s, index);
    } else if (s.board[index] === s.currentTurn) {
      state.localGame = G.selectPiece(s, index); // change selection
    } else {
      state.localGame = G.movePiece(s, s.selectedCell, index);
    }
  } catch (err) {
    UI.toast(err.message, 'error');
  }
  renderLocalGame();
}

// ---------------------------------------------------------------------------
// Leaderboard
// ---------------------------------------------------------------------------
async function renderLeaderboard(scope = 'classroom') {
  UI.showScreen('leaderboard');
  const me = Auth.getUser();
  const classroom = Classroom.getCurrentClassroom();
  const list = UI.$('#leaderboard-list');
  list.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const rows = scope === 'global' || !classroom
      ? await Leaderboard.getGlobalLeaderboard()
      : await Leaderboard.getClassroomLeaderboard(classroom.id);

    if (rows.length === 0) {
      list.innerHTML = '';
      list.appendChild(UI.el('div', { class: 'empty-state', text: 'The rankings are waiting for you.' }));
      return;
    }

    list.innerHTML = '';
    rows.forEach((p) => {
      const row = UI.el('div', { class: 'leaderboard-row' + (p.id === me?.id ? ' is-me' : '') }, [
        UI.el('span', { class: 'leaderboard-row__pos', text: `${p.position}` }),
        UI.el('span', { class: 'leaderboard-row__name', text: p.username }),
        UI.el('span', { class: 'leaderboard-row__tier', text: p.tier, style: `color:${p.tierColor}` }),
        UI.el('span', { class: 'leaderboard-row__rating', text: `${p.rating}` }),
        UI.el('span', { class: 'leaderboard-row__record', text: `${p.wins}W–${p.losses}L` }),
        UI.el('span', { class: 'leaderboard-row__winrate', text: `${p.winRate}%` }),
      ]);
      list.appendChild(row);
    });

    const myRank = Leaderboard.findRank(rows, me?.id);
    UI.$('#leaderboard-your-rank').textContent = myRank ? `Your Rank: #${myRank}` : '';
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

function setLeaderboardScope(scope) {
  UI.$('#leaderboard-scope-classroom').classList.toggle('is-active', scope === 'classroom');
  UI.$('#leaderboard-scope-global').classList.toggle('is-active', scope === 'global');
  renderLeaderboard(scope);
}

// ---------------------------------------------------------------------------
// Profile + Match History
// ---------------------------------------------------------------------------
async function renderProfile() {
  const me = Auth.getUser();
  if (!me) return UI.showScreen('auth');
  UI.showScreen('profile');

  try {
    const profile = await ProfileApi.getPublicProfile(me.id);
    UI.$('#profile-username').textContent = profile.username;
    UI.$('#profile-rating').textContent = profile.rating;
    UI.$('#profile-badge').innerHTML = '';
    UI.$('#profile-badge').appendChild(UI.rankBadge(profile.rating));
    UI.$('#profile-games').textContent = profile.games_played;
    UI.$('#profile-wins').textContent = profile.wins;
    UI.$('#profile-losses').textContent = profile.losses;
    UI.$('#profile-draws').textContent = profile.draws;
    UI.$('#profile-winrate').textContent = `${profile.winRate}%`;
    UI.$('#profile-streak').textContent = profile.current_streak;
    UI.$('#profile-best-streak').textContent = profile.best_streak;

    await renderHistory('all', true);
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

async function renderHistory(filter = 'all', compact = false) {
  const me = Auth.getUser();
  if (!me) return;
  const container = UI.$(compact ? '#profile-recent-matches' : '#history-list');
  if (!container) return;
  container.innerHTML = '<div class="empty-state">Loading…</div>';

  try {
    const rows = await ProfileApi.getMatchHistory(me.id, filter, compact ? 5 : 50);
    container.innerHTML = '';
    if (rows.length === 0) {
      container.appendChild(UI.el('div', { class: 'empty-state', text: 'No matches yet. Play your first game.' }));
      return;
    }
    rows.forEach((m) => {
      const resultLabel = m.result === 'win' ? 'Victory' : m.result === 'loss' ? 'Defeat' : 'Draw';
      const row = UI.el('div', { class: `match-row match-row--${m.result}` }, [
        UI.el('div', { class: 'match-row__main' }, [
          UI.el('span', { class: 'match-row__result', text: `${resultLabel} vs ${m.opponentName}` }),
          UI.el('span', { class: 'match-row__delta', text: `${m.ratingChange >= 0 ? '+' : ''}${m.ratingChange}` }),
        ]),
        !compact
          ? UI.el('div', { class: 'match-row__meta', text: `${UI.formatRelativeDate(m.createdAt)} · ${UI.formatDuration(m.durationSeconds)}` })
          : null,
      ]);
      container.appendChild(row);
    });
  } catch (err) {
    UI.toast(err.message, 'error');
  }
}

// ---------------------------------------------------------------------------
boot();
