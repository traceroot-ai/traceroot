import { ApiClient, REGISTRY } from "@traceroot-ai/tools";
import { describe, expect, it } from "vitest";
import { EXPOSED_TOOLS } from "../exposure.js";
import { SERVER_INSTRUCTIONS } from "../instructions.js";
import { PARAM_DESCRIPTIONS } from "../param-docs.js";
import { buildTools } from "../server.js";

// What an assistant reads decides whether it calls a tool well. These checks
// hold every exposed tool to the same bar, so adding one cannot quietly lower it.

const tools = buildTools(new ApiClient({ baseUrl: "http://backend", headers: {} }));

// Cursor limits a server name plus a tool name to 60 characters, and the server
// is called "traceroot" (9), so leave a little room under 51.
const MAX_NAME_LENGTH = 50;

// Unions are hard for some clients to render and for some models to fill in.
// These two are real discriminated unions (a filter per field, a widget spec per
// view) that cannot be flattened, so they are named here; any other tool that
// grows one fails until someone decides it is worth it.
const ALLOWED_UNIONS = new Set(["list_traces.filters", "run_widget_query.spec"]);

type Schema = { description?: string } & Record<string, unknown>;
const properties = (tool: (typeof tools)[number]) =>
  Object.entries(tool.inputSchema.properties as Record<string, Schema>);
const hasUnion = (value: unknown): boolean => /"(oneOf|anyOf|allOf)"/.test(JSON.stringify(value));

describe("every exposed tool", () => {
  it("is the exposure list, in order", () => {
    expect(tools.map((tool) => tool.name)).toEqual([...EXPOSED_TOOLS]);
  });

  it.each(tools.map((tool) => [tool.name, tool] as const))(
    "%s has a short snake_case name and a real description",
    (_, tool) => {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.name.length).toBeLessThanOrEqual(MAX_NAME_LENGTH);
      expect(tool.description.length).toBeGreaterThanOrEqual(40);
    },
  );

  it.each(tools.map((tool) => [tool.name, tool] as const))(
    "%s describes every parameter",
    (_, tool) => {
      const bare = properties(tool)
        .filter(([, schema]) => !schema.description)
        .map(([name]) => name);
      expect(bare).toEqual([]);
    },
  );

  it.each(tools.map((tool) => [tool.name, tool] as const))(
    "%s adds no union type that is not already accepted",
    (_, tool) => {
      const unions = properties(tool)
        .filter(([name, schema]) => hasUnion(schema) && !ALLOWED_UNIONS.has(`${tool.name}.${name}`))
        .map(([name]) => name);
      expect(unions).toEqual([]);
    },
  );

  it("never points the model at a tool this server does not offer", () => {
    const offered = new Set<string>(EXPOSED_TOOLS);
    const unoffered = REGISTRY.map((entry) => entry.name).filter((name) => !offered.has(name));
    const references = tools.flatMap((tool) => {
      const text = `${tool.description}\n${JSON.stringify(tool.inputSchema)}`;
      return unoffered
        .filter((name) => new RegExp(`\\b${name}\\b`).test(text))
        .map((name) => `${tool.name} mentions ${name}`);
    });
    expect(references).toEqual([]);
  });

  it("is a snapshot of the surface, so a change to it is a decision", () => {
    expect(
      tools.map((tool) => ({
        name: tool.name,
        title: tool.title,
        annotations: tool.annotations,
        required: tool.inputSchema.required,
        params: properties(tool).map(([name]) => name),
      })),
    ).toMatchSnapshot();
  });
});

describe("the parameter docs", () => {
  it("only describe params some exposed tool has", () => {
    const used = new Set(tools.flatMap((tool) => properties(tool).map(([name]) => name)));
    const unused = Object.keys(PARAM_DESCRIPTIONS).filter((name) => !used.has(name));
    expect(unused).toEqual([]);
  });
});

describe("the server instructions", () => {
  it("name only tools that exist here", () => {
    const names = new Set<string>(EXPOSED_TOOLS);
    const mentioned = SERVER_INSTRUCTIONS.match(/\b(?:get|list|run)_[a-z_]+/g) ?? [];
    // list_* in the instructions is a pattern, not a tool name.
    const unknown = mentioned.filter((name) => !names.has(name) && !name.endsWith("_"));
    expect(unknown).toEqual([]);
  });

  it("are short enough to read on every connection", () => {
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(2000);
  });
});
