-------------------------- MODULE SourceSwitch --------------------------
EXTENDS Naturals, Integers, Sequences, FiniteSets, TLC

CONSTANTS CheckEpoch, UseFence, CommitOnFailure, None

(* Two initial occurrence identities per source, one fresh normal identity,
   two transaction attempts,
   one delayed loader per process, and one crash/restart. The initial audible
   occurrence may belong to either source, independently of selected future.
   The second occurrence makes Remove/Move and same-path identity observable.
   IDs are opaque and all normal items have the same queue priority. A source
   choice while Service.restored still names a saved normal current creates
   FreshNormal; an already admitted restoring claim keeps its identity when
   requeued. Active-normal startup normalization instead queues the exact
   saved ID and clears restored. At most two normal items coexist. The single
   crash and two attempts need only one fresh live name. Failed candidates do
   not expose their allocated name, so they may reuse this representative.
   Init describes modern runtime snapshots whose started normal current has
   retired from queue/session. Imported current/session overlap remains a
   native recovery boundary; fresh requeue still removes that exact old ID.

   This is a bounded protocol model, not imported Rust. verification/README.md
   records the production mapping and excluded behavior. Progress persistence
   succeeds here; transaction and startup normalization persistence can fail.
   Restart first creates an unloaded service with an empty live queue and
   process session. Preload normalizes durably; Start normalizes again before
   configuring the engine. A failed normalization leaves state unchanged.
   Offline commands fold canonical durable work into their private candidate,
   clear its old session, and publish only after save. Unchanged ON remains a
   settings-only save. Session here denotes ordered in_flight identities;
   paused/settings preservation stays with native tests. Both admission paths
   capture a valid restored current before saving. The source-published/control-missing busy window stays
   with the native tests, rather than being another modeled thread state.
   File replacement is an old/new atomicity assumption, tested by native child
   process tests. No fairness or liveness is claimed. Integers never wrap.
   A source of any epoch created in this process may call next late; entry and
   post-delay checks reject it. Old workers disappear on process death, so
   reset epochs introduce no ABA. Claim registration precedes slow admission;
   final admission validates the same live, uncancelled claim and never
   reinserts it. The one load index is never reused within the process.
   No VIEW, symmetry quotient, state constraint, or depth cutoff is used. *)

Sources == {"normal", "playlist"}
Ids == {1, 2}
FreshNormal == 3
NormalIds == Ids \cup {FreshNormal}
Requests == {1, 2}
Ops == {"Switch", "Move", "Remove", "Restart", "Off", "On"}
RequestOps == {"Switch", "Move", "Remove", "Restart"}
InputIds(op) == IF op \in {"Move", "Remove"} THEN NormalIds ELSE {None}
Fingerprint(op, id, target) ==
    [action |-> op, entry |-> IF op \in {"Move", "Remove"} THEN id ELSE None,
     target |-> target]
Identity(src, id, run) == [source |-> src, id |-> id, run |-> run]
Elems(q) == {q[i] : i \in DOMAIN q}
Without(q, ids) == SelectSeq(q, LAMBDA id: id \notin ids)
Prefix(a, b) == Len(a) <= Len(b) /\ a = SubSeq(b, 1, Len(a))
Unique(q) == Cardinality(Elems(q)) = Len(q)
Swap(q) == IF Len(q) = 2 THEN <<q[2], q[1]>> ELSE q
AppendUnique(q, id) == IF id \in Elems(q) THEN q ELSE Append(q, id)
RestoreQueue(session, queue) == session \o Without(queue, Elems(session))
Target(st) == [active |-> st.active, generation |-> st.generation,
               revision |-> st.revision]
Remaining(st) == Without(st.playlist, st.played)
Member(c, st) == c # None /\
    (c.source = "normal" \/ (c.run = st.run /\ c.id \in Elems(st.playlist)))

VARIABLES s, requestAudit, startupAudit
vars == <<s, requestAudit, startupAudit>>

EmptyLoader == [stage |-> "empty", item |-> None, epoch |-> 0,
                generation |-> 0, restoring |-> FALSE]
EmptyTx == [request |-> 0, op |-> "", fingerprint |-> None,
            candidate |-> None, oldDisk |-> None, oldLive |-> None,
            replace |-> FALSE, renamed |-> FALSE, owner |-> -1,
            epoch |-> 0, generation |-> 0, interruptedNormal |-> None,
            normalBefore |-> <<>>, sessionUpdated |-> FALSE, publishQueue |-> FALSE,
            restoredBefore |-> None]

Init == \E active \in Sources, audible \in {None} \cup Sources:
    LET current == IF audible = None THEN None ELSE Identity(audible, 1, 0)
        st == [active |-> active,
               normal |-> IF audible = "normal" THEN <<2>> ELSE <<1, 2>>,
               normalResume |-> IF audible = "normal" THEN <<2>> ELSE <<1, 2>>,
               playlist |-> <<1, 2>>,
               played |-> IF audible = "playlist" THEN {1} ELSE {},
               current |-> current, run |-> 0, revision |-> 0,
               generation |-> 0, session |-> <<>>, allow |-> TRUE]
    IN s = [up |-> TRUE, incarnation |-> 0, attempts |-> 0,
            loaded |-> TRUE, configured |-> TRUE,
            live |-> st, disk |-> st, fileRevision |-> 0,
            epoch |-> 0, engineGeneration |-> 0,
            sourceGenerations |-> [e \in {0} |-> 0],
            owner |-> IF current = None THEN -1 ELSE 0,
            core |-> IF current = None THEN -1 ELSE 0,
            ended |-> FALSE, observed |-> FALSE, eventSeen |-> FALSE,
            claim |-> None, cancelled |-> FALSE, retired |-> FALSE,
            loader |-> EmptyLoader, reserved |-> None,
            restored |-> None, ready |-> FALSE, event |-> FALSE,
            fence |-> FALSE, phase |-> "idle", tx |-> EmptyTx,
            receipts |-> [r \in Requests |-> None],
            applications |-> [r \in Requests |-> 0],
            admission |-> None, selection |-> None, recovery |-> None, replay |-> None,
            rejected |-> FALSE] /\ requestAudit = None /\ startupAudit = None

Idle == s.up /\ s.phase = "idle"
CurrentMatches == s.owner = (IF s.ended THEN -1 ELSE s.core)

(* HostSource::next/on_reserved persist exact SESSION identity, but neither
   reservation nor local preclaim consumes queue/catalog membership. There is
   one deliberately delayed next() per process. Already audible current is
   independent, and its render/end can interleave with every command phase. *)
NextItem ==
    IF s.restored # None THEN s.restored
    ELSE IF s.live.active = "normal" THEN
        IF s.live.normal = <<>> THEN None
        ELSE Identity("normal", Head(s.live.normal), 0)
    ELSE IF Remaining(s.live) = <<>> THEN None
    ELSE Identity("playlist", Head(Remaining(s.live)), s.live.run)

Reserve(sourceEpoch) ==
    /\ Idle /\ s.loaded /\ s.configured
    /\ s.loader.stage = "empty" /\ NextItem # None
    /\ (~CheckEpoch \/ sourceEpoch = s.epoch)
    /\ LET c == NextItem
           normal == c.source = "normal" /\ s.restored = None
           st == IF normal THEN
                    [s.live EXCEPT !.session = AppendUnique(@, c.id)]
                 ELSE IF s.restored # None THEN
                    [s.live EXCEPT !.current = c]
                 ELSE s.live
       IN s' = [s EXCEPT
            !.live = st,
            !.disk = IF normal THEN [s.disk EXCEPT !.session = st.session] ELSE @,
            !.fileRevision = @ + IF normal THEN 1 ELSE 0,
            !.reserved = IF normal THEN c.id ELSE @,
            !.claim = IF normal THEN None ELSE c,
            !.selection = IF normal THEN None ELSE
                [captured |-> sourceEpoch, observed |-> s.epoch],
            !.loader = [stage |-> IF normal THEN "reserved" ELSE "admitting",
                        item |-> c, epoch |-> sourceEpoch,
                        generation |-> s.sourceGenerations[sourceEpoch],
                        restoring |-> s.restored # None]]

Capture ==
    /\ Idle /\ s.loader.stage = "reserved"
    /\ s' = [s EXCEPT !.loader.stage =
        IF (~CheckEpoch \/ s.loader.epoch = s.epoch) /\ s.reserved = s.loader.item.id
        THEN "admitting" ELSE "dropped",
        !.claim = IF (~CheckEpoch \/ s.loader.epoch = s.epoch) /\ s.reserved = s.loader.item.id
                  THEN s.loader.item ELSE None,
        !.selection = IF (~CheckEpoch \/ s.loader.epoch = s.epoch)
                         /\ s.reserved = s.loader.item.id
                      THEN [captured |-> s.loader.epoch, observed |-> s.epoch]
                      ELSE @]

AdmissionValid ==
    LET c == s.loader.item
    IN /\ s.claim = c /\ ~s.cancelled
       /\ (~CheckEpoch \/ s.loader.epoch = s.epoch)
       /\ Member(c, s.live)
       /\ IF s.loader.restoring THEN s.restored = c
          ELSE IF c.source = "normal" THEN TRUE
          ELSE s.live.active = "playlist"

Admit ==
    /\ Idle /\ s.loader.stage = "admitting"
    /\ IF AdmissionValid THEN
          s' = [s EXCEPT !.loader.stage = "claimed",
                 !.restored = IF s.loader.restoring THEN None ELSE @,
                 !.live = [s.live EXCEPT !.normalResume = s.live.normal],
                 !.disk = [s.live EXCEPT !.normalResume = s.live.normal],
                 !.fileRevision = @ + 1,
                 !.admission = [captured |-> s.loader.epoch,
                                observed |-> s.epoch, item |-> s.loader.item,
                                restoring |-> s.loader.restoring,
                                restored |-> s.restored, reserved |-> s.reserved,
                                active |-> s.live.active,
                                member |-> Member(s.loader.item, s.live)]]
       ELSE s' = [s EXCEPT !.loader.stage = "dropped", !.claim = None]

(* Loader completion may run while the service mutex is held. Ready delivery
   belongs to a channel/source generation, independently of service epoch. *)
LoaderComplete ==
    /\ s.up /\ s.loader.stage = "claimed"
    /\ s' = [s EXCEPT !.loader.stage = "mail"]
DeliverReady ==
    /\ s.up /\ s.loader.stage = "mail"
    /\ s' = [s EXCEPT !.loader.stage = "delivered",
             !.ready = s.loader.generation = s.engineGeneration]
CoreStart ==
    /\ s.up /\ s.ready /\ ~s.fence /\ s.core # 1
    /\ s' = [s EXCEPT !.core = 1, !.ended = FALSE,
             !.ready = FALSE, !.event = TRUE]
CoreEnd ==
    /\ s.up /\ s.core # -1 /\ ~s.ended
    /\ s' = [s EXCEPT !.ended = TRUE]

Consume(st, c, becameCurrent) ==
    IF ~Member(c, st) THEN st
    ELSE IF c.source = "normal" THEN
        [st EXCEPT !.normal = Without(@, {c.id}),
                   !.normalResume = Without(st.normal, {c.id}),
                   !.session = Without(@, {c.id}),
                   !.revision = @ + IF becameCurrent THEN 1 ELSE 0]
    ELSE [st EXCEPT !.normalResume = st.normal, !.played = @ \cup {c.id},
                    !.revision = @ + IF c.id \in st.played THEN 0 ELSE 1]

ObserveEvent ==
    /\ Idle /\ s.event /\ ~s.eventSeen /\ (s.ended \/ s.observed)
    /\ LET st == IF s.cancelled THEN s.live ELSE Consume(s.live, s.claim, FALSE)
       IN s' = [s EXCEPT !.eventSeen = TRUE, !.live = st,
                !.retired = @ \/ s.owner # 1,
                !.reserved = IF s.claim # None /\ s.claim.source = "normal"
                                /\ s.reserved = s.claim.id THEN None ELSE @,
                !.disk = st, !.fileRevision = @ + 1]
ObserveCurrent ==
    /\ Idle /\ s.core = 1 /\ ~s.ended /\ ~s.observed
    /\ LET valid == ~s.cancelled /\ Member(s.claim, s.live)
           st == IF valid THEN Consume(s.live, s.claim, TRUE) ELSE s.live
           next == [st EXCEPT !.current = IF valid THEN s.claim ELSE None]
       IN s' = [s EXCEPT !.observed = TRUE, !.owner = 1, !.retired = FALSE,
                !.reserved = IF s.claim # None /\ s.claim.source = "normal"
                                /\ s.reserved = s.claim.id THEN None ELSE @,
                !.live = next, !.disk = next, !.fileRevision = @ + 1]
ObserveEnd ==
    /\ Idle /\ s.ended /\ s.owner # -1
    /\ LET st == IF s.core = 1 /\ ~s.cancelled
                 THEN Consume(s.live, s.claim, s.owner # 1) ELSE s.live
           next == [st EXCEPT !.normalResume = st.normal, !.current = None, !.revision = @ + 1]
       IN s' = [s EXCEPT !.owner = -1, !.observed = TRUE,
                !.retired = @ \/ s.core = 1,
                !.reserved = IF s.core = 1 /\ s.claim # None
                                /\ s.claim.source = "normal"
                                /\ s.reserved = s.claim.id THEN None ELSE @,
                !.live = next, !.disk = next, !.fileRevision = @ + 1]

NormalForUpdate ==
    IF s.configured THEN s.live.normal
    ELSE LET canonical == IF s.live.active = "playlist" THEN s.live.normalResume
                          ELSE RestoreQueue(s.disk.session, s.disk.normal)
         IN RestoreQueue(canonical, s.live.normal)

OpEnabled(op, id) ==
    CASE op = "Move" -> Len(IF s.live.active = "normal" THEN NormalForUpdate
                            ELSE Remaining(s.live)) = 2
                        /\ id \in Elems(IF s.live.active = "normal"
                                        THEN NormalForUpdate ELSE Remaining(s.live))
      [] op = "Remove" -> id \in Elems(IF s.live.active = "normal"
                                       THEN NormalForUpdate ELSE s.live.playlist)
      [] op = "Restart" -> s.live.active = "playlist"
      [] OTHER -> TRUE

Edited(op, id) ==
    LET base == [s.live EXCEPT !.normal = NormalForUpdate]
    IN CASE op = "Switch" ->
        [base EXCEPT !.active = IF @ = "normal" THEN "playlist" ELSE "normal",
                      !.generation = @ + 1, !.revision = @ + 1,
                      !.current = IF s.owner = -1 THEN None ELSE @]
      [] op = "Move" ->
        IF base.active = "normal" THEN
            [base EXCEPT !.normal = Swap(@), !.revision = @ + 1]
        ELSE [base EXCEPT !.playlist = Swap(@), !.revision = @ + 1]
      [] op = "Remove" ->
        IF base.active = "normal" THEN
            [base EXCEPT !.normal = Without(@, {id}), !.revision = @ + 1]
        ELSE [base EXCEPT !.playlist = Without(@, {id}),
                            !.revision = @ + 1,
                            !.current = IF @ # None /\ @.source = "playlist"
                                           /\ @.id = id THEN None ELSE @]
      [] op = "Restart" ->
        [base EXCEPT !.run = @ + 1, !.played = {},
                      !.generation = @ + 1, !.revision = @ + 1,
                      !.current = IF @ # None /\ @.source = "playlist"
                                  THEN None ELSE @]
      [] op = "Off" ->
        [base EXCEPT !.normal = Without(@, {2}), !.allow = FALSE]
      [] OTHER -> [base EXCEPT !.allow = TRUE]

FutureNormal ==
    IF s.claim # None /\ ~s.cancelled /\ ~s.retired /\ s.owner # 1
       /\ s.claim.source = "normal" THEN <<s.claim.id>>
    ELSE IF s.reserved # None /\
            ~(s.owner # -1 /\ s.live.current # None /\
              s.live.current.source = "normal" /\ s.live.current.id = s.reserved)
         THEN <<s.reserved>> ELSE <<>>
FuturePlaylist ==
    IF s.claim # None /\ ~s.cancelled /\ ~s.retired /\ s.owner # 1
       /\ s.claim.source = "playlist" THEN <<s.claim.id>> ELSE <<>>
Replacement(op, candidate) ==
    s.configured /\ (op \in {"Switch", "Restart", "Off"}
    \/ (op = "On" /\ ~s.live.allow)
    \/ (op \in RequestOps /\
        ~Prefix(IF candidate.active = "normal" THEN FutureNormal ELSE FuturePlaylist,
                IF candidate.active = "normal" THEN candidate.normal
                ELSE Remaining(candidate))))
InterruptedNormal ==
    IF s.restored # None /\ s.restored.source = "normal" THEN
        [id |-> s.restored.id, fresh |-> TRUE]
    ELSE IF s.claim # None /\ s.claim.source = "normal"
            /\ s.loader.restoring /\ ~s.cancelled /\ ~s.retired THEN
        [id |-> s.claim.id, fresh |-> FALSE]
    ELSE None
RequeueId(interrupted) == IF interrupted.fresh THEN FreshNormal ELSE interrupted.id
RequeuedNormal(interrupted, normal) ==
    <<RequeueId(interrupted)>> \o
        IF interrupted.fresh THEN Without(normal, {interrupted.id}) ELSE normal
SettingsOnly(op) == op = "On" /\ s.live.allow
UpdatesSession(op, replace) ==
    ~SettingsOnly(op) /\
       (~s.configured \/ (replace /\ FutureNormal # <<>>)
        \/ (op = "Remove" /\ s.live.active = "normal"))
Candidate(op, id, replace) ==
    LET edited == Edited(op, id)
        revoked == IF replace THEN Elems(FutureNormal) ELSE {}
        removed == IF (op = "Remove" /\ s.live.active = "normal")
                   THEN {id} ELSE {}
        chosen == IF op \in {"Switch", "Restart"} /\ s.owner = -1 THEN
            [edited EXCEPT !.current = None,
             !.normal = IF InterruptedNormal = None THEN @
                        ELSE RequeuedNormal(InterruptedNormal, @)]
            ELSE edited
        captured == IF op \in {"Move", "Remove", "Off", "On"}
                       /\ s.owner = -1 /\ chosen.current = None
                       /\ Member(s.restored, chosen)
                    THEN [chosen EXCEPT !.current = s.restored] ELSE chosen
    IN IF op = "On" /\ s.live.allow THEN s.disk
       ELSE [captured EXCEPT !.normalResume = captured.normal,
             !.session = IF ~s.configured THEN <<>>
                         ELSE IF UpdatesSession(op, replace)
                              THEN Without(s.live.session, revoked \cup removed)
                              ELSE s.disk.session]

Begin(op, id, request, target) ==
    /\ Idle /\ CurrentMatches /\ s.attempts < 2
    /\ OpEnabled(op, id)
    /\ (op \notin RequestOps \/ s.receipts[request] = None)
    /\ LET replace == Replacement(op, Edited(op, id))
           candidate == Candidate(op, id, replace)
           publishQueue == replace \/
              (op \in RequestOps /\ candidate.normal # s.live.normal) \/
              (op = "Off" \/ (op = "On" /\ ~s.live.allow))
       IN s' = [s EXCEPT !.attempts = @ + 1, !.phase = "prepared",
            !.tx = [request |-> IF op \in RequestOps THEN request ELSE 0,
                    op |-> op,
                    fingerprint |-> Fingerprint(op, id, target),
                    candidate |-> candidate,
                    oldDisk |-> s.disk, oldLive |-> s.live, restoredBefore |-> s.restored,
                    replace |-> replace, renamed |-> FALSE,
                    owner |-> s.owner, epoch |-> s.epoch,
                    generation |-> s.engineGeneration,
                    interruptedNormal |-> InterruptedNormal,
                    normalBefore |-> NormalForUpdate,
                    sessionUpdated |-> UpdatesSession(op, replace),
                    publishQueue |-> publishQueue],
            !.replay = None, !.rejected = FALSE]

(* command_with reconciles before building its candidate; core can advance
   between that read and begin_future_update. The token's current index must
   still equal the reconciled owner before any persistence. *)
Fence ==
    /\ s.up /\ s.phase = "prepared"
    /\ IF s.tx.replace /\ ~CurrentMatches THEN
          s' = [s EXCEPT !.phase = "idle", !.tx = EmptyTx, !.rejected = TRUE]
       ELSE s' = [s EXCEPT !.phase = "saving", !.fence = s.tx.replace /\ UseFence]
RefuseFence ==
    /\ s.up /\ s.phase = "prepared" /\ s.tx.replace
    /\ s' = [s EXCEPT !.phase = "idle", !.tx = EmptyTx, !.rejected = TRUE]

(* persist_snapshot's successful rename is the sole command durable commit.
   No service command/claim/progress callback runs while these phases hold its
   mutex. Core rendering, mailbox completion, and a process crash still run. *)
Rename ==
    /\ s.up /\ s.phase = "saving"
    /\ s' = [s EXCEPT !.disk = s.tx.candidate, !.fileRevision = @ + 1,
             !.tx.renamed = TRUE, !.phase = "renamed"]
PersistFailure ==
    /\ s.up /\ s.phase = "saving"
    /\ IF CommitOnFailure THEN s' = [s EXCEPT !.phase = "renamed"]
       ELSE s' = [s EXCEPT !.phase = "idle", !.fence = FALSE,
                   !.tx = EmptyTx, !.rejected = TRUE]
Publish ==
    /\ s.up /\ s.phase = "renamed"
    /\ s' = [s EXCEPT !.live = IF s.tx.op = "On" /\ s.tx.oldLive.allow
                      THEN s.tx.oldLive ELSE
                 [s.tx.candidate EXCEPT
                    !.normal = IF s.tx.publishQueue THEN @ ELSE s.tx.oldLive.normal,
                    !.session = IF s.tx.sessionUpdated THEN @ ELSE s.tx.oldLive.session],
             !.loaded = @ \/ s.tx.publishQueue, !.phase = "published",
             !.epoch = @ + IF s.tx.replace THEN 1 ELSE 0,
             !.applications = IF s.tx.request = 0 THEN @ ELSE
                [@ EXCEPT ![s.tx.request] = @ + 1],
             !.cancelled = @ \/ (s.tx.replace /\ s.claim # None /\ ~s.retired /\ s.owner # 1),
             !.reserved = IF s.tx.replace THEN None ELSE
                 IF s.reserved \notin Elems(s.tx.candidate.normal) THEN None ELSE @,
             !.restored = IF s.tx.op \in {"Switch", "Restart"} /\ s.owner = -1
                         THEN None ELSE @]
CoreCommit ==
    /\ s.up /\ s.phase = "published"
    /\ s' = [s EXCEPT !.phase = "committed", !.fence = FALSE,
             !.engineGeneration = @ + IF s.tx.replace THEN 1 ELSE 0,
             !.sourceGenerations = IF s.tx.replace THEN
                [e \in 0..s.epoch |-> IF e = s.epoch
                    THEN s.engineGeneration + 1 ELSE s.sourceGenerations[e]] ELSE @,
             !.ready = IF s.tx.replace THEN FALSE ELSE @]
Receipt ==
    /\ s.up /\ s.phase = "committed"
    /\ s' = [s EXCEPT !.phase = "reply",
             !.receipts = IF s.tx.request = 0 THEN @ ELSE
                 [@ EXCEPT ![s.tx.request] =
                    [fingerprint |-> s.tx.fingerprint,
                     result |-> Target(s.tx.candidate)]]]
Reply ==
    /\ s.up /\ s.phase = "reply"
    /\ s' = [s EXCEPT !.phase = "idle", !.tx = EmptyTx]

(* Receipt lookup precedes target freshness. A matching retry has exactly the
   original result; a changed fingerprint with the same request ID is stale.
   These observations are finite, repeatable stutters apart from the witness.
   The receipt's own fingerprint always matches and another request op never
   does, so the two outcomes are enumerated directly instead of every input. *)
Retry(request, matching) ==
    /\ Idle /\ s.receipts[request] # None
    /\ LET receipt == s.receipts[request]
       IN s' = [s EXCEPT !.replay =
           [matching |-> matching,
            expected |-> receipt.result,
            result |-> IF matching THEN receipt.result ELSE "stale",
            targetStale |-> receipt.fingerprint.target # Target(s.live)]]


(* Target checks use equality only. Each subset selects which of active source,
   catalog generation, and catalog revision differs. +1 is a canonical unequal
   representative, not an ordering assumption. *)
TargetShapes ==
    {[active |-> IF "active" \in mismatch
                 THEN IF s.live.active = "normal" THEN "playlist" ELSE "normal"
                 ELSE s.live.active,
      generation |-> s.live.generation + IF "generation" \in mismatch THEN 1 ELSE 0,
      revision |-> s.live.revision + IF "revision" \in mismatch THEN 1 ELSE 0]
      : mismatch \in SUBSET {"active", "generation", "revision"}}

ProtectedState(state) == [state EXCEPT !.attempts = 0, !.rejected = FALSE]
RejectStaleTarget(target) ==
    /\ Idle /\ CurrentMatches /\ s.attempts < 2
    /\ target # Target(s.live)
    /\ s' = [s EXCEPT !.attempts = @ + 1, !.rejected = TRUE]
    /\ requestAudit' = [target |-> target, before |-> ProtectedState(s)]

Crash ==
    /\ s.up /\ s.incarnation = 0
    /\ s' = [s EXCEPT !.up = FALSE]
RestartProcess ==
    /\ ~s.up /\ s.incarnation = 0
    /\ LET restored == IF Member(s.disk.current, s.disk) THEN s.disk.current ELSE None
           st == [s.disk EXCEPT !.current = None, !.normal = <<>>, !.session = <<>>,
                  !.played = IF restored # None /\ restored.source = "playlist"
                             THEN @ \ {restored.id} ELSE @,
                  !.revision = @ + IF s.disk.current # None THEN 1 ELSE 0]
       IN s' = [s EXCEPT !.up = TRUE, !.incarnation = 1, !.loaded = FALSE, !.configured = FALSE,
            !.live = st, !.epoch = 0, !.engineGeneration = 0,
            !.sourceGenerations = [e \in {0} |-> 0],
            !.owner = -1, !.core = -1, !.ended = FALSE,
            !.observed = FALSE, !.eventSeen = FALSE,
            !.claim = None, !.cancelled = FALSE, !.retired = FALSE, !.loader = EmptyLoader,
            !.reserved = None, !.restored = restored,
            !.ready = FALSE, !.event = FALSE, !.fence = FALSE,
            !.phase = "idle", !.tx = EmptyTx,
            !.receipts = [r \in Requests |-> None],
            !.applications = [r \in Requests |-> 0], !.replay = None,
            !.admission = None, !.selection = None,
            !.recovery = [saved |-> s.disk.current, restored |-> restored,
                           valid |-> Member(s.disk.current, s.disk)]]


SavedNormalCurrent(st) ==
    IF st.current # None /\ st.current.source = "normal" THEN st.current.id ELSE None
StartupQueue(st) ==
    LET current == SavedNormalCurrent(st)
    IN IF st.active = "playlist" THEN
          Without(st.normalResume, IF current = None THEN {} ELSE {current})
       ELSE RestoreQueue(IF current = None THEN st.session
                         ELSE <<current>> \o Without(st.session, {current}), st.normal)
NormalizeStartup(start) ==
    /\ Idle /\ ~s.configured /\ (start \/ ~s.loaded)
    /\ LET queue == StartupQueue(s.disk)
           clear == s.disk.active = "normal" /\ SavedNormalCurrent(s.disk) # None
           disk == [s.disk EXCEPT !.normal = queue, !.session = <<>>,
                      !.current = IF clear THEN None ELSE @]
           live == [s.live EXCEPT !.normal = queue, !.session = <<>>,
                      !.current = IF clear THEN None ELSE @]
           restored == IF clear THEN None ELSE s.restored
       IN /\ s' = [s EXCEPT !.disk = disk, !.live = live, !.restored = restored,
                    !.fileRevision = @ + 1, !.loaded = TRUE, !.configured = start]
          /\ requestAudit' = None
          /\ startupAudit' = [queue |-> queue, diskCurrent |-> disk.current,
                   liveCurrent |-> live.current, restored |-> restored,
                   target |-> Target(s.live), fileRevision |-> s.fileRevision + 1,
                   epoch |-> s.epoch, generation |-> s.engineGeneration,
                   configured |-> start]
NormalizeFailure == Idle /\ ~s.configured /\ UNCHANGED s

OrdinaryNext ==
    (\E sourceEpoch \in DOMAIN s.sourceGenerations: Reserve(sourceEpoch))
    \/ Capture \/ Admit \/ LoaderComplete \/ DeliverReady
    \/ CoreStart \/ CoreEnd \/ ObserveEvent \/ ObserveCurrent \/ ObserveEnd
    \/ Fence \/ RefuseFence \/ Rename \/ PersistFailure \/ Publish \/ CoreCommit
    \/ Receipt \/ Reply \/ Crash \/ RestartProcess \/ NormalizeFailure
NonStartupNext ==
    (OrdinaryNext /\ requestAudit' = None)
    \/ ((\E request \in Requests: s.receipts[request] = None)
        /\ (\E target \in TargetShapes \ {Target(s.live)}: RejectStaleTarget(target)))
    \/ (\E request \in Requests, matching \in BOOLEAN:
          Retry(request, matching) /\ requestAudit' = None)
    \/ (\E op \in Ops: \E request \in (IF op \in RequestOps THEN Requests ELSE {1}):
          \E id \in InputIds(op):
              Begin(op, id, request, Target(s.live)) /\ requestAudit' = None)

Next == (NonStartupNext /\ startupAudit' = None)
        \/ (\E start \in BOOLEAN: NormalizeStartup(start))

Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ s.incarnation \in 0..1 /\ s.attempts \in 0..2
    /\ s.loaded \in BOOLEAN /\ s.configured \in BOOLEAN
    /\ (s.configured => s.loaded)
    /\ (~s.configured => s.loader.stage = "empty")
    /\ s.live.active \in Sources /\ s.disk.active \in Sources
    /\ s.epoch \in Nat /\ s.engineGeneration \in Nat /\ s.fileRevision \in Nat
    /\ s.live.revision \in Nat /\ s.live.generation \in Nat
    /\ Elems(s.live.normal) \subseteq NormalIds /\ Elems(s.disk.normal) \subseteq NormalIds
    /\ Elems(s.live.normalResume) \subseteq NormalIds
    /\ Elems(s.disk.normalResume) \subseteq NormalIds
    /\ Unique(s.live.normalResume) /\ Unique(s.disk.normalResume)
    /\ Elems(s.live.session) \subseteq NormalIds /\ Elems(s.disk.session) \subseteq NormalIds
    /\ Elems(s.live.playlist) \subseteq Ids /\ Elems(s.disk.playlist) \subseteq Ids
    /\ s.live.played \subseteq Ids /\ s.disk.played \subseteq Ids
    /\ Len(s.live.normal) <= 2 /\ Len(s.disk.normal) <= 2
    /\ Unique(s.live.normal) /\ Unique(s.disk.normal)
    /\ Unique(s.live.playlist) /\ Unique(s.disk.playlist)
    /\ Unique(s.live.session) /\ Unique(s.disk.session)

NoStaleLoaderEffect ==
    /\ (s.admission = None \/ s.admission.captured = s.admission.observed)
    /\ (s.selection = None \/ s.selection.captured = s.selection.observed)
    /\ (s.ready => s.loader.generation = s.engineGeneration)
FenceBeforeFutureDelta ==
    s.up /\ s.phase \in {"renamed", "published"} /\ s.tx.replace => s.fence
NoCommitWithoutDurableCandidate ==
    s.up /\ s.phase \in {"published", "committed", "reply"} =>
        s.tx.renamed /\ s.disk = s.tx.candidate
FailureLeavesOldState ==
    s.up /\ s.phase = "saving" =>
        s.disk = s.tx.oldDisk /\ s.live = s.tx.oldLive
        /\ s.epoch = s.tx.epoch /\ s.engineGeneration = s.tx.generation
OrderedSessionRecovery == Prefix(s.disk.session, s.disk.normal)
ExactRecoveryIdentity ==
    s.recovery = None \/
        (s.recovery.valid => s.recovery.restored = s.recovery.saved)
StartupNormalization ==
    startupAudit = None \/
       (s.loaded /\ s.configured = startupAudit.configured
        /\ s.live.normal = startupAudit.queue /\ s.disk.normal = startupAudit.queue
        /\ s.live.session = <<>> /\ s.disk.session = <<>>
        /\ s.live.current = startupAudit.liveCurrent
        /\ s.disk.current = startupAudit.diskCurrent
        /\ s.restored = startupAudit.restored /\ Target(s.live) = startupAudit.target
        /\ s.fileRevision = startupAudit.fileRevision
        /\ s.epoch = startupAudit.epoch /\ s.engineGeneration = startupAudit.generation)
SourceChoiceRetiresRestore ==
    s.phase \in {"renamed", "published", "committed", "reply"}
    /\ s.tx.renamed /\ s.tx.op \in {"Switch", "Restart"} /\ s.tx.owner = -1 =>
       /\ s.disk.current = None
       /\ (s.tx.interruptedNormal # None =>
             /\ s.disk.normal = RequeuedNormal(s.tx.interruptedNormal, s.tx.normalBefore)
             /\ (s.tx.interruptedNormal.fresh =>
                   s.tx.interruptedNormal.id \notin Elems(s.disk.normal)))
       /\ (s.phase \in {"published", "committed", "reply"} => s.restored = None)
RequestTargetSafety ==
    /\ (s.phase # "idle" /\ s.tx.request # 0 =>
          s.tx.fingerprint.target = Target(s.tx.oldLive))
    /\ (requestAudit = None \/
          (requestAudit.target # Target(requestAudit.before.live)
           /\ ProtectedState(s) = requestAudit.before))
ReceiptIdempotency ==
    /\ (\A request \in Requests:
          s.applications[request] <= 1 /\
          (s.receipts[request] # None => s.applications[request] = 1))
    /\ (s.replay = None \/
          s.replay.result = IF s.replay.matching THEN s.replay.expected ELSE "stale")
ExactAdmissionIdentity ==
    s.admission = None \/
       (s.admission.member /\
        IF s.admission.restoring THEN s.admission.item = s.admission.restored
        ELSE IF s.admission.item.source = "normal"
             THEN s.admission.item.id = s.admission.reserved
             ELSE s.admission.active = "playlist")
RetainsRestoredCurrent ==
    s.phase \in {"prepared", "saving", "renamed", "published", "committed", "reply"}
    /\ s.tx.owner = -1 /\ s.tx.op \in {"Off", "On", "Move", "Remove"}
    /\ Member(s.tx.restoredBefore, s.tx.candidate) =>
       /\ s.tx.candidate.current = s.tx.restoredBefore
       /\ (s.tx.renamed => s.disk.current = s.tx.restoredBefore)
RetainsAudibleCurrent ==
    s.up /\ s.phase \in {"renamed", "published", "committed", "reply"}
    /\ s.tx.renamed /\ s.tx.owner # -1
    /\ s.tx.oldLive.current # None
    /\ ~(s.tx.oldLive.current.source = "playlist" /\
          (s.tx.op = "Restart" \/
           (s.tx.op = "Remove" /\ s.tx.oldLive.active = "playlist" /\
            s.tx.fingerprint.entry = s.tx.oldLive.current.id))) =>
        s.disk.current = s.tx.oldLive.current
CurrentNeverMovesBackward == s.observed => s.owner \in {-1, 1}
NoCancelledStart ==
    s.up /\ s.core = 1 /\ ~s.ended => ~s.cancelled
=============================================================================
