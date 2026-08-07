// The package's entire public surface: `exports` maps only this entry point,
// so consumers get exactly these names. REGISTRY is the generated tool data,
// dispatch/client the engine, pi/mcp/internal the per-surface adapters —
// everything not re-exported here is private implementation detail.
export type { InputSchema, ParamSchema, RegistryEntry } from "./types.js";
export { generateRegistry, type OpenApiDocument } from "./generate.js";
export { REGISTRY } from "./registry.generated.js";
export { ApiClient, ApiError, bearerAuth, internalAuth, type ApiClientOptions } from "./client.js";
export { dispatch, fillPath, type DispatchOptions } from "./dispatch.js";
export {
  toPiAgentTool,
  type PiAgentTool,
  type PiToolResult,
  type PiToolResultContent,
  type ToPiAgentToolOptions,
} from "./pi.js";
export { toMcpTool, type McpTool } from "./mcp.js";
export { INTERNAL_BINDINGS } from "./internal.js";
