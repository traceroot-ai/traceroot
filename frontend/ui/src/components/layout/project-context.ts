// Check if we're in a project context by looking at the path structure.
// Extracted from the sidebar so the route gating is unit-testable without rendering React.
export function getProjectContext(pathname: string): {
  isProject: boolean;
  projectId: string | null;
} {
  // Check if path starts with /projects/[projectId]
  const projectMatch = pathname.match(/^\/projects\/([^/]+)/);
  if (projectMatch) {
    return { isProject: true, projectId: projectMatch[1] };
  }

  return { isProject: false, projectId: null };
}
