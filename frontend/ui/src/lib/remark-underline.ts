/**
 * Markdown has no underline syntax — `_x_` and `__x__` are emphasis/strong — and we
 * don't render raw HTML (no rehype-raw), so `<u>…</u>` would otherwise be dropped.
 *
 * This tiny remark plugin pairs the inline `html` nodes remark emits for `<u>` and
 * `</u>` and wraps what's between them in a node that renders as a real `<u>`
 * element (via mdast's `data.hName`). Everything else is left untouched, so no
 * other HTML becomes renderable.
 */

interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

const OPEN = /^<u\s*>$/i;
const CLOSE = /^<\/u\s*>$/i;

const isTag = (node: MdNode, re: RegExp) =>
  node.type === "html" && typeof node.value === "string" && re.test(node.value.trim());

function transform(node: MdNode): void {
  const children = node.children;
  if (!children) return;

  const out: MdNode[] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    if (isTag(child, OPEN)) {
      // Scan forward for the matching close, tolerating nesting.
      const inner: MdNode[] = [];
      let depth = 1;
      let j = i + 1;
      for (; j < children.length; j++) {
        const candidate = children[j];
        if (isTag(candidate, OPEN)) depth++;
        else if (isTag(candidate, CLOSE)) {
          depth--;
          if (depth === 0) break;
        }
        inner.push(candidate);
      }
      if (depth === 0 && j < children.length) {
        inner.forEach(transform);
        // `data.hName` makes mdast-util-to-hast emit <u> for this unknown node.
        out.push({ type: "underline", data: { hName: "u" }, children: inner });
        i = j; // skip the consumed closing tag
        continue;
      }
      // Unbalanced — fall through and leave the node as-is.
    }

    transform(child);
    out.push(child);
  }
  node.children = out;
}

export function remarkUnderline() {
  return (tree: MdNode) => {
    transform(tree);
  };
}
