// leaderboard.js — Classroom + Global rankings.

import { supabase } from './supabaseClient.js';
import { rankForRating, winRate } from './rating.js';

/** Global leaderboard: top players across every classroom. */
export async function getGlobalLeaderboard(limit = 100) {
  const { data, error } = await supabase
    .from('profiles')
    .select('id, username, avatar_url, rating, wins, losses, draws, games_played')
    .order('rating', { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);
  return decorate(data);
}

/** Classroom leaderboard: only members of the given classroom. */
export async function getClassroomLeaderboard(classroomId, limit = 100) {
  const { data, error } = await supabase
    .from('classroom_members')
    .select('profiles(id, username, avatar_url, rating, wins, losses, draws, games_played)')
    .eq('classroom_id', classroomId)
    .limit(limit);
  if (error) throw new Error(error.message);
  const profiles = (data || []).map((r) => r.profiles).filter(Boolean);
  profiles.sort((a, b) => b.rating - a.rating);
  return decorate(profiles);
}

function decorate(rows) {
  return rows.map((p, i) => ({
    ...p,
    position: i + 1,
    tier: rankForRating(p.rating).name,
    tierColor: rankForRating(p.rating).color,
    winRate: winRate(p.wins, p.games_played),
  }));
}

/** Find where a specific user sits within an already-fetched ranked list. */
export function findRank(rankedList, userId) {
  const entry = rankedList.find((p) => p.id === userId);
  return entry ? entry.position : null;
}
