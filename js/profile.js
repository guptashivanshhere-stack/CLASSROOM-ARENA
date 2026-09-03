// profile.js — Player profile + match history.

import { supabase } from './supabaseClient.js';
import { rankForRating, winRate } from './rating.js';

export async function getPublicProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error) throw new Error(error.message);
  return {
    ...data,
    tier: rankForRating(data.rating),
    winRate: winRate(data.wins, data.games_played),
  };
}

/**
 * Match history for a player.
 * filter: 'all' | 'win' | 'loss' | 'draw'
 */
export async function getMatchHistory(userId, filter = 'all', limit = 50) {
  let query = supabase
    .from('match_history')
    .select('id, match_id, result, rating_before, rating_change, rating_after, duration_seconds, created_at, opponent_id, profiles!match_history_opponent_id_fkey(username, avatar_url)')
    .eq('player_id', userId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (filter !== 'all') {
    query = query.eq('result', filter);
  }

  const { data, error } = await query;
  if (error) throw new Error(error.message);

  return (data || []).map((row) => ({
    id: row.id,
    matchId: row.match_id,
    result: row.result,
    ratingBefore: row.rating_before,
    ratingChange: row.rating_change,
    ratingAfter: row.rating_after,
    durationSeconds: row.duration_seconds,
    createdAt: row.created_at,
    opponentName: row.profiles?.username ?? 'Unknown player',
    opponentAvatar: row.profiles?.avatar_url ?? null,
  }));
}

export async function updateAvatar(userId, avatarUrl) {
  const { error } = await supabase.from('profiles').update({ avatar_url: avatarUrl }).eq('id', userId);
  if (error) throw new Error(error.message);
}
