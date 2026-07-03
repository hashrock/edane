-------------------------------- MODULE EditUndo --------------------------------
(***************************************************************************)
(* Round 2 / Finding A — TLA+ state machine of edane's edit + undo path,   *)
(* checking that the editor VIEW (the edit buffer + caret) stays faithful  *)
(* to the active node across undo, not merely that the active node exists. *)
(*                                                                         *)
(* Sources being formalized                                                *)
(* ------------------------                                                *)
(* DECLARED spec (maintained by every non-`replace` reducer path, and read *)
(* directly by the renderer):                                              *)
(*   - editorReducer.ts focusView(): focus sets editingText := node.text   *)
(*     and keeps the caret within it. Hence the reducer's own contract:    *)
(*        editingText = text(active)   AND   cursorPos <= len(text(active)) *)
(*   - MindmapEditor.tsx renders the active node from `editingText`        *)
(*     (l.1155/1204) and drives the textarea via el.value = editingText;   *)
(*     el.setSelectionRange(cursorPos, ...) (l.427-428).                    *)
(*                                                                         *)
(* CODE spec (what undo actually restores):                                *)
(*   - undoManager.undo() restores only the DocumentState.                 *)
(*   - editorReducer.ts replace/reconcileView(): when the active node still *)
(*     exists, the INCOMING (stale) view is returned unchanged — editingText*)
(*     and cursorPos are NOT re-derived from the restored node.            *)
(*   - MindmapEditor.restoreDocument() feeds the current view + restored    *)
(*     document into `replace`.                                            *)
(*                                                                         *)
(* The CONSTANT ReconcileRefreshesBuffer toggles the two designs:          *)
(*   FALSE = current code (only the active-exists invariant is restored).   *)
(*   TRUE  = proposed fix (reconcile also re-derives editingText/caret).    *)
(***************************************************************************)
EXTENDS Naturals, Sequences

CONSTANT ReconcileRefreshesBuffer   \* FALSE = as-coded, TRUE = proposed fix

VARIABLES
  docLen,       \* length of the single editable node's text in the document
  editingText,  \* length of the view's edit buffer (view.editingText)
  cursorPos,    \* view.cursorPos
  undoStack     \* sequence of past docLen snapshots (stateBefore of each edit)

vars == <<docLen, editingText, cursorPos, undoStack>>

MaxLen == 3

TypeOK ==
  /\ docLen \in 0..MaxLen
  /\ editingText \in 0..MaxLen
  /\ cursorPos \in 0..MaxLen
  /\ undoStack \in Seq(0..MaxLen)

Init ==
  /\ docLen = 1
  /\ editingText = 1        \* view starts faithful to the node
  /\ cursorPos = 1
  /\ undoStack = << >>

(* Edit the active node: push the old doc length, adopt a new text length.  *)
(* Every ordinary reducer path keeps the view faithful, so the buffer and   *)
(* caret follow the new text.                                               *)
Edit(newLen) ==
  /\ newLen \in 0..MaxLen
  /\ newLen # docLen
  /\ undoStack' = Append(undoStack, docLen)
  /\ docLen' = newLen
  /\ editingText' = newLen
  /\ cursorPos' = newLen
  /\ UNCHANGED << >>

(* Undo: restore the previous document length. reconcileView keeps the      *)
(* active node (always present here), so it returns the view UNCHANGED under *)
(* the current code; the proposed fix re-derives the buffer + caret.        *)
Undo ==
  /\ Len(undoStack) > 0
  /\ LET prev == undoStack[Len(undoStack)] IN
       /\ docLen' = prev
       /\ IF ReconcileRefreshesBuffer
            THEN /\ editingText' = prev
                 /\ cursorPos' = IF cursorPos <= prev THEN cursorPos ELSE prev
            ELSE /\ editingText' = editingText   \* stale buffer kept
                 /\ cursorPos' = cursorPos        \* stale caret kept
  /\ undoStack' = SubSeq(undoStack, 1, Len(undoStack) - 1)

Next ==
  \/ \E n \in 0..MaxLen : Edit(n)
  \/ Undo

Spec == Init /\ [][Next]_vars

(*************************** Invariant under test ***************************)
(* The view faithfully mirrors the active node:                            *)
(*   (I1) the edit buffer equals the node's text, and                      *)
(*   (I2) the caret is within the node's text.                             *)
(* Under the current code (ReconcileRefreshesBuffer = FALSE) an            *)
(* Edit-then-Undo trace violates this; under the fix (TRUE) it holds.       *)
ViewFaithful ==
  /\ editingText = docLen
  /\ cursorPos <= docLen

=============================================================================
