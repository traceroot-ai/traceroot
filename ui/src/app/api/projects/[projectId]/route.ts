/**
 * API route for getting a single project by ID.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string }> }
) {
  const { projectId } = await params;

  try {
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        deleted_at: null,
      },
      include: {
        organization: {
          select: {
            id: true,
            name: true,
          },
        },
      },
    });

    if (!project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      id: project.id,
      org_id: project.org_id,
      name: project.name,
      retention_days: project.retention_days,
      created_at: project.created_at.toISOString(),
      updated_at: project.updated_at.toISOString(),
      organization: project.organization,
    });
  } catch (error) {
    console.error("Error fetching project:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
