#!/usr/bin/env bash
# Verify the viewport affine-transform properties with Z3.
set -euo pipefail
cd "$(dirname "$0")"
z3 viewport.smt2
