import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import {
  DETECTOR_SYSTEM_DEFAULT_MODEL_ID,
  listWorkspaceModels,
  type WorkspaceModels,
} from "@traceroot/core";

const schema = Type.Object({});

/**
 * A provider name or model id as a JSON string literal: BYOK names and custom
 * model ids are typed by workspace members, so a quote, a newline or a
 * sentence inside one is shown as data rather than read as part of this
 * tool's text, and the agent gets an exact string to copy.
 */
function quoted(value: string): string {
  return JSON.stringify(value);
}

/**
 * The workspace's models as lines the model can copy ids out of: one line per
 * provider, grouped by how a detector names them (system, or BYOK with the
 * provider's name). The list the web app's picker shows, so an id from here
 * is one the detector write accepts.
 */
export function formatDetectorModels(models: WorkspaceModels): string {
  const lines = [
    "Models a detector in this workspace can run on. Leave detection_model unset for the " +
      `default (${DETECTOR_SYSTEM_DEFAULT_MODEL_ID}, system).`,
    "",
    'System models — detection_source "system" (or unset), no detection_provider:',
  ];
  if (models.systemModels.length === 0) {
    lines.push("- none available (no system provider key is configured)");
  }
  for (const p of models.systemModels) {
    lines.push(`- ${p.provider}: ${p.models.map((m) => quoted(m.id)).join(", ")}`);
  }
  lines.push(
    "",
    'BYOK providers — detection_source "byok", detection_provider set to the provider name:',
  );
  if (models.byokProviders.length === 0) {
    lines.push("- none configured (the user adds one under workspace settings)");
  }
  for (const p of models.byokProviders) {
    const ids = p.models.map((m) => quoted(m.id)).join(", ") || "(none configured)";
    lines.push(`- ${quoted(p.provider)} (${p.adapter}): ${ids}`);
  }
  return lines.join("\n");
}

export function createListDetectorModelsTool(workspaceId: string): AgentTool<typeof schema> {
  return {
    name: "list_detector_models",
    label: "List detector models",
    description:
      "List the models a detector in this workspace can run on: the system models and the " +
      "workspace's BYOK providers with their models. Call this before setting detection_model " +
      "or detection_provider on a detector, and pick from the result — a model that is not " +
      "listed is rejected.",
    parameters: schema,
    execute: async (): Promise<AgentToolResult<undefined>> => {
      const models = await listWorkspaceModels(workspaceId);
      return {
        content: [{ type: "text", text: formatDetectorModels(models) }],
        details: undefined,
      };
    },
  };
}
