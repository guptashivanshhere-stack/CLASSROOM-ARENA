// classroom.js — Classroom Code system (spec section 8).

import { supabase } from './supabaseClient.js';

let currentClassroom = null; // { id, name, code }

export function getCurrentClassroom() {
  return currentClassroom;
}

function normalizeCode(code) {
  return code.trim().toUpperCase();
}

/** Create a brand-new classroom and immediately join it as a member. */
export async function createClassroom({ name, code }) {
  const normalized = normalizeCode(code);
  const trimmedName = name.trim();
  if (!trimmedName) throw new Error('Classroom name is required.');
  if (!/^[A-Z0-9-]{3,20}$/.test(normalized)) {
    throw new Error('Classroom codes may only contain letters, numbers, and dashes (3–20 chars).');
  }

  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error('You must be logged in.');

  // Guard against duplicate legacy database entries even if the old database
  // was created before the UNIQUE(code) constraint existed.
  const { data: existing, error: existingError } = await supabase
    .from('classrooms')
    .select('id')
    .eq('code', normalized)
    .limit(1)
    .maybeSingle();

  if (existingError) throw new Error(existingError.message);
  if (existing) throw new Error(`Classroom code "${normalized}" is already taken.`);

  const { data: classroom, error } = await supabase
    .from('classrooms')
    .insert({ name: trimmedName, code: normalized, created_by: uid })
    .select()
    .single();

  if (error) {
    if (error.code === '23505') throw new Error(`Classroom code "${normalized}" is already taken.`);
    throw new Error(error.message);
  }

  await joinClassroomById(classroom.id);
  currentClassroom = classroom;
  return classroom;
}

/** Join an existing classroom by its code, e.g. "CSE-A-2026". */
export async function joinClassroomByCode(code) {
  const normalized = normalizeCode(code);

  const { data: classroom, error } = await supabase
    .from('classrooms')
    .select('*')
    .eq('code', normalized)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!classroom) throw new Error(`No classroom found with code "${normalized}".`);

  await joinClassroomById(classroom.id);
  currentClassroom = classroom;
  return classroom;
}

async function joinClassroomById(classroomId) {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;

  if (!uid) {
    throw new Error('You must be logged in.');
  }

  const { error } = await supabase
    .from('classroom_members')
    .insert({
      classroom_id: classroomId,
      user_id: uid,
    });

  // Already a member = perfectly fine.
  if (error && error.code !== '23505') {
    throw new Error(error.message);
  }
}

/** All classrooms the current user belongs to.
 *
 * This intentionally reads memberships first instead of relying on a nested
 * relation. It prevents duplicate UI cards when legacy data contains repeated
 * membership/classroom rows. We also de-duplicate by classroom code because
 * classroom codes are intended to be unique.
 */
export async function getMyClassrooms() {
  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error('You must be logged in.');

  const { data: memberships, error: memberError } = await supabase
    .from('classroom_members')
    .select('classroom_id, joined_at')
    .eq('user_id', uid);
  if (memberError) throw new Error(memberError.message);

  const ids = [...new Set((memberships || []).map((m) => m.classroom_id).filter(Boolean))];
  if (!ids.length) return [];

  const { data: classrooms, error: classroomError } = await supabase
    .from('classrooms')
    .select('id, name, code, created_at, created_by')
    .in('id', ids);
  if (classroomError) throw new Error(classroomError.message);

  const joinedAtById = new Map(
    (memberships || []).map((m) => [m.classroom_id, m.joined_at])
  );

  // Legacy databases may contain multiple classroom rows with the same code.
  // Keep one card per code, preferring a classroom owned by the current user
  // and otherwise the newest row.
  const byCode = new Map();
  for (const room of classrooms || []) {
    const candidate = { ...room, joined_at: joinedAtById.get(room.id) || null };
    const key = normalizeCode(room.code || '');
    const previous = byCode.get(key);
    if (!previous) {
      byCode.set(key, candidate);
      continue;
    }

    const candidateOwned = candidate.created_by === uid;
    const previousOwned = previous.created_by === uid;
    const candidateTime = new Date(candidate.created_at || 0).getTime();
    const previousTime = new Date(previous.created_at || 0).getTime();
    if ((candidateOwned && !previousOwned) ||
        (candidateOwned === previousOwned && candidateTime > previousTime)) {
      byCode.set(key, candidate);
    }
  }

  return [...byCode.values()].sort((a, b) =>
    new Date(b.created_at || 0) - new Date(a.created_at || 0)
  );
}

/** Member profiles for a classroom (used to scope the lobby/leaderboard). */
export async function getClassroomMembers(classroomId) {
  const { data, error } = await supabase
    .from('classroom_members')
    .select('user_id, profiles(id, username, avatar_url, rating, status, wins, losses, games_played)')
    .eq('classroom_id', classroomId);
  if (error) throw new Error(error.message);
  return (data || []).map((row) => row.profiles).filter(Boolean);
}

/** Delete a classroom owned by the current user. Historical matches are detached first. */
export async function deleteClassroom(classroomId) {
  if (!classroomId) throw new Error('Invalid classroom.');

  const { data, error } = await supabase.rpc('delete_classroom', {
    p_classroom_id: classroomId,
  });

  if (error) throw new Error(error.message);
  if (data !== true) throw new Error('You can only delete classrooms you created.');

  if (currentClassroom?.id === classroomId) {
    currentClassroom = null;
  }

  return true;
}

export function setCurrentClassroom(classroom) {
  currentClassroom = classroom;
}
