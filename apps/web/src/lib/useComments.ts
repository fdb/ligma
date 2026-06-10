import { useCallback, useEffect, useState } from "react";
import { identity } from "./usePresence";

export interface CommentRow {
  id: string;
  x: number; // world coordinates
  y: number;
  body: string;
  author: string;
  color: string;
  resolved: number;
  created_at: string;
}

/** Anchored canvas comments, fetched from D1 through the worker. The
 * presence socket pushes a "comments" event whenever anyone posts or
 * resolves one — wire its callback to `refetch`. */
export function useComments(docId: string) {
  const [comments, setComments] = useState<CommentRow[]>([]);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/documents/${docId}/comments`);
      if (res.ok) setComments(await res.json());
    } catch {
      /* transient; the next event retries */
    }
  }, [docId]);

  useEffect(() => {
    refetch();
  }, [refetch]);

  const addComment = useCallback(
    async (x: number, y: number, body: string) => {
      const me = identity();
      await fetch(`/api/documents/${docId}/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ x, y, body, author: me.name, color: me.color }),
      }).catch(() => {});
      refetch();
    },
    [docId, refetch],
  );

  const resolveComment = useCallback(
    async (id: string) => {
      await fetch(`/api/documents/${docId}/comments/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resolved: true }),
      }).catch(() => {});
      refetch();
    },
    [docId, refetch],
  );

  return { comments, addComment, resolveComment, refetch };
}
