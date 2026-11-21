import { z } from 'zod';

/** Cursor pagination for every collection endpoint: `?limit=&cursor=` → `{ data, nextCursor }`. */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** id of the last item of the previous page (ULIDs sort by time) */
  cursor: z.string().optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

export function page<T extends { id: string }>(rows: T[], limit: number) {
  const data = rows.slice(0, limit);
  return { data, nextCursor: rows.length > limit ? data.at(-1)!.id : null };
}
