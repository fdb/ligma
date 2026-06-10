#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Ligma local dev: WASM engine + worker (port 8787) + vite (port 5173).

[[ -d apps/web/node_modules ]] || (cd apps/web && npm install)
[[ -d apps/worker/node_modules ]] || (cd apps/worker && npm install)

# Build the engine if the generated package is missing.
[[ -d apps/web/src/engine/pkg ]] || (cd apps/web && npm run wasm)

# Apply the local D1 schema (idempotent CREATE TABLE IF NOT EXISTS).
(cd apps/worker && npm run --silent db:local > /dev/null)

trap 'kill $(jobs -p) 2> /dev/null' EXIT INT TERM

(cd apps/worker && npx wrangler dev) &
(cd apps/web && npx vite) &

echo
echo "ligma dev: editor on http://localhost:5173 (api on :8787)"
echo

wait
