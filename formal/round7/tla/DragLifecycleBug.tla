---------------------------- MODULE DragLifecycleBug ----------------------------
(***************************************************************************)
(* TLA+ model of edane's drag & drop node-move pointer lifecycle           *)
(* (app/components/MindmapEditor.tsx: the mousedown / mousemove / stage    *)
(* mouseup / window mouseup handlers).                                     *)
(*                                                                         *)
(* The canvas arms a drag on mousedown, promotes it past a threshold on    *)
(* the first real move (building the preview), tracks a drop target, and   *)
(* ends on release. Two release handlers exist:                            *)
(*   - the Konva STAGE "mouseup" — fires only for a release OVER the       *)
(*     canvas, and (because DOM events bubble container→window) always     *)
(*     BEFORE the window listener. It clears the preview and COMMITS the    *)
(*     move iff the drag actually moved and resolved a valid drop target.  *)
(*   - a WINDOW "mouseup" — the fallback for a release OFF the canvas.      *)
(*     It clears the preview and cancels; it NEVER commits.                *)
(* For an over-canvas release the window handler still fires, but by then  *)
(* dragState is null so it early-returns (a no-op) — modelled by having     *)
(* the over-canvas release be a single atomic step.                        *)
(*                                                                         *)
(* Safety we want:                                                         *)
(*   - the preview is never left "stuck" shown with no active drag;        *)
(*   - the preview only shows during a real (moved) move-drag;             *)
(*   - a text drag never shows the move preview and never commits;         *)
(*   - the model is committed ONLY by an over-canvas release of a moved     *)
(*     move-drag with a valid drop — never on cancel, never twice.         *)
(* Liveness: every started drag eventually returns to idle.                *)
(***************************************************************************)
EXTENDS Naturals

CONSTANT MaxCommits          \* bound `commits` so the state space is finite

VARIABLES
  dragMode,   \* "none" | "text" | "move"
  moved,      \* crossed the drag threshold?
  drop,       \* "none" | "valid"  (resolved drop target while moving)
  preview,    \* "cleared" | "shown"  (the dragLayer ghost/marker)
  commits     \* number of committed moves (model mutations)

vars == <<dragMode, moved, drop, preview, commits>>

TypeOK ==
  /\ dragMode \in {"none", "text", "move"}
  /\ moved \in BOOLEAN
  /\ drop \in {"none", "valid"}
  /\ preview \in {"cleared", "shown"}
  /\ commits \in 0..MaxCommits

Init ==
  /\ dragMode = "none"
  /\ moved = FALSE
  /\ drop = "none"
  /\ preview = "cleared"
  /\ commits = 0

(* mousedown on a non-editing, non-root node arms a MOVE drag. Guarded by
   commits < MaxCommits only to keep the model finite. *)
MouseDownMove ==
  /\ dragMode = "none"
  /\ commits < MaxCommits
  /\ dragMode' = "move"
  /\ moved' = FALSE
  /\ drop' = "none"
  /\ preview' = "cleared"      \* ghost is built later, on the first real move
  /\ UNCHANGED commits

(* mousedown on the edited node (or root) arms a TEXT-selection drag. *)
MouseDownText ==
  /\ dragMode = "none"
  /\ commits < MaxCommits
  /\ dragMode' = "text"
  /\ moved' = FALSE
  /\ drop' = "none"
  /\ preview' = "cleared"
  /\ UNCHANGED commits

(* First move past the threshold on a MOVE drag: build the preview and resolve
   a drop target (which may be none or valid). *)
ThresholdMove ==
  /\ dragMode = "move"
  /\ moved = FALSE
  /\ moved' = TRUE
  /\ preview' = "shown"
  /\ drop' \in {"none", "valid"}
  /\ UNCHANGED <<dragMode, commits>>

(* First move on a TEXT drag: dispatches dragSelect. No preview, no model change. *)
ThresholdText ==
  /\ dragMode = "text"
  /\ moved = FALSE
  /\ moved' = TRUE
  /\ UNCHANGED <<dragMode, drop, preview, commits>>

(* Subsequent moves on a MOVE drag re-resolve the drop target. *)
MoveUpdate ==
  /\ dragMode = "move"
  /\ moved = TRUE
  /\ drop' \in {"none", "valid"}
  /\ preview' = "shown"
  /\ UNCHANGED <<dragMode, moved, commits>>

(* Release OVER the canvas: the stage mouseup. Clears the preview, and commits
   iff this is a moved move-drag with a valid drop. The window handler that also
   fires is a no-op (dragState already cleared), so this is one atomic step. *)
ReleaseOver ==
  /\ dragMode # "none"
  /\ preview' = "cleared"
  /\ commits' = IF dragMode = "move" /\ moved /\ drop = "valid"
                THEN commits + 1
                ELSE commits
  /\ dragMode' = "none"
  /\ moved' = FALSE
  /\ drop' = "none"

(* Release OFF the canvas: only the window mouseup runs. Clears the preview and
   cancels — never commits. *)
ReleaseOff ==
  /\ dragMode # "none"
  /\ preview' = preview             \* MUTANT: forgot to clear the preview
  /\ commits' = commits             \* cancel never mutates the model
  /\ dragMode' = "none"
  /\ moved' = FALSE
  /\ drop' = "none"

Release == ReleaseOver \/ ReleaseOff

Next ==
  \/ MouseDownMove
  \/ MouseDownText
  \/ ThresholdMove
  \/ ThresholdText
  \/ MoveUpdate
  \/ Release

Spec == Init /\ [][Next]_vars /\ WF_vars(Release)

-----------------------------------------------------------------------------
(* Safety invariants *)

\* No stuck preview: with no drag in progress, the preview is always cleared.
NoStuckPreview == (dragMode = "none") => (preview = "cleared")

\* The move preview shows only during a real (threshold-crossed) move drag.
PreviewOnlyWhileMoving == (preview = "shown") => (dragMode = "move" /\ moved)

\* A text-selection drag never shows the move preview.
TextNeverPreviews == (dragMode = "text") => (preview = "cleared")

(* Action property: the model is committed ONLY by a step taken from a moved
   move-drag with a valid drop (i.e. ReleaseOver's commit branch). This rules
   out a commit on cancel (ReleaseOff) or on an unmoved / no-target drop. *)
CommitOnlyOnValidDrop ==
  [][ commits' > commits =>
        (dragMode = "move" /\ moved /\ drop = "valid") ]_vars

(* Liveness: every started drag eventually returns to idle (no drag gets
   stuck forever). Needs the WF_vars(Release) fairness in Spec. *)
DragTerminates == (dragMode # "none") ~> (dragMode = "none")

=============================================================================
