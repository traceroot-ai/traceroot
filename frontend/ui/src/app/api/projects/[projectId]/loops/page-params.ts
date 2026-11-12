import type { NextRequest } from "next/server";

/** `page` (0-based) and `limit` (1-200, default 50) as the other list routes read them. */
export function readPaging(req: NextRequest, defaultLimit = 50) {
  const { searchParams } = req.nextUrl;
  const rawLimit = parseInt(searchParams.get("limit") ?? String(defaultLimit), 10);
  const rawPage = parseInt(searchParams.get("page") ?? "0", 10);
  return {
    limit: isNaN(rawLimit) ? defaultLimit : Math.min(Math.max(rawLimit, 1), 200),
    page: isNaN(rawPage) ? 0 : Math.max(rawPage, 0),
  };
}
