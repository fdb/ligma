# Ligma

A lightweight Figma — Rust core compiled to WebAssembly, React chrome, Cloudflare backend.

Like Figma's original architecture, the editor core is not JavaScript: the document
model, tools, camera, hit-testing, undo history, and canvas rendering all live in
`ligma-core` (Rust → WASM). React owns only the chrome — panels, toolbar — and
forwards raw input events to the engine, reading back immutable scene snapshots
keyed by a generation counter.

## Layout

```
crates/ligma-core      Editor engine (Rust → WASM via wasm-bindgen)
apps/worker            Hono on Cloudflare Workers — document API + static assets
apps/web               React + Vite + TypeScript + Tailwind frontend
```

`/` is the file browser (anonymous create, recent files); the editor lives at
`/d/:id` (TanStack Router). Creating a file mints an 80-bit random id and a D1
row. All content reads/writes route through a **Durable Object per document**
— the single-writer authority that serializes version bumps today and will own
WebSocket sessions for multiplayer later. Content lives in R2 as versioned,
immutable JSON blobs (`docs/{id}/v{n}.json`); D1 holds metadata and the
`current_version` pointer. Locally, wrangler emulates D1/R2/DOs via Miniflare
— no Cloudflare account needed for development. (If `database_id` in
wrangler.toml ever changes, re-run `npm run db:local`: local D1 state is keyed
by that id.)

Documents carry a `version` field; `load_json` migrates older formats forward
(v1 flat `fill` strings → v2 paint lists) so the format can keep evolving.

## Develop

```sh
./scripts/dev.sh   # installs deps, builds WASM if missing, runs worker + vite
```

Or by hand:

```sh
# 1. Build the engine (rerun after changing ligma-core)
cd apps/web && npm run wasm

# 2. Backend worker (port 8787; first time: npm install && npm run db:local)
cd apps/worker && npm run dev

# 3. Frontend (port 5173, proxies /api to the worker)
cd apps/web && npm install && npm run dev
```

Engine smoke tests (headless, no browser): `cd apps/web && node smoke.mjs`
(requires the worker running for the persistence tests).

## Deploy

```sh
wrangler d1 create ligma          # paste database_id into wrangler.toml
wrangler r2 bucket create ligma-docs
cd apps/worker && npm run db:remote && npm run deploy
```

## Editor

| | |
|---|---|
| `V` `F` `R` `O` `T` `H` | Move, Frame, Rectangle, Ellipse, Text, Hand |
| Drag / click | Draw a shape (click places a default size) |
| `Space`-drag | Pan · scroll pans · `⌘`+scroll / pinch zooms |
| `⌘Z` / `⇧⌘Z` | Undo / redo |
| `⌘G` / `⇧⌘G` | Group / ungroup |
| `⌘D`, `⌫`, arrows | Duplicate, delete, nudge (`⇧` = 10px) |
| `⌥`-drag | Drag a copy (original stays put) |
| Double-click | Edit text in place · rename a frame via its label |
| `⇧1` / `⌘0` | Zoom to fit / 100% |
| `⌘S` | Save now (documents also autosave after edits) |

## Roadmap (Figma 1.0 scope)

- Frame parenting (children clip + move with their frame)
- Gradients and images
- Vector pen tool and boolean operations
- Components and instances
- Multiplayer editing
- Layer drag-reordering
