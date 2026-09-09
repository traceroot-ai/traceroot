import { NextResponse } from "next/server";

// Server-side, cached proxy for the GitHub star count. The widget used to call
// api.github.com directly from every browser, which hits GitHub's unauthenticated
// 60-requests/hour-per-IP limit (everyone behind one office/VPN IP shares it) and
// returns 403 → the widget showed "—". Proxying here means the server makes at most
// one upstream call per hour (Next caches the response) for ALL viewers, and can
// attach a token to lift the limit entirely.
const REPO = "traceroot-ai/traceroot";
const TTL_SECONDS = 3600; // 1 hour

export const revalidate = 3600;

export async function GET() {
  try {
    const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
    if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

    const res = await fetch(`https://api.github.com/repos/${REPO}`, {
      headers,
      next: { revalidate: TTL_SECONDS },
    });
    if (!res.ok) return NextResponse.json({ stars: null });

    const data = (await res.json()) as { stargazers_count?: number };
    const stars = typeof data.stargazers_count === "number" ? data.stargazers_count : null;
    return NextResponse.json({ stars });
  } catch {
    // Never surface an error to the widget — a missing count just renders as "—".
    return NextResponse.json({ stars: null });
  }
}
