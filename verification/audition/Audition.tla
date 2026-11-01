---------------------------- MODULE Audition ----------------------------
(* Transition audition (#115): two audition_transition requests, the
   〔再開〕 banner (resume_autodj) and the in-app pause button (toggle_pause),
   all in src-tauri/src/lib.rs. Each action is one store or one locked
   section in the code; the comment on each conjunct names its line.
   The main engine already exists. A cold start reaches the same state as a
   queue that the listener has not asked to play (start_impl initial_paused).
   Display parking in AuditionSession, stale audition events, Android notification
   transport, skip and output-device loss are outside this model.
   Serialize = FALSE removes AUDITION_LOCK and restores the pre-#115 guards.
   RestoreOnFailure = FALSE restores the pre-#115 blanket unmute on failure. *)

CONSTANTS Serialize, RestoreOnFailure

Req == {1, 2}

VARIABLES
    paused,      \* Playback::paused, the one flag the audio callback reads
    auditioning, \* AUDITIONING
    preparing,   \* AUDITION_PREPARING
    installed,   \* RenderState::audition: 0 = none, r = engine built by request r
    wantMain,    \* ghost: the listener's own choice that the queue plays
    before,      \* prepare_audition's `before` for each request
    pc,          \* progress of each audition_transition call
    rpc,         \* progress of the resume_autodj call
    tpc          \* progress of the toggle_pause call

vars == <<paused, auditioning, preparing, installed, wantMain, before, pc, rpc, tpc>>

Running == {"building", "flagged", "swapped", "unmuted"}

TypeOK ==
    /\ paused \in BOOLEAN /\ auditioning \in BOOLEAN /\ preparing \in BOOLEAN
    /\ installed \in {0} \cup Req /\ wantMain \in BOOLEAN
    /\ before \in [Req -> BOOLEAN]
    /\ pc \in [Req -> {"idle", "done", "failed"} \cup Running]
    /\ rpc \in {"idle", "checked", "muted", "restored", "taken"}
    /\ tpc \in {"idle", "checked"}

Init ==
    /\ paused \in BOOLEAN
    /\ wantMain = ~paused
    /\ auditioning = FALSE /\ preparing = FALSE /\ installed = 0
    /\ before = [r \in Req |-> FALSE]
    /\ pc = [r \in Req |-> "idle"]
    /\ rpc = "idle" /\ tpc = "idle"

\* AUDITION_LOCK is held from command entry until the command returns.
LockHeld == (\E r \in Req : pc[r] \in Running) \/ rpc # "idle" \/ tpc # "idle"

MainAudible == installed = 0 /\ ~paused
BannerShown == auditioning \/ preparing
Building == \E r \in Req : pc[r] = "building"

\* ---- audition_transition(r) and prepare_audition ----
Listen(r) ==
    /\ pc[r] \in {"idle", "done", "failed"}
    /\ Serialize => ~LockHeld           \* lib.rs:4247
    /\ preparing' = TRUE                \* lib.rs:4294
    /\ before' = [before EXCEPT ![r] = paused]  \* lib.rs:4295
    /\ paused' = TRUE                   \* lib.rs:4295
    /\ pc' = [pc EXCEPT ![r] = "building"]
    /\ UNCHANGED <<auditioning, installed, wantMain, rpc, tpc>>

PrepareFails(r) ==
    /\ pc[r] = "building"
    /\ paused' = IF RestoreOnFailure THEN before[r] ELSE FALSE  \* lib.rs:4298
    /\ preparing' = FALSE               \* lib.rs:4300
    /\ pc' = [pc EXCEPT ![r] = "failed"]
    /\ UNCHANGED <<auditioning, installed, wantMain, before, rpc, tpc>>

RaiseAuditioning(r) ==
    /\ pc[r] = "building"
    /\ auditioning' = TRUE              \* lib.rs:4210
    /\ pc' = [pc EXCEPT ![r] = "flagged"]
    /\ UNCHANGED <<paused, preparing, installed, wantMain, before, rpc, tpc>>

SwapInAudition(r) ==
    /\ pc[r] = "flagged"
    /\ installed' = r                   \* lib.rs:4219-4220
    /\ pc' = [pc EXCEPT ![r] = "swapped"]
    /\ UNCHANGED <<paused, auditioning, preparing, wantMain, before, rpc, tpc>>

UnmuteAudition(r) ==
    /\ pc[r] = "swapped"
    /\ paused' = FALSE                  \* lib.rs:4226
    /\ pc' = [pc EXCEPT ![r] = "unmuted"]
    /\ UNCHANGED <<auditioning, preparing, installed, wantMain, before, rpc, tpc>>

EndPreparing(r) ==
    /\ pc[r] = "unmuted"
    /\ preparing' = FALSE               \* lib.rs:4300
    /\ pc' = [pc EXCEPT ![r] = "done"]
    /\ UNCHANGED <<paused, auditioning, installed, wantMain, before, rpc, tpc>>

\* ---- resume_autodj ----
PressResume ==
    /\ rpc = "idle"
    /\ BannerShown                      \* App.svelte:170
    /\ IF Serialize THEN ~LockHeld      \* lib.rs:4307
                    ELSE ~preparing     \* the pre-#115 AUDITION_PREPARING guard
    /\ rpc' = "checked"
    /\ UNCHANGED <<paused, auditioning, preparing, installed, wantMain, before, pc, tpc>>

ResumeMutes ==
    /\ rpc = "checked"
    /\ paused' = TRUE                   \* lib.rs:4312
    /\ rpc' = "muted"
    /\ UNCHANGED <<auditioning, preparing, installed, wantMain, before, pc, tpc>>

ResumeClearsAuditioning ==
    /\ rpc = "muted"
    /\ auditioning' = FALSE             \* lib.rs:4319
    /\ rpc' = "restored"
    /\ UNCHANGED <<paused, preparing, installed, wantMain, before, pc, tpc>>

ResumeTakesAudition ==
    /\ rpc = "restored"
    /\ installed' = 0                   \* lib.rs:4335
    /\ rpc' = "taken"
    /\ UNCHANGED <<paused, auditioning, preparing, wantMain, before, pc, tpc>>

ResumeUnmutes ==
    /\ rpc = "taken"
    /\ paused' = FALSE                  \* lib.rs:4348
    /\ wantMain' = TRUE                 \* lib.rs:4360
    /\ rpc' = "idle"
    /\ UNCHANGED <<auditioning, preparing, installed, before, pc, tpc>>

\* ---- toggle_pause ----
PressPause ==
    /\ tpc = "idle"
    /\ ~BannerShown                     \* transportMode.ts:51
    /\ Serialize => ~LockHeld           \* lib.rs:4407
    /\ ~auditioning /\ ~preparing       \* lib.rs:4408-4411
    /\ tpc' = "checked"
    /\ UNCHANGED <<paused, auditioning, preparing, installed, wantMain, before, pc, rpc>>

PauseFlips ==
    /\ tpc = "checked"
    /\ paused' = ~paused                \* lib.rs:317
    /\ wantMain' = paused
    /\ tpc' = "idle"
    /\ UNCHANGED <<auditioning, preparing, installed, before, pc, rpc>>

Reader == (\E r \in Req : Listen(r)) \/ PressResume \/ PressPause

System ==
    \/ \E r \in Req : PrepareFails(r)
    \/ \E r \in Req : RaiseAuditioning(r)
    \/ \E r \in Req : SwapInAudition(r)
    \/ \E r \in Req : UnmuteAudition(r)
    \/ \E r \in Req : EndPreparing(r)
    \/ ResumeMutes \/ ResumeClearsAuditioning \/ ResumeTakesAudition \/ ResumeUnmutes
    \/ PauseFlips

Next == Reader \/ System

Spec == Init /\ [][Next]_vars

Settled == ~ENABLED System

\* While an audition is being prepared, the queue's music stays silent.
QuietWhilePreparing == Building => ~MainAudible

\* Once everything settles with no audition playing, the queue plays exactly
\* when the listener chose to play it.
QueueFollowsListener == (Settled /\ installed = 0) => (MainAudible = wantMain)

\* Once everything settles, the audition banner is shown exactly while an
\* audition engine is in place.
BannerMatchesAudition == Settled => (auditioning = (installed # 0))

=============================================================================
