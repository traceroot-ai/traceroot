/** The latest successfully received telemetry across a workspace's active projects. */
export function latestProjectIngestion(projects: { lastIngestedAt: Date | null }[]): Date | null {
  return projects.reduce<Date | null>((latest, project) => {
    const received = project.lastIngestedAt;
    return received && (!latest || received > latest) ? received : latest;
  }, null);
}
