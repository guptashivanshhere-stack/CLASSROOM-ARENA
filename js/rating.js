// rating.js — Elo-style rating helpers.
//
// IMPORTANT: this module is for DISPLAY/PREVIEW only (e.g. showing a likely
// rating swing before a match, or re-deriving a badge color from a number
// the server already sent down). The real rating change that gets written
// to profiles/match_history is always computed server-side in
// sql/schema.sql -> finalize_match(), using the same K=32 formula, because
// the client is never trusted with scoring (see spec section 27).

export const K_FACTOR = 32;
export const STARTING_RATING = 1000;

export const RANK_TIERS = [
  { name: 'Bronze', min: 0, max: 999, color: '#B0693B' },
  { name: 'Silver', min: 1000, max: 1199, color: '#B8C0CC' },
  { name: 'Gold', min: 1200, max: 1399, color: '#F2B84B' },
  { name: 'Platinum', min: 1400, max: 1599, color: '#7FE0D6' },
  { name: 'Diamond', min: 1600, max: 1799, color: '#7C9CFF' },
  { name: 'Master', min: 1800, max: 1999, color: '#C77CFF' },
  { name: 'Grandmaster', min: 2000, max: Infinity, color: '#FF6B8B' },
];

export function rankForRating(rating) {
  return RANK_TIERS.find((t) => rating >= t.min && rating <= t.max) || RANK_TIERS[0];
}

/** Probability that `ratingA` beats `ratingB`. */
export function expectedScore(ratingA, ratingB) {
  return 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
}

/**
 * Predicted rating delta for a player, given the outcome.
 * score: 1 = win, 0.5 = draw, 0 = loss.
 */
export function predictRatingChange(myRating, opponentRating, score) {
  const expected = expectedScore(myRating, opponentRating);
  return Math.round(K_FACTOR * (score - expected));
}

export function winRate(wins, gamesPlayed) {
  if (!gamesPlayed) return 0;
  return Math.round((wins / gamesPlayed) * 100);
}
