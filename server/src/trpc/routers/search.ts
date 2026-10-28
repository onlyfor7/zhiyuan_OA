import { z } from "zod";

import { authedProcedure, router } from "../trpc";
import { searchQuery, type SearchType } from "../../modules/search/search";

const SEARCH_TYPES: SearchType[] = [
  "project",
  "task",
  "meeting",
  "travel",
  "funding",
  "expense",
  "decision",
  "quality_issue",
  "weekly_report",
  "time_entry",
  "document",
];

export const searchRouter = router({
  query: authedProcedure
    .input(
      z.object({
        q: z.string().trim().min(1, "关键词必填").max(100),
        types: z.array(z.enum(SEARCH_TYPES as [SearchType, ...SearchType[]])).max(11).optional(),
        cursor: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    )
    .query(({ ctx, input }) => searchQuery(ctx.db, ctx.user, input)),
});
