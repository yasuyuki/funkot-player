---------------------------- MODULE TransportPhase ----------------------------
(* The transport phase (#161): every store to PHASE in src-tauri/src/lib.rs,
   by start_impl, audio_thread (setup and watchdog), the cpal audio callback
   in open_output_stream, and the pause/play commands (toggle_pause and the
   0 | 4 | 5 arm of onNativeControl, through flip_paused, set_paused and
   record_pause_change).

   Each action is one atomic load, store or swap, or one section under the
   render mutex. Each trailing comment "lib.rs:FN | FRAGMENT" binds the
   action to text that must appear in function FN; check_transport_phase.py
   rejects the model when the fragment is missing.

   Abstractions. The output device and the audio content are free choices:
   any callback may hear silence, end the engine, or find a long silence.
   AUDITION_LOCK lets at most one pause/play command run at a time; audition
   itself, skip, persistence and the UI poll are outside this model.

   PauseWrite chooses how record_pause_change writes Paused:
     "current" the code today: load the phase, then store Paused unless it
               was Disconnected (two steps);
     "checked" the same two steps, also skipping Failed;
     "atomic"  one compare-exchange that never replaces Disconnected or
               Failed. *)

EXTENDS Naturals

CONSTANTS PauseWrite, MaxPresses, MaxLosses

VARIABLES
    phase,       \* PHASE as the UI and the notification read it
    paused,      \* Playback::paused (initial_paused until the engine exists)
    finished,    \* Engine::is_finished of the main engine
    playbackSet, \* PLAYBACK.get().is_some()
    stream,      \* audio_thread's `stream` is Some
    deviceUp,    \* the output device is calling the audio callback
    losses,      \* output device losses so far (bound)
    heard,       \* StallWatch::started
    spc,         \* start_impl progress
    tpc,         \* audio_thread progress
    cpc,         \* audio callback progress (holds the render mutex unless "idle")
    cbPhase,     \* the phase the callback will store
    kpc,         \* pause/play command progress
    kDesired,    \* set_paused's `desired`
    presses      \* pause/play presses so far (bound)

vars == <<phase, paused, finished, playbackSet, stream, deviceUp, losses, heard,
          spc, tpc, cpc, cbPhase, kpc, kDesired, presses>>

Phases == {"idle", "starting", "playing", "paused", "stalled", "failed", "disconnected"}
ThreadAlive == {"setup", "opening", "loop", "reopen", "dropping"}

TypeOK ==
    /\ phase \in Phases /\ cbPhase \in Phases
    /\ paused \in BOOLEAN /\ finished \in BOOLEAN /\ playbackSet \in BOOLEAN
    /\ stream \in BOOLEAN /\ deviceUp \in BOOLEAN /\ heard \in BOOLEAN
    /\ losses \in 0..MaxLosses /\ presses \in 0..MaxPresses
    /\ spc \in {"idle", "phased", "spawned", "spawnFailed"}
    /\ tpc \in {"none", "dead"} \cup ThreadAlive
    /\ cpc \in {"idle", "finishing", "writing"}
    /\ kpc \in {"idle", "t_resume", "t_xor", "s_resume", "s_swap", "check", "write"}
    /\ kDesired \in BOOLEAN

Init ==
    /\ phase = "idle"
    /\ paused \in BOOLEAN                \* lib.rs:start_impl | initial_paused: bool,
    /\ finished = FALSE /\ playbackSet = FALSE /\ stream = FALSE
    /\ deviceUp = TRUE /\ losses = 0 /\ heard = FALSE
    /\ spc = "idle" /\ tpc = "none" /\ cpc = "idle" /\ cbPhase = "idle"
    /\ kpc = "idle" /\ kDesired = FALSE /\ presses = 0

----------------------------------------------------------------------------
\* start_impl

StartPublishesStarting ==
    /\ spc = "idle"
    /\ phase' = "starting"               \* lib.rs:start_impl | set_phase(Phase::Starting);
    /\ spc' = "phased"
    /\ UNCHANGED <<paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   tpc, cpc, cbPhase, kpc, kDesired, presses>>

StartSpawnsAudioThread ==
    /\ spc = "phased"
    /\ spc' = "spawned" /\ tpc' = "setup" \* lib.rs:start_impl | .name("funkot-audio".into())
    /\ UNCHANGED <<phase, paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   cpc, cbPhase, kpc, kDesired, presses>>

StartSpawnFails ==
    /\ spc = "phased"
    /\ phase' = "idle"                   \* lib.rs:start_impl | set_phase(Phase::Idle);
    /\ spc' = "spawnFailed"
    /\ UNCHANGED <<paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   tpc, cpc, cbPhase, kpc, kDesired, presses>>

----------------------------------------------------------------------------
\* audio_thread: setup, first open, and the once-a-second watchdog loop

\* No device, no default config, a non-stereo device, Engine::new_with_source
\* or the navigation capture preflight fails, all before PLAYBACK is set.
SetupFails ==
    /\ tpc = "setup"
    /\ phase' = "failed"                 \* lib.rs:audio_thread | say!("FAIL: no default output device");
                                         \* lib.rs:audio_thread | say!("FAIL: default_output_config: {e}");
                                         \* lib.rs:audio_thread | say!("FAIL: engine renders interleaved stereo; device wants {} ch", supported.channels());
                                         \* lib.rs:audio_thread | say!("FAIL: Engine::new_with_source: {e}");
                                         \* lib.rs:audio_thread | say!("FAIL: navigation capture preflight: {error}");
    /\ tpc' = "dead"
    /\ UNCHANGED <<paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, cpc, cbPhase, kpc, kDesired, presses>>

EnginePublished ==
    /\ tpc = "setup"
    /\ playbackSet' = TRUE               \* lib.rs:audio_thread | let _ = PLAYBACK.set(Playback {
    /\ tpc' = "opening"
    /\ UNCHANGED <<phase, paused, finished, stream, deviceUp, losses, heard,
                   spc, cpc, cbPhase, kpc, kDesired, presses>>

FirstOpenSucceeds ==
    /\ tpc = "opening" /\ deviceUp
    /\ stream' = TRUE                    \* lib.rs:audio_thread | Ok(s) => Some(s),
    /\ tpc' = "loop"
    /\ UNCHANGED <<phase, paused, finished, playbackSet, deviceUp, losses, heard,
                   spc, cpc, cbPhase, kpc, kDesired, presses>>

\* PLAYBACK is already set: pause/play commands still reach `paused`.
FirstOpenFails ==
    /\ tpc = "opening"
    /\ phase' = "failed"                 \* lib.rs:audio_thread | say!("FAIL: {e}");
    /\ tpc' = "dead"
    /\ UNCHANGED <<paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, cpc, cbPhase, kpc, kDesired, presses>>

WatchdogSeesNoStream ==
    /\ tpc = "loop" /\ ~stream
    /\ phase' = "disconnected"           \* lib.rs:audio_thread | if stream.is_none() {
    /\ tpc' = "reopen"
    /\ UNCHANGED <<paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, cpc, cbPhase, kpc, kDesired, presses>>

ReopenSucceeds ==
    /\ tpc = "reopen" /\ deviceUp
    /\ stream' = TRUE                    \* lib.rs:audio_thread | say!("output device reopened");
    /\ tpc' = "loop"
    /\ UNCHANGED <<phase, paused, finished, playbackSet, deviceUp, losses, heard,
                   spc, cpc, cbPhase, kpc, kDesired, presses>>

ReopenFails ==
    /\ tpc = "reopen"
    /\ tpc' = "loop"                     \* lib.rs:audio_thread | retry_after = Some(Instant::now() + REOPEN_COOLDOWN);
    /\ UNCHANGED <<phase, paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, cpc, cbPhase, kpc, kDesired, presses>>

\* CallbackWatch finds the callback stuck, or the stream error callback ran.
WatchdogLosesStream ==
    /\ tpc = "loop" /\ stream
    /\ phase' = "disconnected"           \* lib.rs:audio_thread | if lost {
    /\ tpc' = "dropping"
    /\ UNCHANGED <<paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, cpc, cbPhase, kpc, kDesired, presses>>

\* Dropping the stream joins cpal's worker, so a callback in flight ends first.
WatchdogDropsStream ==
    /\ tpc = "dropping" /\ cpc = "idle"
    /\ stream' = FALSE                   \* lib.rs:audio_thread | drop(stream.take());
    /\ tpc' = "loop"
    /\ UNCHANGED <<phase, paused, finished, playbackSet, deviceUp, losses, heard,
                   spc, cpc, cbPhase, kpc, kDesired, presses>>

----------------------------------------------------------------------------
\* The output device

DeviceLost ==
    /\ deviceUp /\ losses < MaxLosses
    /\ deviceUp' = FALSE /\ losses' = losses + 1
    /\ UNCHANGED <<phase, paused, finished, playbackSet, stream, heard,
                   spc, tpc, cpc, cbPhase, kpc, kDesired, presses>>

DeviceBack ==
    /\ ~deviceUp
    /\ deviceUp' = TRUE
    /\ UNCHANGED <<phase, paused, finished, playbackSet, stream, losses, heard,
                   spc, tpc, cpc, cbPhase, kpc, kDesired, presses>>

----------------------------------------------------------------------------
\* The audio callback in open_output_stream. It holds the render mutex from
\* try_lock to its end; it reads `paused` at the start and stores the phase
\* at the end.

CallbackRenders ==
    /\ cpc = "idle" /\ stream /\ deviceUp
    /\ \E ends, silent, long \in BOOLEAN :
         IF paused                       \* lib.rs:open_output_stream | let requested_pause = paused.load(Ordering::Relaxed);
         THEN /\ cbPhase' = "paused"     \* lib.rs:open_output_stream | } else if requested_pause {
              /\ cpc' = "writing"
              /\ UNCHANGED <<finished, heard>>
         ELSE /\ finished' = (finished \/ ends)
              /\ IF finished'            \* lib.rs:open_output_stream | let phase = if !audition && state.engine.is_finished() {
                 THEN /\ cbPhase' = "paused" /\ cpc' = "finishing"
                      /\ UNCHANGED heard
                 ELSE /\ cpc' = "writing"  \* lib.rs:observe | fn observe(&mut self, frames: u64, silent: bool) -> Phase {
                      /\ heard' = (heard \/ ~silent)
                      /\ cbPhase' = IF ~silent THEN "playing"
                                    ELSE IF ~heard THEN "starting"
                                    ELSE IF long THEN "stalled" ELSE "playing"
    /\ UNCHANGED <<phase, paused, playbackSet, stream, deviceUp, losses,
                   spc, tpc, kpc, kDesired, presses>>

CallbackPausesFinished ==
    /\ cpc = "finishing"
    /\ paused' = TRUE                    \* lib.rs:open_output_stream | paused.store(true, Ordering::Relaxed);
    /\ cpc' = "writing"
    /\ UNCHANGED <<phase, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, tpc, cbPhase, kpc, kDesired, presses>>

CallbackStoresPhase ==
    /\ cpc = "writing"
    /\ phase' = cbPhase                  \* lib.rs:open_output_stream | set_phase(phase);
                                         \* lib.rs:open_output_stream | set_phase(Phase::Paused);
    /\ cpc' = "idle"
    /\ UNCHANGED <<paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, tpc, cbPhase, kpc, kDesired, presses>>

----------------------------------------------------------------------------
\* Pause and play: toggle_pause / onNativeControl action 0 (flip_paused) and
\* onNativeControl actions 4 and 5 (set_paused). Each needs PLAYBACK.

CanPress == kpc = "idle" /\ playbackSet /\ presses < MaxPresses

PressToggle ==
    /\ CanPress
    /\ presses' = presses + 1
    /\ kpc' = IF paused THEN "t_resume" ELSE "t_xor"  \* lib.rs:flip_paused | if paused.load(Ordering::Relaxed) {
    /\ UNCHANGED <<phase, paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, tpc, cpc, cbPhase, kDesired>>

ToggleResumesEngine ==
    /\ kpc = "t_resume" /\ cpc = "idle"
    /\ finished' = FALSE                 \* lib.rs:resume_finished_engine | if render.engine.is_finished() { render.engine.resume(); }
    /\ kpc' = "t_xor"
    /\ UNCHANGED <<phase, paused, playbackSet, stream, deviceUp, losses, heard,
                   spc, tpc, cpc, cbPhase, kDesired, presses>>

ToggleFlips ==
    /\ kpc = "t_xor"
    /\ paused' = ~paused                 \* lib.rs:flip_paused | let now_paused = !paused.fetch_xor(true, Ordering::Relaxed);
    /\ kpc' = IF paused' THEN "check" ELSE "idle"
    /\ UNCHANGED <<phase, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, tpc, cpc, cbPhase, kDesired, presses>>

PressSet(d) ==
    /\ CanPress
    /\ presses' = presses + 1 /\ kDesired' = d
    /\ kpc' = IF paused = d THEN "idle"  \* lib.rs:set_paused | if prior == desired {
              ELSE IF paused THEN "s_resume" ELSE "s_swap"
    /\ UNCHANGED <<phase, paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, tpc, cpc, cbPhase>>

SetResumesEngine ==
    /\ kpc = "s_resume" /\ cpc = "idle"
    /\ finished' = FALSE                 \* lib.rs:set_paused | resume_finished_engine_before_play();
    /\ kpc' = "s_swap"
    /\ UNCHANGED <<phase, paused, playbackSet, stream, deviceUp, losses, heard,
                   spc, tpc, cpc, cbPhase, kDesired, presses>>

SetSwaps ==
    /\ kpc = "s_swap"
    /\ paused' = kDesired                \* lib.rs:set_paused | let previous = paused.swap(desired, Ordering::Relaxed);
    /\ kpc' = IF paused = kDesired \/ ~kDesired THEN "idle" ELSE "check"
    /\ UNCHANGED <<phase, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, tpc, cpc, cbPhase, kDesired, presses>>

\* record_pause_change(paused, true)
Keep == IF PauseWrite = "current" THEN {"disconnected"} ELSE {"disconnected", "failed"}

PauseReadsPhase ==
    /\ kpc = "check"
    /\ IF PauseWrite = "atomic"
       THEN /\ phase' = IF phase \in Keep THEN phase ELSE "paused"
            /\ kpc' = "idle"
       ELSE /\ kpc' = IF phase \in Keep THEN "idle" ELSE "write"  \* lib.rs:record_pause_change | if now_paused && get_phase() != Phase::Disconnected {
            /\ UNCHANGED phase
    /\ UNCHANGED <<paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, tpc, cpc, cbPhase, kDesired, presses>>

PauseStoresPaused ==
    /\ kpc = "write"
    /\ phase' = "paused"                 \* lib.rs:record_pause_change | set_phase(Phase::Paused);
    /\ kpc' = "idle"
    /\ UNCHANGED <<paused, finished, playbackSet, stream, deviceUp, losses, heard,
                   spc, tpc, cpc, cbPhase, kDesired, presses>>

----------------------------------------------------------------------------

\* The audio thread has returned or never started, and nothing else moves.
Done ==
    /\ tpc = "dead" \/ spc = "spawnFailed"
    /\ kpc = "idle"
    /\ UNCHANGED vars

Next ==
    \/ StartPublishesStarting \/ StartSpawnsAudioThread \/ StartSpawnFails
    \/ SetupFails \/ EnginePublished \/ FirstOpenSucceeds \/ FirstOpenFails
    \/ WatchdogSeesNoStream \/ ReopenSucceeds \/ ReopenFails
    \/ WatchdogLosesStream \/ WatchdogDropsStream
    \/ DeviceLost \/ DeviceBack
    \/ CallbackRenders \/ CallbackPausesFinished \/ CallbackStoresPhase
    \/ PressToggle \/ ToggleResumesEngine \/ ToggleFlips
    \/ PressSet(TRUE) \/ PressSet(FALSE) \/ SetResumesEngine \/ SetSwaps
    \/ PauseReadsPhase \/ PauseStoresPaused
    \/ Done

Spec == Init /\ [][Next]_vars

----------------------------------------------------------------------------
\* Rules

\* playback_session_alive, which Kotlin's playbackAlive asks.
SessionAlive ==
    CASE phase \in {"idle", "failed"} -> FALSE  \* lib.rs:playback_session_alive | Phase::Idle | Phase::Failed => false,
      [] phase = "starting" -> TRUE             \* lib.rs:playback_session_alive | Phase::Starting => true,
      [] OTHER -> playbackSet                   \* lib.rs:playback_session_alive | _ => has_playback,

\* start_impl has published Starting and the audio thread is about to run,
\* or the audio thread is running.
AudioThreadAlive == spc = "phased" \/ tpc \in ThreadAlive

\* Once the audio thread gives up, the screen keeps showing that it failed.
FailedStaysFailed == tpc = "dead" => phase = "failed"

\* The notification treats playback as alive exactly while the audio thread is.
AliveMatchesAudioThread == SessionAlive <=> AudioThreadAlive

=============================================================================
