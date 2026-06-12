#!/usr/bin/env bash
# Cloudflare Workers Builds entrypoint.
#
# The build image ships Node but no Rust toolchain, and the WASM engine
# (apps/web/src/engine/pkg/) is gitignored. So we install Rust + wasm-pack,
# build the engine, then build the frontend into apps/web/dist — which is what
# `wrangler deploy` uploads as static assets.
set -euo pipefail

# Run from the repo root regardless of the configured build root directory.
cd "$(dirname "$0")/.."

# --- Rust toolchain (not preinstalled in the Workers build image) ---
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal
fi
# shellcheck disable=SC1091
source "$HOME/.cargo/env"
rustup target add wasm32-unknown-unknown

# --- wasm-pack (fetches a prebuilt binary, ~seconds) ---
if ! command -v wasm-pack >/dev/null 2>&1; then
  curl -sSf https://rustwasm.github.io/wasm-pack/installer/init.sh | sh
fi

# --- Build the WASM engine, then the frontend ---
cd apps/web
npm ci
npm run wasm
npm run build
