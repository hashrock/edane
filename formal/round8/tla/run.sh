#!/usr/bin/env bash
# Model-check the note lifecycle (load → login → render → edit → autosave).
# -deadlock: reaching the finite edit cap / a resolved terminal state is an
# intended idle, not a bug.
set -euo pipefail
cd "$(dirname "$0")"
echo "== safety (Spec) — expect: No error =="
tlc -deadlock -config Autosave.cfg Autosave.tla
echo; echo "== liveness happy path (SpecHappy) — expect: No error =="
tlc -deadlock -config AutosaveLive.cfg Autosave.tla
echo; echo "== FINDING: no retry on failed autosave (Spec) — expect: violation =="
tlc -deadlock -config AutosaveRace.cfg Autosave.tla || true
echo; echo "== FINDING: out-of-order save completion (SpecHappy) — expect: violation =="
tlc -deadlock -config AutosaveRaceHappy.cfg Autosave.tla || true
echo; echo "== FIXED (version guard + retry) — expect: No error incl. BaselineConsistent =="
tlc -deadlock -config AutosaveFixed.cfg Autosave.tla
