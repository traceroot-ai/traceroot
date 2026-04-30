export interface SubmitResultInput {
  identified: boolean;
  summary: string;
  data: Record<string, unknown>;
}

/**
 * Build the submit_result tool definition for the detection LLM.
 * outputSchemaFields is the user-defined fields from detector.outputSchema,
 * e.g. [{name: "category", type: "string"}, {name: "severity", type: "string"}]
 *
 * The LLM MUST call this tool to complete. Plain text responses are forbidden.
 */
export function buildSubmitResultTool(outputSchemaFields: Array<{ name: string; type: string }>) {
  const dataProperties: Record<string, { type: string; description: string }> = {};
  for (const field of outputSchemaFields) {
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
      required: ["identified", "summary", "data"],
    },
  };
}
