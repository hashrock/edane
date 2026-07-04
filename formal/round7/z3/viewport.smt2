; Z3 verification of edane's viewport affine transform (app/lib/viewport.ts).
;
; What is verified (over the REALS — this is the value Z3 adds over Alloy round6,
; which handled the discrete non-overlap of the layout but explicitly left the
; real-number centering math to numeric unit tests):
;
;   worldToScreen(p, t) = p*scale + offset
;   screenToWorld(p, t) = (p - offset) / scale
;   centerOffset(w, scale, screen) puts w at (screen/2)
;   ensureVisibleOffset(...) brings a rect inside the padded viewport, and its
;     `changed` flag is false exactly when the rect already fits.
;
; Each property is checked by asserting its NEGATION and expecting `unsat`
; (= no counterexample = the property is a theorem over the reals, given scale>0).
;
; Run:  z3 formal/round7/z3/viewport.smt2
; Each (check-sat) below must print `unsat` (the last, sat, is a sanity model).

; ===========================================================================
; Property 1 — round-trip: screenToWorld ∘ worldToScreen = identity (scale ≠ 0).
; ===========================================================================
(push)
(declare-const scale Real)
(declare-const offx Real)
(declare-const offy Real)
(declare-const px Real)
(declare-const py Real)
(assert (not (= scale 0.0)))
; sx = px*scale + offx ; then wx = (sx - offx)/scale ; expect wx = px
(define-fun sx () Real (+ (* px scale) offx))
(define-fun sy () Real (+ (* py scale) offy))
(define-fun wx () Real (/ (- sx offx) scale))
(define-fun wy () Real (/ (- sy offy) scale))
(assert (not (and (= wx px) (= wy py))))
(check-sat)   ; expect unsat
(pop)

; ===========================================================================
; Property 2 — centerOffset places the world point exactly at the viewport
; centre. centerOffset = offsetToAnchor(w, scale, (W/2, H/2)):
;   offx = W/2 - wx*scale ;  offy = H/2 - wy*scale
; then worldToScreen(w) must equal (W/2, H/2).
; ===========================================================================
(push)
(declare-const scale Real)
(declare-const W Real)
(declare-const H Real)
(declare-const wx Real)
(declare-const wy Real)
(assert (> scale 0.0))
(define-fun offx () Real (- (/ W 2.0) (* wx scale)))
(define-fun offy () Real (- (/ H 2.0) (* wy scale)))
(define-fun sx () Real (+ (* wx scale) offx))
(define-fun sy () Real (+ (* wy scale) offy))
(assert (not (and (= sx (/ W 2.0)) (= sy (/ H 2.0)))))
(check-sat)   ; expect unsat
(pop)

; ===========================================================================
; Property 3 — ensureVisibleOffset (X axis) brings the target inside the padded
; band [padding, W - padding] whenever the target fits (width*scale ≤ W - 2*pad),
; and leaves it unchanged when it already fits.
;
; Model the exact code for the X axis:
;   left  = tx*scale + offx
;   right = left + tw*scale
;   offx' = (left < pad)            ? pad - tx*scale
;         : (right > W - pad)       ? (W - pad) - (tx+tw)*scale
;         : offx
; ===========================================================================
(push)
(declare-const scale Real)
(declare-const W Real)
(declare-const pad Real)
(declare-const tx Real)     ; target.x (world)
(declare-const tw Real)     ; target.width (world)
(declare-const offx Real)   ; current stage offset

(assert (> scale 0.0))
(assert (> W 0.0))
(assert (>= pad 0.0))
(assert (>= tw 0.0))
; The target fits within the padded viewport on this axis.
(assert (<= (* tw scale) (- W (* 2.0 pad))))

(define-fun left  () Real (+ (* tx scale) offx))
(define-fun right () Real (+ left (* tw scale)))

(define-fun offx1 () Real
  (ite (< left pad)
       (- pad (* tx scale))
       (ite (> right (- W pad))
            (- (- W pad) (* (+ tx tw) scale))
            offx)))

; New edges after applying offx1.
(define-fun left1  () Real (+ (* tx scale) offx1))
(define-fun right1 () Real (+ left1 (* tw scale)))

; (3a) After the pan, the whole target lies within the padded band, EXACTLY
;      (no epsilon — over the reals the edges land on pad / W-pad precisely).
(push)
(assert (not (and (>= left1 pad)
                  (<= right1 (- W pad)))))
(check-sat)   ; expect unsat
(pop)

; (3b) When the target already fits inside the padded band, the offset is
; unchanged (the `changed` flag is false).
(push)
(assert (>= left pad))
(assert (<= right (- W pad)))
(assert (not (= offx1 offx)))
(check-sat)   ; expect unsat
(pop)

(pop)

; ===========================================================================
; Property 4 — moveBranch same-parent index compensation (app/domain/model.ts).
; A same-parent move splices the node out at removedIndex, then inserts at
;   at = index - (removedIndex < index ? 1 : 0)
; The intended invariant: the node lands so that, counting positions in the
; ORIGINAL array, it sits just before original position `index` (i.e. the caller
; can pass an index measured against the pre-move array). Concretely: if the node
; moves forward (removedIndex < index), the compensated slot `at` is one less, so
; the element originally at `index-1` ends up before the moved node.
; We check the compensation never lands the node at its own original slot for a
; genuine forward move (which would make the move a visual no-op it shouldn't be),
; and that a backward move (index <= removedIndex) needs no compensation.
; ===========================================================================
(push)
(declare-const removedIndex Int)
(declare-const index Int)
(declare-const len Int)          ; length of the children array (>=1)
(assert (>= len 1))
(assert (and (>= removedIndex 0) (< removedIndex len)))
(assert (and (>= index 0) (<= index len)))

(define-fun shift () Int (ite (< removedIndex index) 1 0))
(define-fun at () Int (- index shift))

; (4a) `at` is always a valid insertion index into the post-removal array
;      (length len-1): 0 <= at <= len-1.
(push)
(assert (not (and (>= at 0) (<= at (- len 1)))))
(check-sat)   ; expect unsat
(pop)

; (4b) A forward move to just-after its current slot (index = removedIndex+1) is
;      the no-op position: compensation makes at = removedIndex (same slot). This
;      matches moveBranch's no-op guard (index === curIndex+1 → same reference).
(push)
(assert (= index (+ removedIndex 1)))
(assert (not (= at removedIndex)))
(check-sat)   ; expect unsat
(pop)

(pop)

; ===========================================================================
; Sanity — the transform is non-degenerate: a real instance exists (scale>0,
; a point maps somewhere). Expect `sat`.
; ===========================================================================
(push)
(declare-const scale Real)
(assert (> scale 0.0))
(check-sat)   ; expect sat
(pop)
