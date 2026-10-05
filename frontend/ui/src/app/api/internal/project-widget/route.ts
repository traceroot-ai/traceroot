import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@traceroot/core";
import { verifyInternalSecret } from "@/lib/auth-helpers";

const projectWidgetSchema = z.object({
  // The string-typed error covers missing/wrong-type input too, so the
  // surfaced message is deterministic whether the field is absent or empty.
  projectId: z.string("projectId is required").min(1, "projectId is required"),
  widgetId: z.string("widgetId is required").min(1, "widgetId is required"),
});

// POST /api/internal/project-widget
//
// Fetches one saved widget with its dashboard's id and name (the public
// `get_widget` read, and the definition `get_widget_data` runs), given a
// projectId the caller has ALREADY resolved from an authenticated credential.
// The lookup is scoped through the dashboard's project id, so a widget on
// another project's dashboard simply isn't found (404) — the same 404 an
// unknown id gets, so ids never leak existence across projects. Trust is the
// X-Internal-Secret plus the backend's verified project scope. Never log ids.
export async function POST(request: NextRequest) {
  if (!verifyInternalSecret(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const result = projectWidgetSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json({ error: result.error.issues[0].message }, { status: 400 });
  }

  const { projectId, widgetId } = result.data;

  const widget = await prisma.widget.findFirst({
    where: { id: widgetId, dashboard: { projectId } },
    select: {
      id: true,
      title: true,
      type: true,
      spec: true,
      displayConfig: true,
      createTime: true,
      updateTime: true,
      dashboard: { select: { id: true, name: true } },
    },
  });
  if (!widget) {
    return NextResponse.json({ error: "Widget not found" }, { status: 404 });
  }

  return NextResponse.json({ widget });
}
