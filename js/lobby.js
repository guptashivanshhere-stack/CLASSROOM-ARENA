// lobby.js
// Realtime classroom lobby using Supabase Presence.
//
// Presence = actual online connection.
// profiles.status = available / in_game / offline.
//
// Responsibilities:
// - Show classroom members
// - Detect who is actually online
// - Show available / in-game status
// - Handle challenges
// - Handle profile status changes
// - Clean up Realtime channels correctly

import { supabase } from './supabaseClient.js';

let presenceChannel = null;
let challengeChannel = null;
let profilesChannel = null;

let currentClassroomId = null;
let currentUserId = null;

let callbacks = {
  onPlayersChange: null,
  onChallengeReceived: null,
  onChallengeUpdated: null,
};

export function getCurrentUserId() {
  return currentUserId;
}


// ============================================================
// ENTER LOBBY
// ============================================================

export async function enterLobby(
  classroomId,
  {
    onPlayersChange,
    onChallengeReceived,
    onChallengeUpdated,
  } = {}
) {

  // Clean up previous lobby first.
  await leaveLobby();

  const {
    data: userData,
    error: userError,
  } = await supabase.auth.getUser();

  if (userError) {
    throw userError;
  }

  const uid = userData.user?.id;

  if (!uid) {
    throw new Error('You must be logged in.');
  }

  if (!classroomId) {
    throw new Error('No classroom selected.');
  }

  currentClassroomId = classroomId;
  currentUserId = uid;

  callbacks = {
    onPlayersChange,
    onChallengeReceived,
    onChallengeUpdated,
  };


  // ==========================================================
  // MARK USER AVAILABLE
  // ==========================================================

  const {
    error: statusError,
  } = await supabase.rpc(
    'set_my_status',
    {
      p_status: 'available',
    }
  );

  if (statusError) {
    console.error(
      'Could not set available status:',
      statusError
    );
  }


  // ==========================================================
  // SUPABASE PRESENCE
  // ==========================================================

  presenceChannel = supabase.channel(
    `lobby:${classroomId}`,
    {
      config: {
        presence: {
          key: uid,
        },
      },
    }
  );


  // Presence synchronization.
  presenceChannel
    .on(
      'presence',
      {
        event: 'sync',
      },
      async () => {
        console.log(
          'Lobby presence synchronized'
        );

        await refreshPlayers();
      }
    )

    .on(
      'presence',
      {
        event: 'join',
      },
      async (payload) => {
        console.log(
          'Player joined lobby:',
          payload
        );

        await refreshPlayers();
      }
    )

    .on(
      'presence',
      {
        event: 'leave',
      },
      async (payload) => {
        console.log(
          'Player left lobby:',
          payload
        );

        await refreshPlayers();
      }
    );


  // Subscribe to Presence.
  presenceChannel.subscribe(
    async (status) => {

      console.log(
        'Lobby presence status:',
        status
      );

      if (status === 'SUBSCRIBED') {

        try {

          await presenceChannel.track({
            user_id: uid,
            classroom_id: classroomId,
            online_at:
              new Date().toISOString(),
          });

          console.log(
            'Presence tracking started'
          );

          await refreshPlayers();

        } catch (error) {

          console.error(
            'Presence tracking failed:',
            error
          );

        }
      }
    }
  );


  // ==========================================================
  // PROFILE STATUS REALTIME CHANNEL
  // ==========================================================

  profilesChannel = supabase
    .channel(
      `profiles:${classroomId}:${uid}`
    )

    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
      },
      async (payload) => {

        console.log(
          'Profile status changed:',
          payload.new
        );

        await refreshPlayers();
      }
    )

    .subscribe(
      (status) => {

        console.log(
          'Profile realtime status:',
          status
        );

      }
    );


  // ==========================================================
  // CHALLENGE CHANNEL
  // ==========================================================

  challengeChannel = supabase
    .channel(
      `challenges:${uid}`
    )

    // Someone challenges me.
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'challenges',
        filter:
          `challenged_id=eq.${uid}`,
      },
      (payload) => {

        console.log(
          'Incoming challenge:',
          payload.new
        );

        callbacks
          .onChallengeReceived
          ?.(
            payload.new
          );
      }
    )

    // Challenge I sent was updated.
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'challenges',
        filter:
          `challenger_id=eq.${uid}`,
      },
      (payload) => {

        console.log(
          'Challenge updated:',
          payload.new
        );

        callbacks
          .onChallengeUpdated
          ?.(
            payload.new
          );
      }
    )

    .subscribe(
      (status) => {

        console.log(
          'Challenge realtime status:',
          status
        );

      }
    );


  // Return refresh function.
  return refreshPlayers;
}


// ============================================================
// REFRESH PLAYERS
// ============================================================

async function refreshPlayers() {

  if (!currentClassroomId) {
    return;
  }

  try {

    const players =
      await getClassroomPlayers(
        currentClassroomId
      );

    callbacks
      .onPlayersChange
      ?.(
        players
      );

  } catch (error) {

    console.error(
      'Could not refresh lobby:',
      error
    );

  }
}


// ============================================================
// GET CLASSROOM PLAYERS
// ============================================================

async function getClassroomPlayers(
  classroomId
) {

  const {
    data,
    error,
  } = await supabase

    .from('classroom_members')

    .select(`
      user_id,
      profiles(
        id,
        username,
        avatar_url,
        rating,
        status,
        wins,
        losses,
        games_played,
        last_seen
      )
    `)

    .eq(
      'classroom_id',
      classroomId
    );


  if (error) {

    console.error(
      'getClassroomPlayers:',
      error
    );

    return [];
  }


  // ----------------------------------------------------------
  // Get classroom members
  // ----------------------------------------------------------

  const members =
    (data || [])
      .map(
        (row) =>
          row.profiles
      )
      .filter(Boolean);


  // ----------------------------------------------------------
  // Get REAL Supabase Presence
  // ----------------------------------------------------------

  const presenceUsers =
    new Set();


  if (presenceChannel) {

    const state =
      presenceChannel
        .presenceState();


    for (
      const key of Object.keys(state)
    ) {

      const presences =
        state[key];


      for (
        const presence
        of presences
      ) {

        // Supabase Presence exposes the configured presence key separately
        // from the tracked payload. Use user_id when available, otherwise
        // fall back to the key so online detection remains reliable.
        const presenceUserId =
          presence.user_id || key;

        if (presenceUserId) {
          presenceUsers.add(
            presenceUserId
          );
        }

      }

    }

  }


  // ----------------------------------------------------------
  // Add online information
  // ----------------------------------------------------------

  const players =
    members.map(
      (player) => {

        const isOnline =
          presenceUsers.has(
            player.id
          );


        let currentStatus =
          'offline';


        if (isOnline) {

          if (
            player.status ===
            'in_game'
          ) {

            currentStatus =
              'in_game';

          } else {

            currentStatus =
              'available';

          }

        }


        return {

          ...player,

          // True realtime presence.
          online:
            isOnline,

          // Original database status.
          profileStatus:
            player.status,

          // Calculated lobby status.
          status:
            currentStatus,

          // Authoritative self marker from the Supabase auth user used
          // to enter this lobby. This avoids showing the current user as
          // an opponent if the auth module is temporarily out of sync.
          isCurrentUser:
            player.id === currentUserId,

        };

      }
    );


  // ----------------------------------------------------------
  // Sort by rating
  // ----------------------------------------------------------

  players.sort(
    (a, b) =>
      (b.rating || 0) -
      (a.rating || 0)
  );


  return players;
}


// ============================================================
// LEAVE LOBBY
// ============================================================

export async function leaveLobby() {

  // ----------------------------------------------------------
  // Mark player offline
  // ----------------------------------------------------------

  try {

    if (currentUserId) {

      await supabase.rpc(
        'set_my_status',
        {
          p_status: 'offline',
        }
      );

    }

  } catch (error) {

    console.warn(
      'Could not set offline:',
      error
    );

  }


  // ----------------------------------------------------------
  // Stop Presence
  // ----------------------------------------------------------

  if (presenceChannel) {

    try {

      await presenceChannel.untrack();

    } catch (_) {
      // Ignore untrack errors.
    }


    await supabase.removeChannel(
      presenceChannel
    );

  }


  // ----------------------------------------------------------
  // Remove Profile channel
  // ----------------------------------------------------------

  if (profilesChannel) {

    await supabase.removeChannel(
      profilesChannel
    );

  }


  // ----------------------------------------------------------
  // Remove Challenge channel
  // ----------------------------------------------------------

  if (challengeChannel) {

    await supabase.removeChannel(
      challengeChannel
    );

  }


  // ----------------------------------------------------------
  // Reset state
  // ----------------------------------------------------------

  presenceChannel = null;
  profilesChannel = null;
  challengeChannel = null;

  currentClassroomId = null;
  currentUserId = null;

  callbacks = {
    onPlayersChange: null,
    onChallengeReceived: null,
    onChallengeUpdated: null,
  };
}


// ============================================================
// SEND CHALLENGE
// ============================================================

export async function sendChallenge(
  challengedId
) {

  const {
    data: userData,
  } =
    await supabase.auth.getUser();


  const uid =
    userData.user?.id;


  if (!uid) {

    throw new Error(
      'You must be logged in.'
    );

  }


  if (
    uid === challengedId
  ) {

    throw new Error(
      'You cannot challenge yourself.'
    );

  }


  // ----------------------------------------------------------
  // Check target status
  // ----------------------------------------------------------

  const {
    data: target,
    error: targetError,
  } =
    await supabase

      .from('profiles')

      .select('status')

      .eq(
        'id',
        challengedId
      )

      .single();


  if (targetError) {

    throw new Error(
      targetError.message
    );

  }


  if (
    target?.status !==
    'available'
  ) {

    throw new Error(
      'That player is not available right now.'
    );

  }


  // ----------------------------------------------------------
  // Create challenge
  // ----------------------------------------------------------

  const {
    data,
    error,
  } =
    await supabase

      .from('challenges')

      .insert({
        challenger_id:
          uid,

        challenged_id:
          challengedId,
      })

      .select()

      .single();


  if (error) {

    throw new Error(
      error.message
    );

  }


  return data;
}


// ============================================================
// ACCEPT / DECLINE CHALLENGE
// ============================================================

export async function respondToChallenge(
  challengeId,
  accept
) {

  const {
    data,
    error,
  } =
    await supabase.rpc(
      'respond_to_challenge',
      {
        p_challenge_id:
          challengeId,

        p_accept:
          accept,
      }
    );


  if (error) {

    throw new Error(
      error.message
    );

  }


  // If accepted, RPC should return match ID.
  // If declined, it should return null.
  return data;
}


// ============================================================
// CANCEL CHALLENGE
// ============================================================

export async function cancelChallenge(
  challengeId
) {

  const {
    error,
  } =
    await supabase.rpc(
      'cancel_challenge',
      {
        p_challenge_id:
          challengeId,
      }
    );


  if (error) {

    throw new Error(
      error.message
    );

  }
}