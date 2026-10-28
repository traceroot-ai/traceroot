import { Type, type TSchema } from "@earendil-works/pi-ai";
import type { Tool } from "@earendil-works/pi-ai";

export interface SubmitResultInput {
  identified: boolean;
  summary: string;
  data: Record<string, unknown>;
}

// Reject user-supplied output schema field names that would mutate Object.prototype
// or be silently ignored after `Object.create(null)`. The `outputSchema` array is
// detector-author input; treat it as untrusted.
const UNSAFE_FIELD_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function isSafeFieldName(name: unknown): name is string {
  return typeof name === "string" && name.length > 0 && !UNSAFE_FIELD_NAMES.has(name);
}

function fieldToSchema(name: string, type: unknown): TSchema {
  const description = `User-defined field: ${name}`;
  if (type === "number") return Type.Number({ description });
  if (type === "boolean") return Type.Boolean({ description });
  return Type.String({ description });
}

/**
 * Build the submit_result tool for the detection LLM, in pi-ai's `Tool` shape
 * (TypeBox `parameters`). pi-ai's per-provider adapter normalizes to each
 * provider's native tool shape at request time.
 *
 * The LLM MUST call this tool to complete; plain text responses are rejected.
 * `data` is only required when `identified=true` (the system prompt enforces
 * this) — at the schema level we keep it optional so models don't fabricate
 * empty objects on clean traces.
 */
export function buildSubmitResultTool(outputSchemaFields: ReadonlyArray<unknown>): Tool {
  const dataProps = Object.create(null) as Record<string, TSchema>;
  for (const field of outputSchemaFields) {
    // A stored schema can predate the write path's validation: an entry that is
    // not an object or has no name is skipped, since throwing here would fail
    // every scan of the detector.
    const { name, type } = (field ?? {}) as { name?: unknown; type?: unknown };
    if (!isSafeFieldName(name)) continue;
    dataProps[name] = fieldToSchema(name, type);
  }

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
      data: Type.Optional(
        Type.Object(dataProps, {
          description: "User-defined extraction fields. Supply when identified=true.",
          additionalProperties: false,
        }),
      ),
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
