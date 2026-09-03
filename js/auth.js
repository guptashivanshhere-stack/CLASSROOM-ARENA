// auth.js — Supabase Authentication wiring.
// Profile rows are created server-side by the handle_new_user() trigger
// (see sql/schema.sql) the moment a user signs up, using the username
// passed in as signup metadata. Username uniqueness is enforced by a
// UNIQUE constraint on profiles.username, so a duplicate signup fails
// with a clear Postgres error we translate below.

import { supabase } from './supabaseClient.js';

let currentUser = null;
let currentProfile = null;
const listeners = new Set();

export function onAuthChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) fn({ user: currentUser, profile: currentProfile });
}

export function getUser() {
  return currentUser;
}

export function getProfile() {
  return currentProfile;
}

/** Call once on app boot. Restores an existing session if present. */
export async function initAuth() {
  const { data } = await supabase.auth.getSession();
  currentUser = data.session?.user ?? null;
  if (currentUser) await refreshProfile();
  notify();

  supabase.auth.onAuthStateChange(async (_event, session) => {
    currentUser = session?.user ?? null;
    currentProfile = currentUser ? await fetchProfile(currentUser.id) : null;
    notify();
  });
}

async function fetchProfile(userId) {
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
  if (error) {
    console.error('Failed to load profile', error);
    return null;
  }
  return data;
}

export async function refreshProfile() {
  if (!currentUser) return null;
  currentProfile = await fetchProfile(currentUser.id);
  return currentProfile;
}

/**
 * Sign up a new player.
 * Throws a friendly Error on: duplicate username, weak password, etc.
 */
export async function signUp({ email, password, username }) {
  username = username.trim();
  if (username.length < 3 || username.length > 20) {
    throw new Error('Username must be 3–20 characters.');
  }
  if (!/^[a-zA-Z0-9_]+$/.test(username)) {
    throw new Error('Username can only contain letters, numbers, and underscores.');
  }

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { username } },
  });

  if (error) {
    if (/already registered/i.test(error.message)) {
      throw new Error('An account already exists for that email.');
    }
    throw new Error(error.message);
  }

  currentUser = data.user;
  if (currentUser) await refreshProfile();
  notify();
  return data;
}

export async function logIn({ email, password }) {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    throw new Error('Incorrect email or password.');
  }
  currentUser = data.user;
  await refreshProfile();
  notify();
  return data;
}

export async function logOut() {
  if (currentUser) {
    // Best-effort presence cleanup; ignore failures on the way out.
    try {
      await supabase.rpc('set_my_status', { p_status: 'offline' });
    } catch (_) { /* noop */ }
  }
  await supabase.auth.signOut();
  currentUser = null;
  currentProfile = null;
  notify();
}

export function isLoggedIn() {
  return Boolean(currentUser);
}
