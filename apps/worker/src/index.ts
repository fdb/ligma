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

/**
 * One Durable Object per document: the single-writer authority for its
 * content. Today that serializes version bumps (concurrent saves cannot
 * race); later it is where WebSocket sessions and the in-memory document
 * live for multiplayer. Content stays in R2, metadata in D1.
 */
export class DocumentObject extends DurableObject<Bindings> {
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

  async save(id: string, body: string): Promise<void> {
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

  await docStub(c, id).save(id, body);
  return c.body(null, 204);
});

export default app;
