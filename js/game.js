// game.js — Core 3-Piece Tic-Tac-Toe rules engine.
// Pure functions only: no DOM, no network. Safe to unit-test directly.
// This exact logic is mirrored (independently, authoritatively) in
// sql/schema.sql -> make_move() for the online mode, because the browser
// is never trusted for match results (see SKILL notes in README).

export const WIN_LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8], // rows
  [0, 3, 6], [1, 4, 7], [2, 5, 8], // cols
  [0, 4, 8], [2, 4, 6],           // diagonals
];

export const MAX_MOVES = 100;
export const REPEAT_LIMIT = 3; // same full board position occurring 3x = draw

/**
 * Fresh local-game state.
 */
export function initializeGame() {
  return {
    board: Array(9).fill(null),      // 'X' | 'O' | null
    currentTurn: 'X',
    xPlaced: 0,
    oPlaced: 0,
    selectedCell: null,              // cell index currently picked up, or null
    status: 'placement_phase',       // placement_phase | movement_phase | game_over | draw
    winner: null,                    // 'X' | 'O' | 'draw' | null
    winLine: null,
    moveCount: 0,
    positionHistory: [],
  };
}

function piecesPlaced(state, symbol) {
  return symbol === 'X' ? state.xPlaced : state.oPlaced;
}

/** True once a player has all 3 pieces down and must move rather than place. */
export function isMovementPhaseFor(state, symbol) {
  return piecesPlaced(state, symbol) >= 3;
}

/**
 * Attempt to place a new piece for the current player on `cell`.
 * Returns a new state, or throws a descriptive Error on an illegal action.
 */
export function placePiece(state, cell) {
  assertInProgress(state);
  const symbol = state.currentTurn;

  if (isMovementPhaseFor(state, symbol)) {
    throw new Error('All 3 pieces already placed — select a piece to move instead.');
  }
  if (cell < 0 || cell > 8) throw new Error('Invalid cell.');
  if (state.board[cell] !== null) throw new Error('That cell is already occupied.');

  const board = state.board.slice();
  board[cell] = symbol;

  const next = {
    ...state,
    board,
    xPlaced: symbol === 'X' ? state.xPlaced + 1 : state.xPlaced,
    oPlaced: symbol === 'O' ? state.oPlaced + 1 : state.oPlaced,
    selectedCell: null,
  };

  return advanceTurn(next, symbol);
}

/** Pick up one of the current player's own pieces during the movement phase. */
export function selectPiece(state, cell) {
  assertInProgress(state);
  const symbol = state.currentTurn;
  if (!isMovementPhaseFor(state, symbol)) {
    throw new Error('You still need to place all 3 pieces first.');
  }
  if (state.board[cell] !== symbol) {
    throw new Error('You can only select your own piece.');
  }
  return { ...state, selectedCell: cell };
}

/** Move the currently selected piece to an empty cell. */
export function movePiece(state, from, to) {
  assertInProgress(state);
  const symbol = state.currentTurn;

  if (!isMovementPhaseFor(state, symbol)) {
    throw new Error('You still need to place all 3 pieces first.');
  }
  if (!isValidMove(state, from, to)) {
    throw new Error('Illegal move.');
  }

  const board = state.board.slice();
  board[from] = null;
  board[to] = symbol;

  const next = { ...state, board, selectedCell: null };
  return advanceTurn(next, symbol);
}

/** Validate a from->to move without mutating anything. */
export function isValidMove(state, from, to) {
  const symbol = state.currentTurn;
  if (from < 0 || from > 8 || to < 0 || to > 8) return false;
  if (state.board[from] !== symbol) return false;
  if (state.board[to] !== null) return false;
  return true;
}

/** All empty cells a piece at `from` could legally move to (unrestricted). */
export function getValidMoves(state, from) {
  if (state.board[from] !== state.currentTurn) return [];
  const moves = [];
  for (let i = 0; i < 9; i++) {
    if (state.board[i] === null) moves.push(i);
  }
  return moves;
}

/** Shared bookkeeping after any successful placement or move. */
function advanceTurn(state, symbolThatMoved) {
  let next = { ...state, moveCount: state.moveCount + 1 };

  if (next.xPlaced >= 3 && next.oPlaced >= 3 && next.status === 'placement_phase') {
    next.status = 'movement_phase';
  }

  const win = checkWinner(next.board);
  if (win) {
    return { ...next, status: 'game_over', winner: win.symbol, winLine: win.line };
  }

  const draw = checkDraw(next);
  if (draw.isDraw) {
    return { ...next, status: 'draw', winner: 'draw', drawReason: draw.reason };
  }

  return {
    ...next,
    currentTurn: symbolThatMoved === 'X' ? 'O' : 'X',
    positionHistory: [...next.positionHistory, serializeBoard(next.board)],
  };
}

/** Check all 8 lines for three-in-a-row. Returns {symbol, line} or null. */
export function checkWinner(board) {
  for (const line of WIN_LINES) {
    const [a, b, c] = line;
    if (board[a] && board[a] === board[b] && board[b] === board[c]) {
      return { symbol: board[a], line };
    }
  }
  return null;
}

/**
 * Draw = move limit hit, OR the exact same full board position has now
 * occurred REPEAT_LIMIT times (pieces sliding back and forth forever).
 */
export function checkDraw(state) {
  if (state.moveCount >= MAX_MOVES) {
    return { isDraw: true, reason: 'move_limit' };
  }
  const serialized = serializeBoard(state.board);
  const occurrences = state.positionHistory.filter((p) => p === serialized).length + 1;
  if (occurrences >= REPEAT_LIMIT) {
    return { isDraw: true, reason: 'repeated_position' };
  }
  return { isDraw: false };
}

export function switchTurn(state) {
  return { ...state, currentTurn: state.currentTurn === 'X' ? 'O' : 'X' };
}

export function resetGame() {
  return initializeGame();
}

export function serializeBoard(board) {
  return board.map((c) => c || '-').join('');
}

export function deserializeBoard(str) {
  return str.split('').map((c) => (c === '-' ? null : c));
}

function assertInProgress(state) {
  if (state.status === 'game_over' || state.status === 'draw') {
    throw new Error('The game has already ended.');
  }
}
