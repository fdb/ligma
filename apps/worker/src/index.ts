import { DurableObject } from "cloudflare:workers";
import { Hono } from "hono";

type Bindings = {
  DB: D1Database;
  DOCS: R2Bucket;
  DOCUMENT: DurableObjectNamespace<DocumentObject>;
};

const ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_DOC_BYTES = 10 * 1024 * 1024;
const EMPTY_DOC = '{"nodes":[],"next_id":1}';

const docKey = (id: string, version: number) => `docs/${id}/v${version}.json`;

// 16 chars × 5 bits = 80 bits of entropy; unbiased because 32 divides 256.
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
function generateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((b) => ALPHABET[b & 31]).join("");
}

type PeerMeta = { id: string; name: string; color: string };

/**
 * One Durable Object per document: the single-writer authority for its
 * content. It serializes version bumps (concurrent saves cannot race)
 * and hosts the document's WebSocket presence sessions: live cursors
 * plus "a new version was saved" notifications that let other editors
 * refresh. Content stays in R2, metadata in D1.
 */
export class DocumentObject extends DurableObject<Bindings> {
  /** WebSocket join: /api/documents/:id/ws?name=…&color=… */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const meta: PeerMeta = {
      id: crypto.randomUUID().slice(0, 8),
      name: (url.searchParams.get("name") ?? "Guest").slice(0, 40),
      color: (url.searchParams.get("color") ?? "#0ea5e9").slice(0, 16),
    };
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation API: the runtime may evict this object between
    // messages; the attachment survives and identifies the peer.
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment(meta);
    server.send(JSON.stringify({ t: "hello", id: meta.id }));
    this.broadcast({ t: "join", ...meta }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > 1024) return;
    let msg: { t?: string; x?: number; y?: number };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const meta = ws.deserializeAttachment() as PeerMeta | null;
    if (!meta) return;
    if (msg.t === "cursor" && typeof msg.x === "number" && typeof msg.y === "number") {
      this.broadcast({ t: "cursor", ...meta, x: msg.x, y: msg.y }, ws);
    }
  }

  webSocketClose(ws: WebSocket) {
    const meta = ws.deserializeAttachment() as PeerMeta | null;
    if (meta) this.broadcast({ t: "leave", id: meta.id }, ws);
  }

  webSocketError(ws: WebSocket) {
    this.webSocketClose(ws);
  }

  /** Broadcast an app-level event (e.g. comments changed) to all
   * presence sessions. Called by HTTP routes through the stub. */
  async notify(msg: unknown): Promise<void> {
    this.broadcast(msg);
  }

  private broadcast(msg: unknown, except?: WebSocket) {
    const s = JSON.stringify(msg);
    for (const sock of this.ctx.getWebSockets()) {
      if (sock === except) continue;
      try {
        sock.send(s);
      } catch {
        // Peer already gone; close events clean it up.
      }
    }
  }

  async load(id: string): Promise<{ status: number; body: string }> {
    const row = await this.env.DB.prepare(
      "SELECT current_version FROM documents WHERE id = ?",
    )
      .bind(id)
      .first<{ current_version: number }>();
    if (!row) return { status: 404, body: "not found" };
    if (row.current_version === 0) return { status: 200, body: EMPTY_DOC };

    const obj = await this.env.DOCS.get(docKey(id, row.current_version));
    if (!obj) return { status: 404, body: "not found" };
    return { status: 200, body: await obj.text() };
  }

  async save(id: string, body: string, session?: string): Promise<void> {
    const row = await this.env.DB.prepare(
      "SELECT current_version FROM documents WHERE id = ?",
    )
      .bind(id)
      .first<{ current_version: number }>();
    const version = (row?.current_version ?? 0) + 1;

    // Blob first, then metadata: if the metadata write fails, the previous
    // version stays current and the orphaned blob is harmless.
    await this.env.DOCS.put(docKey(id, version), body);
    await this.env.DB.prepare(
      `INSERT INTO documents (id, name, current_version, size)
       VALUES (?1, ?1, ?2, ?3)
       ON CONFLICT(id) DO UPDATE SET
         updated_at = datetime('now'),
         current_version = ?2,
         size = ?3`,
    )
      .bind(id, version, body.length)
      .run();

    // Tell the other live editors a new version exists (the saver is
    // excluded via its presence session id).
    const saver = session
      ? this.ctx
          .getWebSockets()
          .find((s) => (s.deserializeAttachment() as PeerMeta | null)?.id === session)
      : undefined;
    this.broadcast({ t: "version", v: version }, saver);
  }
}

const app = new Hono<{ Bindings: Bindings }>();

const docStub = (c: { env: Bindings }, id: string) =>
  c.env.DOCUMENT.get(c.env.DOCUMENT.idFromName(id));

app.get("/api/health", (c) => c.text("ok"));

app.get("/api/documents", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT id, name, created_at, updated_at, current_version, size FROM documents ORDER BY updated_at DESC",
  ).all();
  return c.json(results);
});

app.post("/api/documents", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const name =
    typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 120) : "Untitled";
  const id = generateId();
  await c.env.DB.prepare("INSERT INTO documents (id, name) VALUES (?, ?)")
    .bind(id, name)
    .run();
  // Touch the Durable Object so the document's authority exists from birth.
  await docStub(c, id).load(id);
  return c.json({ id, name }, 201);
});

app.get("/api/documents/:id/meta", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.text("invalid document id", 400);
  const row = await c.env.DB.prepare(
    "SELECT id, name, created_at, updated_at, current_version, size FROM documents WHERE id = ?",
  )
    .bind(id)
    .first();
  if (!row) return c.text("not found", 404);
  return c.json(row);
});

app.patch("/api/documents/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.text("invalid document id", 400);
  const body = await c.req.json().catch(() => ({}));
  const name = typeof body?.name === "string" ? body.name.trim().slice(0, 120) : "";
  if (!name) return c.text("name required", 400);
  const result = await c.env.DB.prepare("UPDATE documents SET name = ? WHERE id = ?")
    .bind(name, id)
    .run();
  if (!result.meta.changes) return c.text("not found", 404);
  return c.body(null, 204);
});

const ASSET_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const MAX_ASSET_BYTES = 8 * 1024 * 1024;

// Image assets are content-addressed: the id is a hash of the bytes, so
// re-uploading the same image (in any document) dedupes in R2.
app.post("/api/assets", async (c) => {
  const type = c.req.header("Content-Type") ?? "";
  if (!ASSET_TYPES.includes(type)) return c.text("unsupported image type", 415);
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return c.text("empty body", 400);
  if (bytes.byteLength > MAX_ASSET_BYTES) return c.text("image too large", 413);

  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await c.env.DOCS.put(`assets/${hash}`, bytes, {
    httpMetadata: { contentType: type },
  });
  return c.json({ hash }, 201);
});

app.get("/api/assets/:hash", async (c) => {
  const hash = c.req.param("hash");
  if (!/^[0-9a-f]{32}$/.test(hash)) return c.text("invalid asset id", 400);
  const obj = await c.env.DOCS.get(`assets/${hash}`);
  if (!obj) return c.text("not found", 404);
  return c.body(obj.body, 200, {
    "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream",
    // Content-addressed: safe to cache forever.
    "Cache-Control": "public, max-age=31536000, immutable",
  });
});

// ----- comments (pinned to canvas world coordinates) -----

app.get("/api/documents/:id/comments", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.text("invalid document id", 400);
  const { results } = await c.env.DB.prepare(
    "SELECT id, x, y, body, author, color, resolved, created_at FROM comments WHERE doc_id = ? ORDER BY created_at",
  )
    .bind(id)
    .all();
  return c.json(results);
});

app.post("/api/documents/:id/comments", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.text("invalid document id", 400);
  const b = await c.req.json().catch(() => null);
  const body = typeof b?.body === "string" ? b.body.trim().slice(0, 2000) : "";
  if (!body || typeof b.x !== "number" || typeof b.y !== "number") {
    return c.text("x, y and body required", 400);
  }
  const author = typeof b.author === "string" ? b.author.slice(0, 40) : "Guest";
  const color = typeof b.color === "string" ? b.color.slice(0, 16) : "#0ea5e9";
  const cid = crypto.randomUUID();
  await c.env.DB.prepare(
    "INSERT INTO comments (id, doc_id, x, y, body, author, color) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(cid, id, b.x, b.y, body, author, color)
    .run();
  await docStub(c, id).notify({ t: "comments" });
  return c.json({ id: cid }, 201);
});

app.patch("/api/documents/:id/comments/:cid", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.text("invalid document id", 400);
  const b = await c.req.json().catch(() => ({}));
  if (typeof b?.resolved !== "boolean") return c.text("resolved required", 400);
  const result = await c.env.DB.prepare(
    "UPDATE comments SET resolved = ? WHERE id = ? AND doc_id = ?",
  )
    .bind(b.resolved ? 1 : 0, c.req.param("cid"), id)
    .run();
  if (!result.meta.changes) return c.text("not found", 404);
  await docStub(c, id).notify({ t: "comments" });
  return c.body(null, 204);
});

// Presence WebSocket: forwarded straight to the document's Durable Object.
app.get("/api/documents/:id/ws", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.text("invalid document id", 400);
  return docStub(c, id).fetch(c.req.raw);
});

app.get("/api/documents/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.text("invalid document id", 400);
  const { status, body } = await docStub(c, id).load(id);
  return c.body(body, status as 200 | 404, {
    "Content-Type": status === 200 ? "application/json" : "text/plain",
  });
});

app.put("/api/documents/:id", async (c) => {
  const id = c.req.param("id");
  if (!ID_RE.test(id)) return c.text("invalid document id", 400);

  const body = await c.req.text();
  if (body.length > MAX_DOC_BYTES) return c.text("document too large", 413);
  try {
    JSON.parse(body);
  } catch {
    return c.text("document must be valid JSON", 400);
  }

  await docStub(c, id).save(id, body, c.req.query("session"));
  return c.body(null, 204);
});

export default app;
