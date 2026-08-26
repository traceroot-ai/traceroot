/**
 * Dependency-free syntax highlighting for fenced code blocks in rendered markdown.
 *
 * Python and JavaScript are the languages we care about today (the SDK snippets the
 * product emits); TypeScript reuses the JS rules and JSON gets a minimal pass. An
 * unknown/absent language returns a single plain token, so the caller renders the
 * code unstyled rather than mangling it.
 *
 * The palette matches the trace panel's JSON colouring (strings green, numbers blue,
 * constants orange, keywords purple, callables sky) so code reads consistently
 * wherever it appears.
 */

export interface CodeToken {
  text: string;
  cls?: string;
}

export type CodeLang = "python" | "javascript" | "typescript" | "json" | null;

const CLS = {
  comment: "text-muted-foreground italic",
  string: "text-green-700 dark:text-green-400",
  number: "text-blue-600 dark:text-blue-400",
  keyword: "text-purple-600 dark:text-purple-400",
  constant: "text-orange-600 dark:text-orange-400",
  fn: "text-sky-600 dark:text-sky-400",
  key: "text-sky-600 dark:text-sky-400",
} as const;

/**
 * One lexer rule. `re` must use only NON-capturing groups internally — the
 * tokenizer wraps each rule in exactly one capturing group to identify matches.
 */
interface Rule {
  re: string;
  cls: string;
}

const NUMBER = String.raw`\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b`;

const PYTHON: Rule[] = [
  { re: String.raw`#[^\n]*`, cls: CLS.comment },
  // Triple-quoted strings first, so their inner quotes don't start a short string.
  { re: String.raw`[rbfuRBFU]{0,2}(?:"""[\s\S]*?"""|'''[\s\S]*?''')`, cls: CLS.string },
  { re: String.raw`[rbfuRBFU]{0,2}(?:"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')`, cls: CLS.string },
  { re: String.raw`@[A-Za-z_]\w*`, cls: CLS.fn },
  { re: String.raw`\b(?:True|False|None)\b`, cls: CLS.constant },
  {
    re: String.raw`\b(?:def|class|return|if|elif|else|for|while|import|from|as|with|try|except|finally|raise|yield|lambda|pass|break|continue|in|not|and|or|is|async|await|global|nonlocal|assert|del)\b`,
    cls: CLS.keyword,
  },
  { re: NUMBER, cls: CLS.number },
  { re: String.raw`\b[A-Za-z_]\w*(?=\s*\()`, cls: CLS.fn },
];

const JAVASCRIPT: Rule[] = [
  { re: String.raw`//[^\n]*`, cls: CLS.comment },
  { re: String.raw`/\*[\s\S]*?\*/`, cls: CLS.comment },
  { re: "`(?:\\\\.|[^`\\\\])*`", cls: CLS.string },
  { re: String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'`, cls: CLS.string },
  { re: String.raw`\b(?:true|false|null|undefined|NaN|Infinity)\b`, cls: CLS.constant },
  {
    re: String.raw`\b(?:const|let|var|function|return|if|else|for|while|of|in|new|class|extends|implements|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|this|super|switch|case|break|continue|do|delete|void|yield|interface|type|enum|public|private|protected|readonly|as|satisfies|static)\b`,
    cls: CLS.keyword,
  },
  { re: NUMBER, cls: CLS.number },
  { re: String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()`, cls: CLS.fn },
];

const JSON_RULES: Rule[] = [
  { re: String.raw`"(?:\\.|[^"\\])*"(?=\s*:)`, cls: CLS.key },
  { re: String.raw`"(?:\\.|[^"\\])*"`, cls: CLS.string },
  { re: String.raw`\b(?:true|false|null)\b`, cls: CLS.constant },
  { re: String.raw`-?` + NUMBER, cls: CLS.number },
];

const RULES: Record<Exclude<CodeLang, null>, Rule[]> = {
  python: PYTHON,
  javascript: JAVASCRIPT,
  typescript: JAVASCRIPT,
  json: JSON_RULES,
};

const ALIASES: Record<string, Exclude<CodeLang, null>> = {
  py: "python",
  python: "python",
  python3: "python",
  js: "javascript",
  jsx: "javascript",
  javascript: "javascript",
  node: "javascript",
  mjs: "javascript",
  ts: "typescript",
  tsx: "typescript",
  typescript: "typescript",
  json: "json",
};

/** Map a fence's language hint (```py) to a supported lexer, or null if unknown. */
export function normalizeLang(lang: string | null | undefined): CodeLang {
  if (!lang) return null;
  return ALIASES[lang.trim().toLowerCase()] ?? null;
}

/**
 * Tokenize `code` for `lang`. Returns plain (unclassed) tokens for anything the
 * rules don't cover, so concatenating every token's text reproduces the input
 * exactly — highlighting never drops or rewrites source.
 */
export function highlightCode(code: string, lang: CodeLang): CodeToken[] {
  const rules = lang ? RULES[lang] : null;
  if (!rules || !code) return code ? [{ text: code }] : [];

  const re = new RegExp(rules.map((r) => `(${r.re})`).join("|"), "gm");
  const out: CodeToken[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code)) !== null) {
    // Zero-length match would loop forever; bail defensively.
    if (m[0] === "") {
      re.lastIndex += 1;
      continue;
    }
    if (m.index > last) out.push({ text: code.slice(last, m.index) });
    // Exactly one capturing group matches — its position identifies the rule.
    let groupIndex = -1;
    for (let i = 1; i < m.length; i++) {
      if (m[i] !== undefined) {
        groupIndex = i;
        break;
      }
    }
    out.push({ text: m[0], cls: groupIndex > 0 ? rules[groupIndex - 1].cls : undefined });
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push({ text: code.slice(last) });
  return out;
}
