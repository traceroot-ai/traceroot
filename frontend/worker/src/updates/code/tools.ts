import { Type } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";
import type { CodeChangesGather } from "./code-changes.js";

/**
 * The agent's two tools for the code changes section. Both read from what was
 * gathered before the agent started; the second reads a file from the
 * read-only copy, which exists only when the clone worked. Both return text the
 * agent receives as customer data.
 */

export const GET_CODE_CHANGES: Tool = {
  name: "get_code_changes",
  description:
    "What merged or shipped in this window, set beside the traffic: merged pull requests and releases with their links, how traffic on each commit compares, how the join was made, and whether the code could be read or only the host's metadata. Use correlation wording only.",
  parameters: Type.Object({}),
};

export const READ_REPO_FILE: Tool = {
  name: "read_repo_file",
  description:
    "The first lines of a file the window's changes touched, from the read-only copy of the repository. For your reading only: never quote code in the update.",
  parameters: Type.Object({ path: Type.String() }),
};

export function codeChangesTools(gather: CodeChangesGather) {
  const tools: { tool: Tool; run: (args: Record<string, unknown>) => Promise<string> }[] = [
    { tool: GET_CODE_CHANGES, run: async () => JSON.stringify(gather.report) },
  ];
  if (gather.reader) {
    const reader = gather.reader;
    tools.push({
      tool: READ_REPO_FILE,
      run: async (args) => reader.readFile(String(args.path ?? ""), 120),
    });
  }
  return tools;
}
