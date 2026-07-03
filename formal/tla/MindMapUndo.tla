-------------------------- MODULE MindMapUndo --------------------------
(***************************************************************************)
(* TLA+ model of edane's editor state machine: the document, the single   *)
(* active selection, and the undo/redo command stacks.                    *)
(*                                                                         *)
(* Sources being formalized                                               *)
(* ------------------------                                               *)
(* DECLARED spec:                                                         *)
(*   - app/application/editorReducer.ts (header):                         *)
(*       "exactly ONE node is always active (activeNodeId is never null)".*)
(*   - app/application/undoManager.ts (header):                           *)
(*       "ViewState (selection/caret) is intentionally out of scope:      *)
(*        undoing an operation restores the document without moving focus".*)
(*   - app/application/editorReducer.ts reconcileView():                  *)
(*       after undo/redo, if the active node is absent it "falls back to   *)
(*       the document root".                                              *)
(*                                                                         *)
(* The tension the model exposes: undo/redo restores ONLY the document    *)
(* and leaves `active` untouched; keeping the declared "active is always a *)
(* live node" invariant depends on the CALLER separately running          *)
(* reconcileView(). We make that a model flag, ReconcileAuto, and let TLC  *)
(* show the dangling-selection trace when it is FALSE.                     *)
(*                                                                         *)
(* NOTE ON EXECUTION: TLC (tla2tools.jar) could not be fetched in the CI   *)
(* sandbox used to author this (network egress is limited to PyPI / npm /  *)
(* Maven Central; GitHub release + Azure downloads are blocked). The same  *)
(* invariant was cross-checked with Z3 in formal/z3/undo_redo.py (part B), *)
(* which is executable here and reports the identical counterexample. Run  *)
(* this spec locally with:  tlc MindMapUndo.tla -config MindMapUndo.cfg    *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    Nodes,          \* set of possible node ids, e.g. {r, n1, n2}
    Root,           \* the root id (in Nodes); removeNode never removes it
    ReconcileAuto,  \* TRUE = fold reconcileView() into undo/redo (the fix)
                    \* FALSE = reconcile is a *separate* caller step (today)
    MaxEdits        \* bound on structural edits, to keep the stacks finite

VARIABLES
    doc,        \* set of node ids currently in the document (Root always in doc)
    active,     \* the single active node id (models activeNodeId, never null here)
    undoStack,  \* Seq of document snapshots (each a subset of Nodes)
    redoStack,  \* Seq of document snapshots
    edits       \* number of structural edits performed (for bounding)

vars == <<doc, active, undoStack, redoStack, edits>>

\* reconcileView(): keep active if it is still a live node, else fall back to Root.
Reconciled(a, d) == IF a \in d THEN a ELSE Root

Init ==
    /\ doc = {Root}
    /\ active = Root
    /\ undoStack = << >>
    /\ redoStack = << >>
    /\ edits = 0

\* AddNode: create a new node under the document and select it (enter / addChild).
AddNode ==
    /\ edits < MaxEdits
    /\ \E n \in Nodes \ doc :
         /\ doc' = doc \cup {n}
         /\ active' = n
         /\ undoStack' = Append(undoStack, doc)   \* push stateBefore
         /\ redoStack' = << >>                     \* any new action clears redo
         /\ edits' = edits + 1

\* DeleteNode: remove a non-root node. The reducer's *direct* delete path
\* refocuses to a surviving node, so we model that here (active stays live).
DeleteNode ==
    /\ edits < MaxEdits
    /\ \E n \in doc \ {Root} :
         /\ doc' = doc \ {n}
         /\ active' = IF active = n THEN Root ELSE active
         /\ undoStack' = Append(undoStack, doc)
         /\ redoStack' = << >>
         /\ edits' = edits + 1

\* Undo: restore ONLY the document (per undoManager). `active` is deliberately
\* left untouched; reconcileView is applied here ONLY if ReconcileAuto.
Undo ==
    /\ undoStack # << >>
    /\ LET before == undoStack[Len(undoStack)] IN
         /\ doc' = before
         /\ active' = IF ReconcileAuto THEN Reconciled(active, before) ELSE active
         /\ undoStack' = SubSeq(undoStack, 1, Len(undoStack) - 1)
         /\ redoStack' = Append(redoStack, doc)
    /\ UNCHANGED edits

Redo ==
    /\ redoStack # << >>
    /\ LET after == redoStack[Len(redoStack)] IN
         /\ doc' = after
         /\ active' = IF ReconcileAuto THEN Reconciled(active, after) ELSE active
         /\ redoStack' = SubSeq(redoStack, 1, Len(redoStack) - 1)
         /\ undoStack' = Append(undoStack, doc)
    /\ UNCHANGED edits

\* Reconcile: the caller's *separate* reconcileView() call (may lag behind undo).
Reconcile ==
    /\ active' = Reconciled(active, doc)
    /\ UNCHANGED <<doc, undoStack, redoStack, edits>>

Next == AddNode \/ DeleteNode \/ Undo \/ Redo \/ Reconcile

Spec == Init /\ [][Next]_vars

(***************************************************************************)
(* Invariants                                                             *)
(***************************************************************************)

\* Type / structural sanity.
TypeOK ==
    /\ doc \subseteq Nodes
    /\ Root \in doc
    /\ active \in Nodes

\* The DECLARED invariant: the active selection always references a live node.
\* With ReconcileAuto = FALSE, TLC finds a trace (AddNode then Undo) where this
\* fails -> a dangling selection that silently no-ops every keyboard action.
ActiveAlwaysLive == active \in doc

=============================================================================
