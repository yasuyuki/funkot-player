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

Listen(r) ==
    /\ pc[r] \in {"idle", "done", "failed"}
    /\ Serialize => ~LockHeld           \* lib.rs:3226
    /\ preparing' = TRUE                \* lib.rs:3257
    /\ before' = [before EXCEPT ![r] = paused]  \* lib.rs:3258
    /\ paused' = TRUE                   \* lib.rs:3258
    /\ pc' = [pc EXCEPT ![r] = "building"]
    /\ UNCHANGED <<auditioning, installed, wantMain, rpc, tpc>>

PrepareFails(r) ==
    /\ pc[r] = "building"
    /\ paused' = IF RestoreOnFailure THEN before[r] ELSE FALSE  \* lib.rs:3261
    /\ preparing' = FALSE               \* lib.rs:3263
    /\ pc' = [pc EXCEPT ![r] = "failed"]
    /\ UNCHANGED <<auditioning, installed, wantMain, before, rpc, tpc>>

RaiseAuditioning(r) ==
    /\ pc[r] = "building"
    /\ auditioning' = TRUE              \* lib.rs:3191
    /\ pc' = [pc EXCEPT ![r] = "flagged"]
    /\ UNCHANGED <<paused, preparing, installed, wantMain, before, rpc, tpc>>

SwapInAudition(r) ==
    /\ pc[r] = "flagged"
    /\ installed' = r                   \* lib.rs:3198-3199
    /\ pc' = [pc EXCEPT ![r] = "swapped"]
    /\ UNCHANGED <<paused, auditioning, preparing, wantMain, before, rpc, tpc>>

UnmuteAudition(r) ==
    /\ pc[r] = "swapped"
    /\ paused' = FALSE                  \* lib.rs:3205
    /\ pc' = [pc EXCEPT ![r] = "unmuted"]
    /\ UNCHANGED <<auditioning, preparing, installed, wantMain, before, rpc, tpc>>

EndPreparing(r) ==
    /\ pc[r] = "unmuted"
    /\ preparing' = FALSE               \* lib.rs:3263
    /\ pc' = [pc EXCEPT ![r] = "done"]
    /\ UNCHANGED <<paused, auditioning, installed, wantMain, before, rpc, tpc>>

PressResume ==
    /\ rpc = "idle"
    /\ BannerShown                      \* App.svelte:131
    /\ IF Serialize THEN ~LockHeld      \* lib.rs:3269
                    ELSE ~preparing     \* the pre-#115 AUDITION_PREPARING guard
    /\ rpc' = "checked"
    /\ UNCHANGED <<paused, auditioning, preparing, installed, wantMain, before, pc, tpc>>

ResumeMutes ==
    /\ rpc = "checked"
    /\ paused' = TRUE                   \* lib.rs:3271
    /\ rpc' = "muted"
    /\ UNCHANGED <<auditioning, preparing, installed, wantMain, before, pc, tpc>>

ResumeClearsAuditioning ==
    /\ rpc = "muted"
    /\ auditioning' = FALSE             \* lib.rs:3274
    /\ rpc' = "restored"
    /\ UNCHANGED <<paused, preparing, installed, wantMain, before, pc, tpc>>

ResumeTakesAudition ==
    /\ rpc = "restored"
    /\ installed' = 0                   \* lib.rs:3289
    /\ rpc' = "taken"
    /\ UNCHANGED <<paused, auditioning, preparing, wantMain, before, pc, tpc>>

ResumeUnmutes ==
    /\ rpc = "taken"
    /\ paused' = FALSE                  \* lib.rs:3296
    /\ wantMain' = TRUE                 \* lib.rs:3301
    /\ rpc' = "idle"
    /\ UNCHANGED <<auditioning, preparing, installed, before, pc, tpc>>

PressPause ==
    /\ tpc = "idle"
    /\ ~BannerShown                     \* transportMode.ts:18
    /\ Serialize => ~LockHeld           \* lib.rs:3346
    /\ ~auditioning /\ ~preparing       \* lib.rs:3347-3350
    /\ tpc' = "checked"
    /\ UNCHANGED <<paused, auditioning, preparing, installed, wantMain, before, pc, rpc>>

PauseFlips ==
    /\ tpc = "checked"
    /\ paused' = ~paused                \* lib.rs:213
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

QuietWhilePreparing == Building => ~MainAudible

QueueFollowsListener == (Settled /\ installed = 0) => (MainAudible = wantMain)

BannerMatchesAudition == Settled => (auditioning = (installed # 0))

=============================================================================
