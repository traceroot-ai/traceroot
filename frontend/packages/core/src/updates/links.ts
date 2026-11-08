/** Links into the app that an update may cite; built here so no one guesses a URL. */
export interface UpdateLinks {
  dashboard: string;
  traces: string;
  signals: string;
}

const project = (appBaseUrl: string, projectId: string) =>
  `${appBaseUrl.replace(/\/+$/, "")}/projects/${encodeURIComponent(projectId)}`;

export function updateLinks(appBaseUrl: string, projectId: string): UpdateLinks {
  const base = project(appBaseUrl, projectId);
  return { dashboard: `${base}/dashboard`, traces: `${base}/traces`, signals: `${base}/signals` };
}

export function traceLink(appBaseUrl: string, projectId: string, traceId: string): string {
  return `${project(appBaseUrl, projectId)}/traces?traceId=${encodeURIComponent(traceId)}`;
}

export function signalLink(appBaseUrl: string, projectId: string, signalId: string): string {
  return `${project(appBaseUrl, projectId)}/signals?signalId=${encodeURIComponent(signalId)}`;
}
