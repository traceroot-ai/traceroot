// Single source of truth for the onboarding setup snippets, shared by the AI-tab
// SetupTabs widget and the Manual-tab CliVerifyCard so the two never drift.

/** Read-only CLI flow: install, authenticate, list traces. */
export const CLI_COMMANDS = [
  "npm install -g traceroot-cli",
  "traceroot login",
  "traceroot traces list",
].join("\n");

/** One-prompt instrumentation handoff for any AI coding agent. */
export const INSTRUMENT_PROMPT =
  "Install the TraceRoot AI skill from https://github.com/traceroot-ai/traceroot-skills and use it to add tracing to this application with TraceRoot following best practices.";

/** Install the first-party TraceRoot skills into a coding agent. */
export const SKILLS_COMMAND = "npx skills add traceroot-ai/traceroot-skills";
