------------------------- MODULE CacheLifecycle -------------------------
EXTENDS Naturals, FiniteSets, TLC

CONSTANTS Fixtures, IsolatedCwd, WaitForExit
VARIABLES parent, child, worker, scratch, checkoutCache
vars == <<parent, child, worker, scratch, checkoutCache>>

Init ==
    /\ parent = [i \in Fixtures |-> "new"]
    /\ child = [i \in Fixtures |-> "absent"]
    /\ worker = [i \in Fixtures |-> "pending"]
    /\ scratch = [i \in Fixtures |-> FALSE]
    /\ checkoutCache = FALSE

Allocate(i) ==
    /\ parent[i] = "new"
    /\ parent' = [parent EXCEPT ![i] = "owned"]
    /\ scratch' = [scratch EXCEPT ![i] = TRUE]
    /\ UNCHANGED <<child, worker, checkoutCache>>

Spawn(i) ==
    /\ parent[i] = "owned"
    /\ parent' = [parent EXCEPT ![i] = "waiting"]
    /\ child' = [child EXCEPT ![i] = "running"]
    /\ UNCHANGED <<worker, scratch, checkoutCache>>

ReturnFromTest(i) ==
    /\ child[i] = "running"
    /\ child' = [child EXCEPT ![i] = "returned"]
    /\ UNCHANGED <<parent, worker, scratch, checkoutCache>>

WriteCache(i) ==
    /\ child[i] \in {"running", "returned"}
    /\ worker[i] = "pending"
    /\ worker' = [worker EXCEPT ![i] = "written"]
    /\ scratch' = IF IsolatedCwd THEN [scratch EXCEPT ![i] = TRUE] ELSE scratch
    /\ checkoutCache' = (checkoutCache \/ ~IsolatedCwd)
    /\ UNCHANGED <<parent, child>>

ExitChild(i) ==
    /\ child[i] = "returned"
    /\ child' = [child EXCEPT ![i] = "exited"]
    /\ worker' = [worker EXCEPT ![i] = "stopped"]
    /\ UNCHANGED <<parent, scratch, checkoutCache>>

RemoveScratch(i) ==
    /\ parent[i] = "waiting"
    /\ (~WaitForExit \/ child[i] = "exited")
    /\ parent' = [parent EXCEPT ![i] = "released"]
    /\ scratch' = [scratch EXCEPT ![i] = FALSE]
    /\ UNCHANGED <<child, worker, checkoutCache>>

Done ==
    /\ \A i \in Fixtures : parent[i] = "released" /\ child[i] = "exited"
    /\ UNCHANGED vars

Next ==
    (\E i \in Fixtures : Allocate(i) \/ Spawn(i) \/ ReturnFromTest(i)
        \/ WriteCache(i) \/ ExitChild(i) \/ RemoveScratch(i)) \/ Done

CacheOwnership ==
    /\ ~checkoutCache
    /\ \A i \in Fixtures :
        /\ (child[i] \in {"running", "returned"} => scratch[i])
        /\ (parent[i] = "released" => ~scratch[i])
=============================================================================
