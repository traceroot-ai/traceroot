/**
 * Span-tree renderer for `traceroot traces get`.
 *
 * Renders a depth-first tree of spans using box-drawing characters.
 * Output is a plain string so callers can write it to stdout or capture it
 * in tests without mocking any I/O.
 */

export interface SpanNode {
  spanId: string;
  name: string;
  service?: string;
  durationMs?: number;
  status?: "ok" | "error" | "unset";
  children: SpanNode[];
}

const BRANCH = "├── ";
const LAST = "└── ";
const PIPE = "│   ";
const SPACE = "    ";
const MAX_DEPTH = 200;

/**
 * Render a span tree to a multi-line string ending with "\n".
 */
export function renderTree(root: SpanNode): string {
  const lines: string[] = [];
  renderNode(root, "", true, lines, true);
  return lines.join("\n") + "\n";
}

function renderNode(
  node: SpanNode,
  prefix: string,
  isLast: boolean,
  lines: string[],
  isRoot: boolean,
  depth = 0,
): void {
  if (depth > MAX_DEPTH) {
    lines.push(`${prefix}... (truncated, max depth ${MAX_DEPTH})`);
    return;
  }

  const label = formatLabel(node);

  if (isRoot) {
    lines.push(label);
  } else {
    lines.push(`${prefix}${isLast ? LAST : BRANCH}${label}`);
  }

  const childPrefix = isRoot ? "" : prefix + (isLast ? SPACE : PIPE);
  node.children.forEach((child, idx) => {
    renderNode(child, childPrefix, idx === node.children.length - 1, lines, false, depth + 1);
  });
}

function formatLabel(node: SpanNode): string {
  const parts: string[] = [node.name];
  if (node.service) parts.push(`[${node.service}]`);
  if (node.durationMs !== undefined) parts.push(`${node.durationMs}ms`);
  if (node.status === "error") parts.push("ERROR");
  return parts.join(" ");
}
