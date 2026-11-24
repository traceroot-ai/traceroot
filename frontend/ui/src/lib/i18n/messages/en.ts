// English is the source of truth: every key lives here and other languages fall back to it.
// Keys are grouped by where the text appears; `{name}` marks a value filled in at render time.
export const en = {
  common: {
    cancel: "Cancel",
    create: "Create",
    creating: "Creating...",
    name: "Name",
    created: "Created",
    updated: "Updated",
    settings: "Settings",
    settingsFor: "Settings for {name}",
    viewOnly: "View only",
  },
  nav: {
    home: "Home",
    observe: "Observe",
    traces: "Tracing",
    dashboard: "Dashboard",
    detect: "Detect",
    detectors: "Detectors",
    signals: "Signals",
    alerts: "Alerts",
    verify: "Verify",
    datasets: "Datasets",
    evaluations: "Evaluations",
    workspaces: "Workspaces",
    support: "Support",
    homeLabel: "traceroot home",
  },
  account: {
    menu: "Account menu",
    fallbackName: "User",
    theme: "Theme",
    themeLight: "Light",
    themeDark: "Dark",
    themeSystem: "System",
    language: "Language",
    supportConsole: "Support console",
    activeSessions: "Active sessions",
    logOut: "Log out",
    exitImpersonation: "Exit impersonation",
  },
  workspaces: {
    title: "Workspaces",
    loading: "Loading workspaces...",
    emptyTitle: "No workspaces yet",
    emptyText: "Create your first workspace to get started",
    newWorkspace: "New workspace",
    newDescription: "Create a new workspace to manage your projects and team members.",
    namePlaceholder: "Workspace name",
  },
  projects: {
    title: "Projects",
    loading: "Loading projects...",
    emptyTitle: "No projects yet",
    emptyText: "Create your first project to start tracking traces",
    newProject: "New project",
    createTitle: "Create Project",
    createDescription: "Create a new project to start tracking your AI agent traces.",
    namePlaceholder: "Project name",
  },
};

export type Messages = typeof en;
export type PartialMessages = { [Group in keyof Messages]?: Partial<Messages[Group]> };
export type MessageKey = {
  [Group in keyof Messages]: `${Group}.${Extract<keyof Messages[Group], string>}`;
}[keyof Messages];
