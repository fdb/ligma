# Ligma

A lightweight Figma. Rust core compiled to WASM (`crates/ligma-core`), React
chrome (`apps/web`), Hono on Cloudflare Workers (`apps/worker`, D1 + R2).
Figma 1.0 feature scope only. Zinc grays + sky accent, early-web-tool feel.

## Architecture rules

- The engine owns all document state, tools, camera, hit-testing, undo, and
  rendering. React forwards input events and reads scene snapshots (generation
  counter); it never mutates document data itself.
- The server treats documents as opaque, versioned JSON blobs: immutable R2
  objects (`docs/{id}/v{n}.json`) + a `current_version` pointer in D1. All
  content reads/writes go through one Durable Object per document (the
  future multiplayer authority); routes are `/` (file browser) and
  `/d/:id` (editor, TanStack Router).
- After changing `ligma-core`, rebuild WASM: `cd apps/web && npm run wasm`.

## Testing — REQUIRED before handing off code

Only hand off code that has been tested. "It compiles" is not tested.

- E2E (real browser + real worker): `cd apps/web && npx playwright test`
  Run this for ANY change touching engine rendering, pointer interaction, or
  the API. Headless engine tests cannot catch render-path or JS-interop bugs.
- Engine smoke tests (fast, headless): `cd apps/web && node smoke.mjs`
  (requires `wrangler dev` running in `apps/worker`).
- Worker typecheck: `cd apps/worker && npm run typecheck`.
