// multiplayer.js
// ============================================================
// CLASSROOM ARENA — ONLINE MULTIPLAYER
// ============================================================

import { supabase } from './supabaseClient.js';

let matchChannel = null;
let pollHandle = null;
let currentMatchId = null;


// ============================================================
// QUICK MATCH
// ============================================================

export async function startQuickMatch({
  classroomId = null,
  onSearching,
  signal
}) {

  const startedAt = Date.now();

  return new Promise((resolve, reject) => {

    let finished = false;

    const finish = (matchId) => {

      if (finished) return;

      finished = true;

      if (pollHandle) {
        clearTimeout(pollHandle);
        pollHandle = null;
      }

      resolve(matchId);
    };


    const poll = async () => {

      if (finished) return;


      // --------------------------------------------------------
      // Cancelled by user
      // --------------------------------------------------------

      if (signal?.aborted) {

        await cancelQuickMatch();

        finish(null);

        return;
      }


      try {

        // ------------------------------------------------------
        // Ask server to find/create a match
        // ------------------------------------------------------

        const {
          data: matchId,
          error
        } = await supabase.rpc(
          'try_matchmake',
          {
            p_classroom_id: classroomId
          }
        );


        if (error) {
          throw error;
        }


        // ------------------------------------------------------
        // MATCH FOUND
        // ------------------------------------------------------

        if (matchId) {

          currentMatchId = matchId;

          finish(matchId);

          return;
        }


        // ------------------------------------------------------
        // STILL SEARCHING
        // ------------------------------------------------------

        const elapsedSeconds = Math.round(
          (Date.now() - startedAt) / 1000
        );

        onSearching?.(elapsedSeconds);


        pollHandle = setTimeout(
          poll,
          1500
        );

      } catch (err) {

        if (finished) return;

        finished = true;

        if (pollHandle) {
          clearTimeout(pollHandle);
          pollHandle = null;
        }

        reject(err);
      }

    };


    // Start immediately
    poll();

  });
}


// ============================================================
// CANCEL QUICK MATCH
// ============================================================

export async function cancelQuickMatch() {

  if (pollHandle) {

    clearTimeout(pollHandle);

    pollHandle = null;
  }


  try {

    await supabase.rpc(
      'leave_matchmaking_queue'
    );

  } catch (_) {

    // Best effort only.

  }
}


// ============================================================
// WATCH MATCH
// ============================================================

export function watchMatch(
  matchId,
  onUpdate
) {

  // Remove previous channel first.
  if (matchChannel) {

    supabase.removeChannel(
      matchChannel
    );

    matchChannel = null;
  }


  currentMatchId = matchId;


  // ----------------------------------------------------------
  // Create realtime channel
  // ----------------------------------------------------------

  matchChannel = supabase
    .channel(`match:${matchId}`)

    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'matches',
        filter: `id=eq.${matchId}`
      },

      (payload) => {

        console.log(
          '[MATCH REALTIME]',
          payload.eventType,
          payload.new
        );

        if (payload.new) {

          onUpdate?.(
            payload.new
          );
        }

      }
    )

    .subscribe(
      (status) => {

        console.log(
          '[MATCH CHANNEL]',
          matchId,
          status
        );

      }
    );


  // ----------------------------------------------------------
  // Immediately load current match
  // ----------------------------------------------------------

  supabase
    .from('matches')
    .select('*')
    .eq('id', matchId)
    .single()

    .then(({ data, error }) => {

      if (error) {

        console.error(
          '[MATCH LOAD ERROR]',
          error
        );

        return;
      }

      if (data) {

        console.log(
          '[MATCH INITIAL STATE]',
          data
        );

        onUpdate?.(data);
      }

    });


  // ----------------------------------------------------------
  // Return unsubscribe function
  // ----------------------------------------------------------

  return () => {

    if (matchChannel) {

      supabase.removeChannel(
        matchChannel
      );

      matchChannel = null;
    }

    currentMatchId = null;
  };

}


// ============================================================
// PLACE PIECE
// ============================================================

export async function submitPlacement(
  matchId,
  cell
) {

  const {
    data,
    error
  } = await supabase.rpc(
    'make_move',
    {
      p_match_id: matchId,

      p_action: {
        type: 'place',
        cell: cell
      }
    }
  );


  if (error) {

    throw new Error(
      cleanRpcError(
        error.message
      )
    );

  }


  return data;
}


// ============================================================
// MOVE PIECE
// ============================================================

export async function submitMove(
  matchId,
  from,
  to
) {

  const {
    data,
    error
  } = await supabase.rpc(
    'make_move',
    {
      p_match_id: matchId,

      p_action: {
        type: 'move',
        from: from,
        to: to
      }
    }
  );


  if (error) {

    throw new Error(
      cleanRpcError(
        error.message
      )
    );

  }


  return data;
}


// ============================================================
// SELECT PIECE
// ============================================================

export async function setSelectedCell(
  matchId,
  cell
) {

  const {
    error
  } = await supabase.rpc(
    'set_selected_cell',
    {
      p_match_id: matchId,
      p_cell: cell
    }
  );


  if (error) {

    throw new Error(
      cleanRpcError(
        error.message
      )
    );

  }

}


// ============================================================
// TIMEOUT
// ============================================================

export async function claimTimeoutForfeit(
  matchId
) {

  const {
    data,
    error
  } = await supabase.rpc(
    'forfeit_on_timeout',
    {
      p_match_id: matchId
    }
  );


  if (error) {

    throw new Error(
      cleanRpcError(
        error.message
      )
    );

  }


  return data;
}


// ============================================================
// ABANDON MATCH
// ============================================================

export async function abandonMatch(
  matchId
) {

  try {

    await supabase.rpc(
      'abandon_match',
      {
        p_match_id: matchId
      }
    );

  } catch (_) {

    // Best effort.

  }

}


// ============================================================
// REMATCH
// ============================================================

export async function requestRematch(
  matchId
) {

  const {
    error
  } = await supabase.rpc(
    'request_rematch',
    {
      p_match_id: matchId
    }
  );


  if (error) {

    throw new Error(
      cleanRpcError(
        error.message
      )
    );

  }

}


// ============================================================
// RESPOND TO REMATCH
// ============================================================

export async function respondToRematch(
  matchId,
  accept
) {

  const {
    data,
    error
  } = await supabase.rpc(
    'respond_to_rematch',
    {
      p_match_id: matchId,
      p_accept: accept
    }
  );


  if (error) {

    throw new Error(
      cleanRpcError(
        error.message
      )
    );

  }


  return data;
}


// ============================================================
// CLEAN POSTGRES ERROR
// ============================================================

function cleanRpcError(
  message
) {

  if (!message) {
    return 'Something went wrong.';
  }


  return message
    .replace(
      /^.*?ERROR:\s*/i,
      ''
    )
    .split('\n')[0];

}


// ============================================================
// DEBUG HELPER
// ============================================================

export function getCurrentMatchId() {

  return currentMatchId;

}