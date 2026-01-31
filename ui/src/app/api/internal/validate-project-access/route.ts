/**
 * Internal API endpoint for Python backend to validate project access.
 * This allows the Python backend to verify a user has access to a project
 * without needing to query the database directly.
 */
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(request: NextRequest) {
  const projectId = request.nextUrl.searchParams.get("project_id");
  const userId = request.headers.get("x-user-id");

  if (!projectId) {
    return NextResponse.json(
      { error: "Missing project_id parameter" },
      { status: 400 }
    );
  }

  if (!userId) {
    return NextResponse.json(
      { error: "Missing x-user-id header" },
      { status: 401 }
    );
  }

  try {
    // Find the project
    const project = await prisma.project.findFirst({
      where: {
        id: projectId,
        deleted_at: null,
      },
      select: {
        id: true,
        org_id: true,
        name: true,
      },
    });

    if (!project) {
      return NextResponse.json(
        { error: "Project not found" },
        { status: 404 }
      );
    }

    // Check if user is a member of the organization
    const membership = await prisma.organizationMembership.findFirst({
      where: {
        org_id: project.org_id,
        user_id: userId,
      },
      select: {
        id: true,
        role: true,
      },
    });

    if (!membership) {
      return NextResponse.json(
        { error: "No access to this project" },
        { status: 403 }
      );
    }

    // Return success with project and membership info
    return NextResponse.json({
      project_id: project.id,
      project_name: project.name,
      org_id: project.org_id,
      user_id: userId,
      role: membership.role,
    });
  } catch (error) {
    console.error("Error validating project access:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
