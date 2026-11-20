------------------------------ MODULE ManualNext ------------------------------
(* A press of Next (#164): the screen button, the notification and the
   verification control all call request_skip_next in src-tauri/src/lib.rs.
   press_manual_next and the funkot-next-wait thread send the request with
   dispatch_manual_next; the audio callback's publish_next_state resolves it;
   commit_future_update_on (a saved list or queue change) and
   revoke_reserved_on (a manual track takes the next slot) report a discard
   through forget_discarded_manual_next; spawn_analysis_worker yields to it
   through LIBRARY_ANALYSIS_BUSY.

   Each host action is one atomic load or store, or one section under the
   render mutex. Each trailing comment "lib.rs:FN | FRAGMENT" binds the action
   to text that must appear in function FN; check_manual_next.py rejects the
   model when the fragment is missing.

   The engine (funkot-core, pinned by funkot-core.commit) is abstract. One
   render may drain the navigation channel and then take one step: prepare
   the next track, start a transition into it, end that transition (the next
   track becomes current) or finish. Normal mode keeps only the last queued
   command (drain_nav_commands with prefetch_depth 0). begin_nav drops
   TransitionToNext when no next track is ready or one is already accepted.
   While the future fence is held, commands stay queued and no transition
   starts.

   Left out: pause (a paused, silent callback renders nothing), audition
   (request_skip_next refuses it), labeling mode, the phase check in the wait
   thread, a full navigation channel, the startup wait in wait_out_startup,
   and the memory ordering of the atomics: TLC explores interleavings of
   sequentially consistent steps only.

   Break selects a deliberately broken copy of the code, for the runner's
   sensitivity check; "none" is the code. *)

EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS MaxPresses, Tracks, MaxSaves, MaxRevokes, Slots, Files, Break

ASSUME Break \in {"none", "no_forget", "no_recheck", "no_waiter",
                  "no_snapshot_check", "no_busy_check"}

VARIABLES
    \* engine (inside the render mutex)
    cur, fin, nxt, xfade, chan, req, fence,
    \* host atomics
    prepared, pending, inflight, expected, discards, busy, obsCur, obsFin,
    \* render mutex owner
    lock,
    \* audio callback
    cb, cbDone,
    \* save commit or manual-priority revoke
    fz, saves, revokes,
    \* press handlers and wait threads, one slot each
    hpc, hexp, hdisc, rlock, presses,
    \* library analysis worker
    apc,
    \* history for the rules
    stale, sentDuringDecode

vars == <<cur, fin, nxt, xfade, chan, req, fence, prepared, pending, inflight,
          expected, discards, busy, obsCur, obsFin, lock, cb, cbDone, fz, saves,
          revokes, hpc, hexp, hdisc, rlock, presses, apc, stale, sentDuringDecode>>

engineVars == <<cur, fin, nxt, xfade, chan, req, fence>>
hostVars == <<prepared, pending, inflight, expected, discards, busy, obsCur, obsFin>>
slotVars == <<hpc, hexp, hdisc, rlock, presses>>
historyVars == <<stale, sentDuringDecode>>

S == 1..Slots
Index == 0..(Tracks - 1)
SlotPcs == {"idle", "lp", "li", "rd", "se", "sp", "rp", "rb",
            "w1", "wp", "wb",
            "d1", "d2", "d3", "d4", "d5", "d5c", "d6", "d7", "d8", "d9", "d10"}

TypeOK ==
    /\ cur \in Index /\ fin \in BOOLEAN /\ nxt \in BOOLEAN /\ xfade \in BOOLEAN
    /\ chan \in Seq(Index) /\ Len(chan) <= MaxPresses
    /\ req \in BOOLEAN /\ fence \in BOOLEAN
    /\ prepared \in BOOLEAN /\ pending \in BOOLEAN /\ inflight \in BOOLEAN
    /\ expected \in Index /\ discards \in 0..(MaxSaves + MaxRevokes)
    /\ busy \in BOOLEAN /\ obsCur \in Index /\ obsFin \in BOOLEAN
    /\ lock \in {"none", "cb", "fz"}
    /\ cb \in {"idle", "c1", "c2", "c3", "c4", "c5"} /\ cbDone \in BOOLEAN
    /\ fz \in {"idle", "held", "f1", "f2", "f3", "f4"}
    /\ saves \in 0..MaxSaves /\ revokes \in 0..MaxRevokes
    /\ hpc \in [S -> SlotPcs] /\ hexp \in [S -> Index]
    /\ hdisc \in [S -> 0..(MaxSaves + MaxRevokes)]
    /\ rlock \in {0} \cup S /\ presses \in 0..MaxPresses
    /\ apc \in {"set", "lp", "li", "back", "dec", "rel", "done"}
    /\ stale \in BOOLEAN /\ sentDuringDecode \in BOOLEAN

Init ==
    /\ cur = 0 /\ fin = FALSE /\ nxt = FALSE /\ xfade = FALSE
    /\ chan = <<>> /\ req = FALSE /\ fence = FALSE
    /\ prepared = FALSE /\ pending = FALSE /\ inflight = FALSE
    /\ expected = 0 /\ discards = 0 /\ busy = FALSE
    /\ obsCur = 0 /\ obsFin = FALSE
    /\ lock = "none" /\ cb = "idle" /\ cbDone = FALSE
    /\ fz = "idle" /\ saves = 0 /\ revokes = 0
    /\ hpc = [s \in S |-> "idle"] /\ hexp = [s \in S |-> 0]
    /\ hdisc = [s \in S |-> 0] /\ rlock = 0 /\ presses = 0
    /\ apc = IF Files > 0 THEN "set" ELSE "done"
    /\ stale = FALSE /\ sentDuringDecode = FALSE

Go(s, pc) == hpc' = [hpc EXCEPT ![s] = pc]

----------------------------------------------------------------------------
\* press_manual_next: the request lock covers the flag check and the stores

PressLocks(s) ==
    /\ hpc[s] = "idle" /\ rlock = 0 /\ presses < MaxPresses
    /\ rlock' = s /\ presses' = presses + 1 \* lib.rs:press_manual_next | let _request = MANUAL_NEXT_REQUEST_LOCK.lock()
    /\ Go(s, "lp")
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hexp, hdisc, apc, historyVars>>

\* An earlier Next still owns the button: Ignored.
PressLoadsPending(s) ==
    /\ hpc[s] = "lp"
    /\ IF pending                      \* lib.rs:press_manual_next | MANUAL_NEXT_PENDING.load(Ordering::Acquire),
       THEN Go(s, "idle") /\ rlock' = 0 \* lib.rs:press_manual_next | return Ok(ManualNextPress::Ignored);
       ELSE Go(s, "li") /\ UNCHANGED rlock
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hexp, hdisc, presses, apc, historyVars>>

PressLoadsInFlight(s) ==
    /\ hpc[s] = "li"
    /\ IF inflight                     \* lib.rs:press_manual_next | MANUAL_NEXT_IN_FLIGHT.load(Ordering::Acquire)) {
       THEN Go(s, "idle") /\ rlock' = 0
       ELSE Go(s, "rd") /\ UNCHANGED rlock
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hexp, hdisc, presses, apc, historyVars>>

PressReadsCurrent(s) ==
    /\ hpc[s] = "rd"
    /\ hexp' = [hexp EXCEPT ![s] = obsCur] \* lib.rs:press_manual_next | let current = playback.observation.read()
    /\ Go(s, "se")
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hdisc, rlock, presses, apc, historyVars>>

PressStoresExpected(s) ==
    /\ hpc[s] = "se"
    /\ expected' = hexp[s]             \* lib.rs:press_manual_next | MANUAL_NEXT_EXPECTED_INDEX.store(current, Ordering::Release);
    /\ Go(s, "sp")
    /\ UNCHANGED <<cur, fin, nxt, xfade, chan, req, fence, prepared, pending,
                   inflight, discards, busy, obsCur, obsFin, lock, cb, cbDone,
                   fz, saves, revokes, hexp, hdisc, rlock, presses, apc, historyVars>>

PressStoresPending(s) ==
    /\ hpc[s] = "sp"
    /\ pending' = TRUE                 \* lib.rs:press_manual_next | MANUAL_NEXT_PENDING.store(true, Ordering::Release);
    /\ rlock' = 0                      \* lib.rs:press_manual_next | drop(_request);
    /\ Go(s, "rp")
    /\ UNCHANGED <<engineVars, prepared, inflight, expected, discards, busy, obsCur,
                   obsFin, lock, cb, cbDone, fz, saves, revokes, hexp, hdisc,
                   presses, apc, historyVars>>

\* next_dispatch_ready, from the press or from the wait thread. Not ready:
\* the press returns Waiting and request_skip_next spawns the wait thread,
\* which this slot then runs.
WaitOrEnd == IF Break = "no_waiter" THEN "idle" ELSE "w1"

ReadyLoadsPrepared(s) ==
    /\ hpc[s] \in {"rp", "wp"}
    /\ Go(s, IF prepared THEN (IF hpc[s] = "rp" THEN "rb" ELSE "wb")
             ELSE (IF hpc[s] = "rp" THEN WaitOrEnd ELSE "w1"))
                                       \* lib.rs:next_dispatch_ready | NEXT_PREPARED.load(Ordering::Acquire)
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hexp, hdisc, rlock, presses, apc, historyVars>>

ReadyLoadsBusy(s) ==
    /\ hpc[s] \in {"rb", "wb"}
    /\ Go(s, IF busy /\ Break /= "no_busy_check"
             THEN (IF hpc[s] = "rb" THEN WaitOrEnd ELSE "w1")
             ELSE "d1")                \* lib.rs:next_dispatch_ready | && !LIBRARY_ANALYSIS_BUSY.load(Ordering::Acquire)
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hexp, hdisc, rlock, presses, apc, historyVars>>

----------------------------------------------------------------------------
\* the funkot-next-wait thread (request_skip_next), polling every 20 ms

WaitLoadsPending(s) ==
    /\ hpc[s] = "w1"
    /\ Go(s, IF pending THEN "wp" ELSE "idle") \* lib.rs:request_skip_next | while MANUAL_NEXT_PENDING.load(Ordering::Acquire) {
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hexp, hdisc, rlock, presses, apc, historyVars>>

----------------------------------------------------------------------------
\* dispatch_manual_next. Ok(true) ends the press or the wait thread;
\* Ok(false) goes (back) to the wait loop.

DispatchLoadsPending(s) ==
    /\ hpc[s] = "d1"
    /\ Go(s, IF pending THEN "d2" ELSE "w1") \* lib.rs:dispatch_manual_next | if !MANUAL_NEXT_PENDING.load(Ordering::Acquire) { return Ok(false); }
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hexp, hdisc, rlock, presses, apc, historyVars>>

DispatchLoadsDiscards(s) ==
    /\ hpc[s] = "d2"
    /\ hdisc' = [hdisc EXCEPT ![s] = discards] \* lib.rs:dispatch_manual_next | let discards = MANUAL_NEXT_DISCARDS.load(Ordering::SeqCst);
    /\ Go(s, "d3")
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hexp, rlock, presses, apc, historyVars>>

DispatchLoadsPrepared(s) ==
    /\ hpc[s] = "d3"
    /\ Go(s, IF prepared THEN "d4" ELSE "w1") \* lib.rs:dispatch_manual_next | if !NEXT_PREPARED.load(Ordering::SeqCst) { return Ok(false); }
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hexp, hdisc, rlock, presses, apc, historyVars>>

DispatchLoadsExpected(s) ==
    /\ hpc[s] = "d4"
    /\ hexp' = [hexp EXCEPT ![s] = expected] \* lib.rs:dispatch_manual_next | let expected = MANUAL_NEXT_EXPECTED_INDEX.load(Ordering::Acquire);
    /\ Go(s, "d5")
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hdisc, rlock, presses, apc, historyVars>>

\* The track has already moved on: drop this request.
DispatchReadsSnapshot(s) ==
    /\ hpc[s] = "d5"
    /\ Go(s, IF (obsCur /= hexp[s] \/ obsFin) /\ Break /= "no_snapshot_check"
             THEN "d5c" ELSE "d6")     \* lib.rs:dispatch_manual_next | if snapshot.current != Some(expected) || snapshot.finished {
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hexp, hdisc, rlock, presses, apc, historyVars>>

DispatchDropsStale(s) ==
    /\ hpc[s] = "d5c"
    /\ pending' = FALSE                \* lib.rs:dispatch_manual_next | MANUAL_NEXT_PENDING.store(false, Ordering::Release);
    /\ Go(s, "w1")
    /\ UNCHANGED <<engineVars, prepared, inflight, expected, discards, busy, obsCur,
                   obsFin, lock, cb, cbDone, fz, saves, revokes, hexp, hdisc,
                   rlock, presses, apc, historyVars>>

DispatchSetsInFlight(s) ==
    /\ hpc[s] = "d6"
    /\ inflight' = TRUE                \* lib.rs:dispatch_manual_next | MANUAL_NEXT_IN_FLIGHT.store(true, Ordering::SeqCst);
    /\ Go(s, "d7")
    /\ UNCHANGED <<engineVars, prepared, pending, expected, discards, busy, obsCur,
                   obsFin, lock, cb, cbDone, fz, saves, revokes, hexp, hdisc,
                   rlock, presses, apc, historyVars>>

\* The message carries no index; hexp remembers which track it was for.
DispatchSends(s) ==
    /\ hpc[s] = "d7"
    /\ chan' = Append(chan, hexp[s])   \* lib.rs:dispatch_manual_next | match playback.nav_tx.try_send(NavAction::TransitionToNext) {
    /\ sentDuringDecode' = (sentDuringDecode \/ apc = "dec")
    /\ Go(s, "d8")
    /\ UNCHANGED <<cur, fin, nxt, xfade, req, fence, hostVars, lock, cb, cbDone,
                   fz, saves, revokes, hexp, hdisc, rlock, presses, apc, stale>>

DispatchClearsPending(s) ==
    /\ hpc[s] = "d8"
    /\ pending' = FALSE                \* lib.rs:dispatch_manual_next | MANUAL_NEXT_PENDING.store(false, Ordering::Release);
    /\ Go(s, IF Break = "no_recheck" THEN "idle" ELSE "d9")
    /\ UNCHANGED <<engineVars, prepared, inflight, expected, discards, busy, obsCur,
                   obsFin, lock, cb, cbDone, fz, saves, revokes, hexp, hdisc,
                   rlock, presses, apc, historyVars>>

\* A discard between the readiness check and the send may have drained this
\* message unseen: give the button back.
DispatchRechecksDiscards(s) ==
    /\ hpc[s] = "d9"
    /\ Go(s, IF discards /= hdisc[s] THEN "d10" ELSE "idle")
                                       \* lib.rs:dispatch_manual_next | if MANUAL_NEXT_DISCARDS.load(Ordering::SeqCst) != discards {
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   hexp, hdisc, rlock, presses, apc, historyVars>>

DispatchClearsInFlight(s) ==
    /\ hpc[s] = "d10"
    /\ inflight' = FALSE               \* lib.rs:dispatch_manual_next | MANUAL_NEXT_IN_FLIGHT.store(false, Ordering::SeqCst);
    /\ Go(s, "idle")
    /\ UNCHANGED <<engineVars, prepared, pending, expected, discards, busy, obsCur,
                   obsFin, lock, cb, cbDone, fz, saves, revokes, hexp, hdisc,
                   rlock, presses, apc, historyVars>>

----------------------------------------------------------------------------
\* The audio callback in open_output_stream, under the render mutex
\* (try_lock: a miss renders nothing and changes nothing here).

\* Engine::render: drain_nav_commands, then one step of the engine.
Drain ==
    IF fence \/ chan = <<>> THEN [c |-> chan, r |-> req, s |-> FALSE]
    ELSE LET last == chan[Len(chan)] IN
         IF nxt /\ ~req
         THEN [c |-> <<>>, r |-> TRUE, s |-> last /= cur]
         ELSE [c |-> <<>>, r |-> req, s |-> FALSE]

CallbackRenders ==
    /\ cb = "idle" /\ lock = "none"
    /\ lock' = "cb" /\ cb' = "c1"
    /\ LET d == Drain IN
       /\ chan' = d.c
       /\ stale' = (stale \/ d.s)
       /\ \/ /\ nxt' = nxt /\ xfade' = xfade /\ cur' = cur /\ fin' = fin /\ req' = d.r
          \* the loader's next track arrives
          \/ /\ ~nxt /\ ~xfade /\ ~fin /\ ~fence /\ cur + 1 < Tracks
             /\ nxt' = TRUE /\ UNCHANGED <<xfade, cur, fin>> /\ req' = d.r
          \* a transition into the next track starts (accepted Next, or the end)
          \/ /\ nxt /\ ~xfade /\ ~fence
             /\ nxt' = FALSE /\ xfade' = TRUE /\ UNCHANGED <<cur, fin>> /\ req' = d.r
          \* the transition ends: the next track is current
          \/ /\ xfade
             /\ cur' = cur + 1 /\ xfade' = FALSE /\ req' = FALSE /\ UNCHANGED <<nxt, fin>>
          \* the last track ends with nothing after it
          \/ /\ ~nxt /\ ~xfade /\ ~fin /\ cur + 1 = Tracks
             /\ fin' = TRUE /\ req' = FALSE /\ UNCHANGED <<nxt, xfade, cur>>
    /\ UNCHANGED <<fence, hostVars, cbDone, fz, saves, revokes, slotVars, apc,
                   sentDuringDecode>>
                                       \* lib.rs:open_output_stream | let frames = transport_fade.render(out, requested_pause, |out| engine.render(out));

CallbackStoresPrepared ==
    /\ cb = "c1"
    /\ prepared' = nxt                 \* lib.rs:publish_next_state | NEXT_PREPARED.store(next_ready, Ordering::Relaxed);
    /\ cb' = "c2"
    /\ UNCHANGED <<engineVars, pending, inflight, expected, discards, busy, obsCur,
                   obsFin, lock, cbDone, fz, saves, revokes, slotVars, apc, historyVars>>

CallbackChecksCompleted ==
    /\ cb = "c2"
    /\ cbDone' = (fin \/ cur /= expected) \* lib.rs:manual_next_completed | finished || current != Some(expected)
    /\ cb' = "c3"
    /\ UNCHANGED <<engineVars, hostVars, lock, fz, saves, revokes, slotVars, apc,
                   historyVars>>

CallbackClearsPending ==
    /\ cb = "c3"
    /\ pending' = IF cbDone THEN FALSE ELSE pending \* lib.rs:publish_next_state | MANUAL_NEXT_PENDING.store(false, Ordering::Release);
    /\ cb' = "c4"
    /\ UNCHANGED <<engineVars, prepared, inflight, expected, discards, busy, obsCur,
                   obsFin, lock, cbDone, fz, saves, revokes, slotVars, apc, historyVars>>

CallbackClearsInFlight ==
    /\ cb = "c4"
    /\ inflight' = IF cbDone THEN FALSE ELSE inflight \* lib.rs:publish_next_state | MANUAL_NEXT_IN_FLIGHT.store(false, Ordering::Release);
    /\ cb' = "c5"
    /\ UNCHANGED <<engineVars, prepared, pending, expected, discards, busy, obsCur,
                   obsFin, lock, cbDone, fz, saves, revokes, slotVars, apc, historyVars>>

CallbackPublishes ==
    /\ cb = "c5"
    /\ obsCur' = cur /\ obsFin' = fin  \* lib.rs:open_output_stream | observation.publish(state.engine.current_index(), state.engine.is_finished());
    /\ cb' = "idle" /\ lock' = "none"
    /\ UNCHANGED <<engineVars, prepared, pending, inflight, expected, discards, busy,
                   cbDone, fz, saves, revokes, slotVars, apc, historyVars>>

----------------------------------------------------------------------------
\* A saved list or queue change (command_with, reconfigure_admission in
\* playlist_service.rs) and a manual track taking the next slot.

SaveBegins ==
    /\ fz = "idle" /\ lock = "none" /\ saves < MaxSaves
    \* begin_future_update refuses during a transition or a navigation
    /\ ~xfade /\ ~req /\ chan = <<>> /\ ~fin
    /\ fence' = TRUE /\ saves' = saves + 1 /\ fz' = "held"
    /\ UNCHANGED <<cur, fin, nxt, xfade, chan, req, hostVars, lock, cb, cbDone,
                   revokes, slotVars, apc, historyVars>>

SaveAborts ==
    /\ fz = "held" /\ lock = "none"
    /\ fence' = FALSE /\ fz' = "idle"
    /\ UNCHANGED <<cur, fin, nxt, xfade, chan, req, hostVars, lock, cb, cbDone,
                   saves, revokes, slotVars, apc, historyVars>>

\* commit_future_update drains the channel and the deferred commands, drops
\* the next track and cancels the accepted request.
SaveCommits ==
    /\ fz = "held" /\ lock = "none"
    /\ chan' = <<>> /\ nxt' = FALSE /\ req' = FALSE /\ fence' = FALSE
                                       \* lib.rs:commit_future_update_on | let retired = render.engine.commit_future_update(token, prepared);
    /\ lock' = "fz" /\ fz' = IF Break = "no_forget" THEN "f4" ELSE "f1"
    /\ UNCHANGED <<cur, fin, xfade, hostVars, cb, cbDone, saves, revokes, slotVars,
                   apc, historyVars>>

\* revoke_next takes the next track and cancels the accepted request; it does
\* not drain the channel.
RevokeTakesNext ==
    /\ fz = "idle" /\ lock = "none" /\ revokes < MaxRevokes
    /\ nxt /\ ~fence /\ ~xfade
    /\ nxt' = FALSE /\ req' = FALSE    \* lib.rs:revoke_reserved_on | let path = state.engine.revoke_next();
    /\ revokes' = revokes + 1
    /\ lock' = "fz" /\ fz' = IF Break = "no_forget" THEN "f4" ELSE "f1"
    /\ UNCHANGED <<cur, fin, xfade, chan, fence, hostVars, cb, cbDone, saves,
                   slotVars, apc, historyVars>>

ForgetClearsPrepared ==
    /\ fz = "f1"
    /\ prepared' = FALSE               \* lib.rs:forget_discarded_manual_next | NEXT_PREPARED.store(false, Ordering::SeqCst);
    /\ fz' = "f2"
    /\ UNCHANGED <<engineVars, pending, inflight, expected, discards, busy, obsCur,
                   obsFin, lock, cb, cbDone, saves, revokes, slotVars, apc, historyVars>>

ForgetCountsDiscard ==
    /\ fz = "f2"
    /\ discards' = discards + 1        \* lib.rs:forget_discarded_manual_next | MANUAL_NEXT_DISCARDS.fetch_add(1, Ordering::SeqCst);
    /\ fz' = "f3"
    /\ UNCHANGED <<engineVars, prepared, pending, inflight, expected, busy, obsCur,
                   obsFin, lock, cb, cbDone, saves, revokes, slotVars, apc, historyVars>>

ForgetClearsInFlight ==
    /\ fz = "f3"
    /\ inflight' = FALSE               \* lib.rs:forget_discarded_manual_next | MANUAL_NEXT_IN_FLIGHT.store(false, Ordering::SeqCst);
    /\ fz' = "f4"
    /\ UNCHANGED <<engineVars, prepared, pending, expected, discards, busy, obsCur,
                   obsFin, lock, cb, cbDone, saves, revokes, slotVars, apc, historyVars>>

\* commit_future_update_on publishes the observation; revoke_reserved_on does
\* not, and publishing the unchanged current is the same.
DiscardReleasesLock ==
    /\ fz = "f4"
    /\ obsCur' = cur /\ obsFin' = fin  \* lib.rs:commit_future_update_on | playback.publish_engine_observation(&render.engine);
    /\ fz' = "idle" /\ lock' = "none"
    /\ UNCHANGED <<engineVars, prepared, pending, inflight, expected, discards, busy,
                   cb, cbDone, saves, revokes, slotVars, apc, historyVars>>

----------------------------------------------------------------------------
\* spawn_analysis_worker, for one file that still needs decoding

AnalysisSetsBusy ==
    /\ apc = "set"
    /\ busy' = TRUE                    \* lib.rs:spawn_analysis_worker | LIBRARY_ANALYSIS_BUSY.store(true, Ordering::Release);
    /\ apc' = "lp"
    /\ UNCHANGED <<engineVars, prepared, pending, inflight, expected, discards, obsCur,
                   obsFin, lock, cb, cbDone, fz, saves, revokes, slotVars, historyVars>>

AnalysisLoadsPending ==
    /\ apc = "lp"
    /\ apc' = IF pending THEN "back" ELSE "li" \* lib.rs:spawn_analysis_worker | MANUAL_NEXT_PENDING.load(Ordering::Acquire),
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   slotVars, historyVars>>

AnalysisLoadsInFlight ==
    /\ apc = "li"
    /\ apc' = IF inflight THEN "back" ELSE "dec" \* lib.rs:spawn_analysis_worker | MANUAL_NEXT_IN_FLIGHT.load(Ordering::Acquire));
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   slotVars, historyVars>>

\* Yield, wait_out_startup, then try again.
AnalysisYields ==
    /\ apc = "back"
    /\ busy' = FALSE                   \* lib.rs:spawn_analysis_worker | if !manual_plan { break; }
    /\ apc' = "set"
    /\ UNCHANGED <<engineVars, prepared, pending, inflight, expected, discards, obsCur,
                   obsFin, lock, cb, cbDone, fz, saves, revokes, slotVars, historyVars>>

AnalysisDecodes ==
    /\ apc = "dec"
    /\ apc' = "rel"                    \* lib.rs:spawn_analysis_worker | match funkot_core::decode::decode_file(path) {
    /\ UNCHANGED <<engineVars, hostVars, lock, cb, cbDone, fz, saves, revokes,
                   slotVars, historyVars>>

AnalysisReleases ==
    /\ apc = "rel"
    /\ busy' = FALSE                   \* lib.rs:spawn_analysis_worker | LIBRARY_ANALYSIS_BUSY.store(false, Ordering::Release);
    /\ apc' = "done"
    /\ UNCHANGED <<engineVars, prepared, pending, inflight, expected, discards, obsCur,
                   obsFin, lock, cb, cbDone, fz, saves, revokes, slotVars, historyVars>>

----------------------------------------------------------------------------

Next ==
    \/ \E s \in S :
        \/ PressLocks(s) \/ PressLoadsPending(s) \/ PressLoadsInFlight(s)
        \/ PressReadsCurrent(s) \/ PressStoresExpected(s) \/ PressStoresPending(s)
        \/ ReadyLoadsPrepared(s) \/ ReadyLoadsBusy(s) \/ WaitLoadsPending(s)
        \/ DispatchLoadsPending(s) \/ DispatchLoadsDiscards(s)
        \/ DispatchLoadsPrepared(s) \/ DispatchLoadsExpected(s)
        \/ DispatchReadsSnapshot(s) \/ DispatchDropsStale(s)
        \/ DispatchSetsInFlight(s) \/ DispatchSends(s) \/ DispatchClearsPending(s)
        \/ DispatchRechecksDiscards(s) \/ DispatchClearsInFlight(s)
    \/ CallbackRenders \/ CallbackStoresPrepared \/ CallbackChecksCompleted
    \/ CallbackClearsPending \/ CallbackClearsInFlight \/ CallbackPublishes
    \/ SaveBegins \/ SaveAborts \/ SaveCommits \/ RevokeTakesNext
    \/ ForgetClearsPrepared \/ ForgetCountsDiscard \/ ForgetClearsInFlight
    \/ DiscardReleasesLock
    \/ AnalysisSetsBusy \/ AnalysisLoadsPending \/ AnalysisLoadsInFlight
    \/ AnalysisYields \/ AnalysisDecodes \/ AnalysisReleases

Spec == Init /\ [][Next]_vars

\* Thread locals that are written before every read are dead elsewhere;
\* TLC counts states that differ only in dead locals as one.
LiveExp(s) == IF hpc[s] \in {"se", "d5", "d5c", "d6", "d7"} THEN hexp[s] ELSE 0
LiveDisc(s) == IF hpc[s] \in {"d3", "d4", "d5", "d6", "d7", "d8", "d9"} THEN hdisc[s] ELSE 0
Live == <<cur, fin, nxt, xfade, chan, req, fence, prepared, pending, inflight,
          expected, discards, busy, obsCur, obsFin, lock, cb,
          cb \in {"c3", "c4"} /\ cbDone, fz, saves, revokes, hpc,
          [s \in S |-> LiveExp(s)], [s \in S |-> LiveDisc(s)], rlock, presses,
          apc, stale, sentDuringDecode>>

----------------------------------------------------------------------------
\* Rules

\* The track is about to change or has ended: the next callback that runs
\* publish_next_state clears both flags.
Resolved == fin \/ cur /= expected \/ xfade

\* A press past both flag checks, or its wait thread: it will store PENDING,
\* send, or give up only when PENDING is already false.
Owner == \E s \in S : hpc[s] \notin {"idle", "lp", "li"}

\* A discard in progress that will clear IN_FLIGHT.
Forgetting == fz \in {"f1", "f2", "f3"}

\* A sent Next is on its way to the engine, accepted by it, or resolved, or a
\* press that owns the button will send again.
\* Broken: Next does nothing until the track ends by itself (#154).
SentNextNotStuck ==
    inflight => (chan /= <<>> \/ req \/ Resolved \/ Forgetting \/ Owner)

\* An accepted press still has a thread that will send it, or is resolved.
\* Broken: the press is silently lost and every later press is Ignored.
PressNotLost == pending => (Owner \/ Resolved)

\* The engine accepts a Next only while the track it was pressed on is
\* current. Broken: one press skips a track the listener never skipped.
OneTrackPerPress == ~stale

\* No Next is sent while the analysis decodes a file.
\* Broken: the manual transition plan and the decode compete for the CPU.
NoSendDuringDecode == ~sentDuringDecode

=============================================================================
