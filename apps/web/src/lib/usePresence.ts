import { useEffect, useRef, useState } from "react";

/** A remote editor's cursor, in world coordinates. */
export interface Peer {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  t: number; // last-seen timestamp
}

export interface ChatMessage {
  id: string; // sender session id ("me" for own messages)
  name: string;
  color: string;
  body: string;
  ts: number;
}

const COLORS = ["#0ea5e9", "#f59e0b", "#10b981", "#f43f5e", "#8b5cf6", "#06b6d4", "#ec4899"];
const NAMES = ["Lynx", "Otter", "Heron", "Fox", "Ibex", "Wren", "Tern", "Vole", "Stoat"];

export function identity(): { name: string; color: string } {
  const stored = localStorage.getItem("ligma-presence");
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch {
      /* regenerate */
    }
  }
  const me = {
    name: `Guest ${NAMES[Math.floor(Math.random() * NAMES.length)]}`,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
  };
  localStorage.setItem("ligma-presence", JSON.stringify(me));
  return me;
}

/**
 * Joins the document's presence session (a WebSocket on its Durable
 * Object). Streams this editor's cursor out, collects remote cursors,
 * and invokes onRemoteVersion when another editor saves a new version.
 */
export function usePresence(
  docId: string,
  onRemoteVersion: () => void,
  onComments?: () => void,
) {
  const [peers, setPeers] = useState<Record<string, Peer>>({});
  const [chat, setChat] = useState<ChatMessage[]>([]);
  const sessionId = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const lastSent = useRef(0);
  const versionCb = useRef(onRemoteVersion);
  versionCb.current = onRemoteVersion;
  const commentsCb = useRef(onComments);
  commentsCb.current = onComments;

  useEffect(() => {
    const me = identity();
    let closed = false;
    let ws: WebSocket | null = null;
    let retry = 0;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      // `sock` must be a per-connection const: a closed socket's async
      // onclose otherwise nulls the ref after a newer socket replaced it.
      const sock = new WebSocket(
        `${proto}://${location.host}/api/documents/${docId}/ws?name=${encodeURIComponent(me.name)}&color=${encodeURIComponent(me.color)}`,
      );
      ws = sock;
      wsRef.current = sock;
      sock.onmessage = (e) => {
        let msg: Peer & { t: string; v?: number };
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }
        if (msg.t === "hello") {
          sessionId.current = msg.id;
        } else if (msg.t === "cursor") {
          setPeers((p) => ({
            ...p,
            [msg.id]: { id: msg.id, name: msg.name, color: msg.color, x: msg.x, y: msg.y, t: Date.now() },
          }));
        } else if (msg.t === "leave") {
          setPeers(({ [msg.id]: _gone, ...rest }) => rest);
        } else if (msg.t === "version") {
          versionCb.current();
        } else if (msg.t === "comments") {
          commentsCb.current?.();
        } else if (msg.t === "chat") {
          const m = msg as unknown as ChatMessage;
          setChat((c) => [...c.slice(-99), m]);
        }
      };
      sock.onclose = () => {
        if (wsRef.current === sock) wsRef.current = null;
        if (!closed) retry = window.setTimeout(connect, 2000);
      };
    };
    connect();

    // Drop cursors that have been silent for a while (covers peers that
    // vanished without a close frame).
    const prune = window.setInterval(() => {
      setPeers((p) => {
        const now = Date.now();
        const live = Object.entries(p).filter(([, v]) => now - v.t < 30_000);
        return live.length === Object.keys(p).length ? p : Object.fromEntries(live);
      });
    }, 5_000);

    return () => {
      closed = true;
      clearTimeout(retry);
      clearInterval(prune);
      ws?.close();
      wsRef.current = null;
      setPeers({});
      setChat([]);
    };
  }, [docId]);

  /** Throttled cursor report (world coordinates). */
  const reportCursor = (x: number, y: number) => {
    const now = performance.now();
    if (now - lastSent.current < 50) return;
    if (wsRef.current?.readyState !== WebSocket.OPEN) return;
    lastSent.current = now;
    wsRef.current.send(JSON.stringify({ t: "cursor", x, y }));
  };

  /** Sends a chat line and echoes it locally (the server broadcast
   * excludes the sender). */
  const sendChat = (body: string) => {
    const trimmed = body.trim();
    if (!trimmed || wsRef.current?.readyState !== WebSocket.OPEN) return;
    wsRef.current.send(JSON.stringify({ t: "chat", body: trimmed }));
    const me = identity();
    setChat((c) => [
      ...c.slice(-99),
      { id: "me", name: me.name, color: me.color, body: trimmed, ts: Date.now() },
    ]);
  };

  return { peers, chat, sendChat, reportCursor, sessionId };
}
