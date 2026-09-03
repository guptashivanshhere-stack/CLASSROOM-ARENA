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
  if (!/^[A-Z0-9-]{3,20}$/.test(normalized)) {
    throw new Error('Classroom codes may only contain letters, numbers, and dashes (3–20 chars).');
  }

  const { data: userData } = await supabase.auth.getUser();
  const uid = userData.user?.id;
  if (!uid) throw new Error('You must be logged in.');

  const { data: classroom, error } = await supabase
    .from('classrooms')
    .insert({ name: name.trim(), code: normalized, created_by: uid })
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

/** All classrooms the current user belongs to. */
export async function getMyClassrooms() {
  const { data, error } = await supabase
    .from('classroom_members')
    .select('joined_at, classrooms(id, name, code, created_at)');
  if (error) throw new Error(error.message);
  return (data || []).map((row) => ({ ...row.classrooms, joined_at: row.joined_at }));
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

export function setCurrentClassroom(classroom) {
  currentClassroom = classroom;
}
