import { Type, type TSchema } from "@mariozechner/pi-ai";
import type { Tool } from "@mariozechner/pi-ai";

export interface SubmitResultInput {
  identified: boolean;
  summary: string;
  data: Record<string, unknown>;
}

const UNSAFE_SCHEMA_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function isSafeOutputFieldName(name: string): boolean {
  return name.length > 0 && !UNSAFE_SCHEMA_KEYS.has(name);
}

/**
 * Build the submit_result tool definition for the detection LLM (JSON-schema shape).
 * Used by tests and any Anthropic-shaped tooling; runtime eval uses {@link buildSubmitResultToolForPiAi}.
 */
export function buildSubmitResultTool(outputSchemaFields: Array<{ name: string; type: string }>) {
  const dataProperties = Object.create(null) as Record<
    string,
    { type: string; description: string }
  >;
  for (const field of outputSchemaFields) {
    if (!isSafeOutputFieldName(field.name)) continue;
    dataProperties[field.name] = {
      type: field.type,
      description: `User-defined field: ${field.name}`,
    };
  }

  return {
    name: "submit_result",
    description:
      "Submit your detection result. You MUST call this tool to complete. Do not respond with plain text.",
    input_schema: {
      type: "object",
      properties: {
        identified: {
          type: "boolean",
          description:
            "true if the problem described in the prompt was found in this trace, false otherwise",
        },
        summary: {
          type: "string",
          description:
            "One sentence describing what was found. Required even if identified=false (explain why it is clean).",
        },
        data: {
          type: "object",
          description: "User-defined extraction fields. Required if identified=true.",
          properties: dataProperties,
        },
      },
      required: ["identified", "summary"],
    },
  };
}

function fieldToSchema(field: { name: string; type: string }): TSchema {
  const desc = `User-defined field: ${field.name}`;
  if (field.type === "number") return Type.Number({ description: desc });
  if (field.type === "boolean") return Type.Boolean({ description: desc });
  return Type.String({ description: desc });
}

/** pi-ai / TypeBox tool definition for {@link complete} with tool calling. */
export function buildSubmitResultToolForPiAi(
  outputSchemaFields: Array<{ name: string; type: string }>,
): Tool {
  const dataProps = Object.create(null) as Record<string, TSchema>;
  for (const f of outputSchemaFields) {
    if (!isSafeOutputFieldName(f.name)) continue;
    dataProps[f.name] = fieldToSchema(f);
  }
  const dataObject = Type.Object(dataProps, {
    description: "User-defined extraction fields. Supply when identified=true.",
    additionalProperties: false,
  });
  const parameters = Type.Object(
    {
      identified: Type.Boolean({
        description:
          "true if the problem described in the prompt was found in this trace, false otherwise",
      }),
      summary: Type.String({
        description:
          "One sentence describing what was found. Required even if identified=false (explain why it is clean).",
      }),
      data: Type.Optional(dataObject),
    },
    { additionalProperties: false, required: ["identified", "summary"] },
  );

  return {
    name: "submit_result",
    description:
      "Submit your detection result. You MUST call this tool to complete. Do not respond with plain text.",
    parameters,
  };
}
