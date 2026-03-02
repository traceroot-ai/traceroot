import { Type } from "@mariozechner/pi-ai";
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Executor } from "../executors/interface.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  truncateTail,
  type TruncationResult,
} from "./truncate.js";

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

const bashSchema = Type.Object({
  label: Type.String({
    description: "Brief description of what this command does (shown to user)",
  }),
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(
    Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
  ),
});

interface BashToolDetails {
  truncation?: TruncationResult;
}

export function createBashTool(executor: Executor): AgentTool<any> {
  return {
    name: "bash",
    label: "bash",
    description:
      `Execute a bash command in the sandbox. The sandbox has jq, grep, cat, and standard Unix tools. ` +
      `Output is truncated to last ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). ` +
      `Working directory is /workspace. No network access.`,
    parameters: bashSchema,
    execute: async (
      _toolCallId: string,
      { command, timeout }: { label: string; command: string; timeout?: number },
      signal?: AbortSignal,
    ): Promise<AgentToolResult<BashToolDetails | undefined>> => {
      if (!executor.isReady()) {
        await executor.init();
      }

      const result = await executor.exec(command, { timeout, signal });

      let output = "";
      if (result.stdout) output += result.stdout;
      if (result.stderr) {
        if (output) output += "\n";
        output += result.stderr;
      }

      // Apply tail truncation (keep end — errors/results are at the bottom)
      const truncation = truncateTail(output);
      let outputText = truncation.content || "(no output)";

      let details: BashToolDetails | undefined;

      if (truncation.truncated) {
        details = { truncation };

        const startLine = truncation.totalLines - truncation.outputLines + 1;
        const endLine = truncation.totalLines;

        if (truncation.lastLinePartial) {
          const lastLineSize = formatSize(
            Buffer.byteLength(output.split("\n").pop() || "", "utf-8"),
          );
          outputText += `\n\n[Showing last ${formatSize(truncation.outputBytes)} of line ${endLine} (line is ${lastLineSize}).]`;
        } else if (truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines}.]`;
        } else {
          outputText += `\n\n[Showing lines ${startLine}-${endLine} of ${truncation.totalLines} (${formatSize(DEFAULT_MAX_BYTES)} limit).]`;
        }
      }

      // Throw on non-zero exit (matches Mom's contract — pi-agent-core expects throws)
      if (result.code !== 0) {
        throw new Error(`${outputText}\n\nCommand exited with code ${result.code}`.trim());
      }

      return { content: [{ type: "text", text: outputText }], details };
    },
  };
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

const readSchema = Type.Object({
  label: Type.String({
    description: "Brief description of what you're reading and why (shown to user)",
  }),
  path: Type.String({ description: "Path to the file to read" }),
  offset: Type.Optional(
    Type.Number({ description: "Line number to start reading from (1-indexed)" }),
  ),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

interface ReadToolDetails {
  truncation?: TruncationResult;
}

export function createReadTool(executor: Executor): AgentTool<any> {
  return {
    name: "read",
    label: "read",
    description:
      `Read the contents of a file. Output is truncated to ${DEFAULT_MAX_LINES} lines or ` +
      `${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files.`,
    parameters: readSchema,
    execute: async (
      _toolCallId: string,
      { path, offset, limit }: { label: string; path: string; offset?: number; limit?: number },
      signal?: AbortSignal,
    ): Promise<AgentToolResult<ReadToolDetails | undefined>> => {
      if (!executor.isReady()) {
        await executor.init();
      }

      // Get total line count first
      const countResult = await executor.exec(`wc -l < ${shellEscape(path)}`, { signal });
      if (countResult.code !== 0) {
        throw new Error(countResult.stderr || `Failed to read file: ${path}`);
      }
      const totalFileLines = parseInt(countResult.stdout.trim(), 10) + 1; // wc -l counts newlines, not lines

      const startLine = offset ? Math.max(1, offset) : 1;

      if (startLine > totalFileLines) {
        throw new Error(`Offset ${offset} is beyond end of file (${totalFileLines} lines total)`);
      }

      // Read content with offset
      let cmd: string;
      if (startLine === 1) {
        cmd = `cat ${shellEscape(path)}`;
      } else {
        cmd = `tail -n +${startLine} ${shellEscape(path)}`;
      }

      const result = await executor.exec(cmd, { signal });
      if (result.code !== 0) {
        throw new Error(result.stderr || `Failed to read file: ${path}`);
      }

      let selectedContent = result.stdout;
      let userLimitedLines: number | undefined;

      // Apply user limit if specified
      if (limit !== undefined) {
        const lines = selectedContent.split("\n");
        const endLine = Math.min(limit, lines.length);
        selectedContent = lines.slice(0, endLine).join("\n");
        userLimitedLines = endLine;
      }

      // Apply truncation (head — keep beginning of file)
      const truncation = truncateHead(selectedContent);

      let outputText: string;
      let details: ReadToolDetails | undefined;

      if (truncation.firstLineExceedsLimit) {
        const firstLineSize = formatSize(
          Buffer.byteLength(selectedContent.split("\n")[0], "utf-8"),
        );
        outputText = `[Line ${startLine} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLine}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
        details = { truncation };
      } else if (truncation.truncated) {
        const endLineDisplay = startLine + truncation.outputLines - 1;
        const nextOffset = endLineDisplay + 1;

        outputText = truncation.content;

        if (truncation.truncatedBy === "lines") {
          outputText += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue]`;
        } else {
          outputText += `\n\n[Showing lines ${startLine}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue]`;
        }
        details = { truncation };
      } else if (userLimitedLines !== undefined) {
        const linesFromStart = startLine - 1 + userLimitedLines;
        if (linesFromStart < totalFileLines) {
          const remaining = totalFileLines - linesFromStart;
          const nextOffset = startLine + userLimitedLines;

          outputText = truncation.content;
          outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue]`;
        } else {
          outputText = truncation.content;
        }
      } else {
        outputText = truncation.content;
      }

      return { content: [{ type: "text", text: outputText }], details };
    },
  };
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

const writeSchema = Type.Object({
  label: Type.String({ description: "Brief description of what you're writing (shown to user)" }),
  path: Type.String({ description: "Path to the file to write" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export function createWriteTool(executor: Executor): AgentTool<any> {
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. " +
      "Automatically creates parent directories.",
    parameters: writeSchema,
    execute: async (
      _toolCallId: string,
      { path, content }: { label: string; path: string; content: string },
      signal?: AbortSignal,
    ): Promise<AgentToolResult<undefined>> => {
      if (!executor.isReady()) {
        await executor.init();
      }

      // Use printf '%s' with shell escaping (matches Mom — safe for special chars)
      const dir = path.includes("/") ? path.substring(0, path.lastIndexOf("/")) : ".";
      const cmd = `mkdir -p ${shellEscape(dir)} && printf '%s' ${shellEscape(content)} > ${shellEscape(path)}`;

      const result = await executor.exec(cmd, { signal });
      if (result.code !== 0) {
        throw new Error(result.stderr || `Failed to write file: ${path}`);
      }

      return {
        content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
        details: undefined,
      };
    },
  };
}
