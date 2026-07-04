#!/usr/bin/env bash
# Model-check the drag & drop lifecycle with TLC. -deadlock disables deadlock
# detection (reaching the finite commit cap is an intended idle, not a bug).
set -euo pipefail
cd "$(dirname "$0")"
echo "== DragLifecycle (expect: No error has been found) =="
tlc -deadlock DragLifecycle.tla
echo
echo "== DragLifecycleBug — mutant (expect: NoStuckPreview violated) =="
tlc -deadlock DragLifecycleBug.tla || true
