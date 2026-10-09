// Single source of truth for the onboarding snippets, so the getting-started
// panel and anything else that shows a command cannot drift apart.

/**
 * The whole of setup, as one command.
 *
 * `npx -y` rather than a global install: someone reading this has not decided
 * to keep a CLI yet, and asking them to install one before they have seen a
 * trace is a commitment ahead of the payoff. It authenticates in the browser,
 * creates the key, instruments the service with a coding agent, runs the
 * application and waits for the first trace — which is why none of those are
 * separate steps in the panel any more.
 */
export const SETUP_COMMAND = "npx -y traceroot-cli@latest setup";
