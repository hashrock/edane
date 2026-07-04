------------------------------- MODULE Autosave -------------------------------
(***************************************************************************)
(* TLA+ model of edane's note lifecycle:                                   *)
(*   page load → login-state resolution → render → edit → debounced         *)
(*   autosave (+ navigation guard).                                        *)
(*                                                                         *)
(* Sources (app/components/useNoteEditor.ts, app/pages/Notes/Edit.tsx):    *)
(*   - Login state is resolved SERVER-side and handed to the page as props.*)
(*     An authenticated owner gets `noteId` (→ autosave on); anyone else is *)
(*     a guest (no noteId → NO autosave, no network writes, no guard).      *)
(*   - Render: Konva mounts (konvaReady) before the user can edit.          *)
(*   - Edit: dispatch bumps the model; the debounce effect re-arms a 1500ms *)
(*     timer carrying the LATEST model (it clears any prior timer).         *)
(*   - Timer fires → saveNote(model): an async PUT. On success it sets      *)
(*     lastSavedContentRef = the saved content and shows 保存済み.           *)
(*   - isDirty() == noteId present AND serialize(model) != lastSaved.        *)
(*   - Navigation guard (router "before"): if isDirty, hold the visit,      *)
(*     flush a save, then proceed (bypass) on success or raise a dialog on  *)
(*     failure.                                                             *)
(*                                                                         *)
(* The interesting async shape: an edit can arrive while a save is still    *)
(* in flight, so TWO saves run concurrently and their responses can land    *)
(* OUT OF ORDER. `lastSavedContentRef` is overwritten in completion order,  *)
(* with no version guard — so the client baseline can regress. This model   *)
(* pins down exactly what that can and cannot break.                        *)
(*                                                                         *)
(* serverLatest models the persisted content assuming the server applies    *)
(* writes in the order their requests are DISPATCHED (TimerFire order); we   *)
(* track it as the max version ever sent, which is the optimistic (single-  *)
(* origin, ordered) case. lastSaved is updated in RESPONSE-completion order, *)
(* which may differ.                                                        *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANT MaxVer            \* bound on the model version (edits), keeps state finite

Max(a, b) == IF a >= b THEN a ELSE b

VARIABLES
  phase,        \* "loading" | "guest" | "editing"
  konvaReady,   \* rendering finished?
  modelVer,     \* current in-memory model version (0 = the loaded baseline)
  lastSaved,    \* lastSavedContentRef: version the client BELIEVES is persisted
  serverLatest, \* version actually persisted (optimistic in-order server)
  timer,        \* "off" | "armed"  (debounce timer)
  inflight,     \* set of versions whose save PUT is in flight
  navigated,    \* a client navigation has proceeded
  dialog        \* the "save failed, leave anyway?" dialog is up

vars == <<phase, konvaReady, modelVer, lastSaved, serverLatest,
          timer, inflight, navigated, dialog>>

\* isDirty(): only meaningful with a noteId (phase = "editing").
IsDirty == (phase = "editing") /\ (modelVer # lastSaved)

TypeOK ==
  /\ phase \in {"loading", "guest", "editing"}
  /\ konvaReady \in BOOLEAN
  /\ modelVer \in 0..MaxVer
  /\ lastSaved \in 0..MaxVer
  /\ serverLatest \in 0..MaxVer
  /\ timer \in {"off", "armed"}
  /\ inflight \subseteq (0..MaxVer)
  /\ Cardinality(inflight) =< 2
  /\ navigated \in BOOLEAN
  /\ dialog \in BOOLEAN

Init ==
  /\ phase = "loading"
  /\ konvaReady = FALSE
  /\ modelVer = 0
  /\ lastSaved = 0        \* server just handed us the initial model = clean
  /\ serverLatest = 0
  /\ timer = "off"
  /\ inflight = {}
  /\ navigated = FALSE
  /\ dialog = FALSE

------------------------------------------------------------------------------
\* Load / login-state resolution (server-side, reflected in props).

ResolveGuest ==   \* anonymous, or a new unsaved doc: no noteId
  /\ phase = "loading"
  /\ phase' = "guest"
  /\ UNCHANGED <<konvaReady, modelVer, lastSaved, serverLatest, timer,
                 inflight, navigated, dialog>>

ResolveEditing == \* authenticated owner with a persisted note (has noteId)
  /\ phase = "loading"
  /\ phase' = "editing"
  /\ UNCHANGED <<konvaReady, modelVer, lastSaved, serverLatest, timer,
                 inflight, navigated, dialog>>

Render ==
  /\ phase # "loading"
  /\ konvaReady = FALSE
  /\ konvaReady' = TRUE
  /\ UNCHANGED <<phase, modelVer, lastSaved, serverLatest, timer,
                 inflight, navigated, dialog>>

------------------------------------------------------------------------------
\* Editing (authenticated). Each edit re-arms the debounce timer with the
\* latest model. Guests cannot edit-to-persist (guarded on phase = "editing").

Edit ==
  /\ phase = "editing"
  /\ ~navigated
  /\ konvaReady
  /\ modelVer < MaxVer
  /\ modelVer' = modelVer + 1
  /\ timer' = "armed"
  /\ UNCHANGED <<phase, konvaReady, lastSaved, serverLatest, inflight,
                 navigated, dialog>>

------------------------------------------------------------------------------
\* Debounced autosave.

\* Timer fires: dispatch a PUT for the CURRENT model version. The request is
\* now "sent", so the (in-order) server will hold at least this version.
TimerFire ==
  /\ ~navigated
  /\ timer = "armed"
  /\ Cardinality(inflight) < 2           \* bound concurrency for the model
  /\ inflight' = inflight \cup {modelVer}
  /\ serverLatest' = Max(serverLatest, modelVer)
  /\ timer' = "off"
  /\ UNCHANGED <<phase, konvaReady, modelVer, lastSaved, navigated, dialog>>

\* A save's RESPONSE lands (success). lastSavedContentRef := its version — in
\* completion order, with NO version guard (faithful to the code). Completions
\* may occur in any order, so lastSaved can move backwards.
SaveOk(v) ==
  /\ ~navigated
  /\ v \in inflight
  /\ inflight' = inflight \ {v}
  /\ lastSaved' = v
  /\ UNCHANGED <<phase, konvaReady, modelVer, serverLatest, timer,
                 navigated, dialog>>

\* A save fails: drop it, leave the baseline untouched.
SaveFail(v) ==
  /\ ~navigated
  /\ v \in inflight
  /\ inflight' = inflight \ {v}
  /\ UNCHANGED <<phase, konvaReady, modelVer, lastSaved, serverLatest, timer,
                 navigated, dialog>>

------------------------------------------------------------------------------
\* Client-side navigation guard (Inertia "before").

NavClean ==   \* not dirty → the visit proceeds immediately
  /\ phase = "editing"
  /\ ~navigated
  /\ ~IsDirty
  /\ navigated' = TRUE
  /\ UNCHANGED <<phase, konvaReady, modelVer, lastSaved, serverLatest,
                 timer, inflight, dialog>>

NavFlushOk ==  \* dirty → clear timer, flush the latest, then proceed
  /\ phase = "editing"
  /\ ~navigated
  /\ IsDirty
  /\ timer' = "off"
  /\ serverLatest' = Max(serverLatest, modelVer)
  /\ lastSaved' = modelVer
  /\ navigated' = TRUE
  /\ UNCHANGED <<phase, konvaReady, modelVer, inflight, dialog>>

NavFlushFail ==  \* dirty → flush fails → raise the confirm dialog (no navigate)
  /\ phase = "editing"
  /\ ~navigated
  /\ IsDirty
  /\ timer' = "off"
  /\ dialog' = TRUE
  /\ UNCHANGED <<phase, konvaReady, modelVer, lastSaved, serverLatest,
                 inflight, navigated>>

------------------------------------------------------------------------------
Next ==
  \/ ResolveGuest \/ ResolveEditing \/ Render
  \/ Edit
  \/ TimerFire
  \/ \E v \in inflight : SaveOk(v)
  \/ \E v \in inflight : SaveFail(v)
  \/ NavClean \/ NavFlushOk \/ NavFlushFail

\* Fairness: the debounce timer eventually fires, and in-flight saves eventually
\* succeed (for the liveness property). No fairness on SaveFail/Nav.
Fairness ==
  /\ WF_vars(TimerFire)
  /\ \A v \in 0..MaxVer : WF_vars(SaveOk(v))

Spec == Init /\ [][Next]_vars /\ Fairness

\* Happy-path spec for the liveness property: no save failures and no failed
\* flush (a persistently-failing network or an unresolved dialog can obviously
\* keep the server behind — that is the failure path, not an autosave bug).
NextHappy ==
  \/ ResolveGuest \/ ResolveEditing \/ Render
  \/ Edit
  \/ TimerFire
  \/ \E v \in inflight : SaveOk(v)
  \/ NavClean \/ NavFlushOk
SpecHappy == Init /\ [][NextHappy]_vars /\ Fairness

------------------------------------------------------------------------------
\* ---- Safety invariants (expected to HOLD) ----

\* Login gating: a guest never issues a network write — nothing in flight, and
\* the server is never touched.
GuestNeverSaves ==
  (phase = "guest") => (inflight = {} /\ serverLatest = 0)

\* Navigation safety: a navigation only proceeds when the server holds the
\* current model (a clean state or a successful flush) — never silently with an
\* edit the server hasn't got. This is the "no lost edit on navigate" guarantee.
NavSafe == navigated => (serverLatest = modelVer)

\* The client never UNDER-reports (isDirty = FALSE while the server is stale).
\* Under-reporting would let NavClean skip the flush and lose data; this asserts
\* it cannot happen. (Over-reporting — spurious dirty — is covered separately.)
NoFalseClean == (~IsDirty /\ phase = "editing") => (serverLatest = modelVer)

\* ---- The autosave race (property expected to FAIL — a real finding) ----

\* At quiescence (no timer, nothing in flight) the client baseline should match
\* the model. Out-of-order save completions can violate this: lastSaved regresses
\* to an older in-flight version, so isDirty stays TRUE though the server is in
\* fact up to date → a transient false "未保存" / redundant save.
\* Scoped to pure autosave quiescence (no pending navigation / failure dialog,
\* which legitimately leave the doc dirty at rest).
BaselineConsistent ==
  (phase = "editing" /\ timer = "off" /\ inflight = {}
     /\ ~dialog /\ ~navigated)
    => (lastSaved = modelVer)

\* ---- Liveness (expected to HOLD under Fairness) ----

\* If the user stops editing, the server eventually holds the latest model.
ServerCatchesUp == <>[](serverLatest = modelVer)

=============================================================================
