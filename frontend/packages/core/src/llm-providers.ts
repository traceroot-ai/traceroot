// Model source — system (TraceRoot-hosted) or BYOK (user's own keys)
export const ModelSource = {
  SYSTEM: "system",
  BYOK: "byok",
} as const;
export type ModelSource = (typeof ModelSource)[keyof typeof ModelSource];

// Adapter enum — maps to pi-ai provider names
export const LLMAdapter = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  AZURE: "azure",
  GOOGLE: "google",
  AMAZON_BEDROCK: "amazon-bedrock",
  DEEPSEEK: "deepseek",
  OPENROUTER: "openrouter",
  XAI: "xai",
  MOONSHOT: "moonshot",
  ZAI: "zai",
} as const;
export type LLMAdapter = (typeof LLMAdapter)[keyof typeof LLMAdapter];

// Maps our adapter name → pi-ai's getModel() provider argument
export const ADAPTER_TO_PI_AI: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  azure: "azure-openai-responses",
  google: "google",
  "amazon-bedrock": "amazon-bedrock",
  deepseek: "openai", // OpenAI-compatible
  openrouter: "openrouter",
  xai: "openai", // OpenAI-compatible
  moonshot: "openai", // OpenAI-compatible
  zai: "openai", // OpenAI-compatible
};

// Default base URLs for adapters
export const ADAPTER_DEFAULT_BASE_URL: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com/v1alpha",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
  xai: "https://api.x.ai/v1",
  moonshot: "https://api.moonshot.ai/v1",
  zai: "https://open.bigmodel.cn/api/paas/v4",
};

// API protocol per adapter — used to build fallback model objects for BYOK models
// not found in pi-ai's registry. Must match pi-ai's registered API providers.
export const ADAPTER_API_PROTOCOL: Record<string, string> = {
  openai: "openai-completions",
  anthropic: "anthropic-messages",
  azure: "azure-openai-responses",
  google: "google-generative-ai",
  "amazon-bedrock": "bedrock-converse-stream",
  deepseek: "openai-completions",
  openrouter: "openai-completions",
  xai: "openai-completions",
  moonshot: "openai-completions",
  zai: "openai-completions",
};

export interface LLMModelDef {
  id: string;
  /** Display label — intentionally set equal to id so the UI shows the exact model ID sent to the API */
  label: string;
  /** Cost per 1M input tokens in USD */
  inputCostPer1M?: number;
  /** Cost per 1M output tokens in USD */
  outputCostPer1M?: number;
  /** Override the provider-level apiProtocol for this specific model */
  apiProtocol?: string;
}

// ──────────────────────────────────────────────
// System models — always available via env vars.
// ──────────────────────────────────────────────
export const SYSTEM_MODELS: {
  provider: string;
  envVar: string;
  piAIProvider: string;
  /** pi-ai API protocol used to construct fallback model objects */
  apiProtocol: string;
  models: LLMModelDef[];
}[] = [
  {
    provider: "Anthropic",
    envVar: "ANTHROPIC_API_KEY",
    piAIProvider: "anthropic",
    apiProtocol: "anthropic-messages",
    models: [
      { id: "claude-opus-4-7", label: "claude-opus-4-7" },
      { id: "claude-opus-4-6", label: "claude-opus-4-6" },
      { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
      { id: "claude-opus-4-5", label: "claude-opus-4-5" },
      { id: "claude-sonnet-4-5", label: "claude-sonnet-4-5" },
      { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
    ],
  },
  {
    provider: "OpenAI",
    envVar: "OPENAI_API_KEY",
    piAIProvider: "openai",
    apiProtocol: "openai-completions",
    models: [
      { id: "gpt-5", label: "gpt-5" },
      { id: "gpt-5-mini", label: "gpt-5-mini" },
      { id: "o3", label: "o3" },
      { id: "o4-mini", label: "o4-mini" },
      // Codex models require the Responses API (not Chat Completions)
      { id: "gpt-5.3-codex", label: "gpt-5.3-codex", apiProtocol: "openai-responses" },
    ],
  },
];

// Provider priority for default model selection (highest first).
// Used by both the frontend ModelSelector (matches all providers including BYOK)
// and the backend getDefaultSystemModel() (only matches SYSTEM_MODELS entries;
// entries without a matching system provider are silently skipped server-side).
export const PROVIDER_PRIORITY: LLMAdapter[] = [
  LLMAdapter.ANTHROPIC,
  LLMAdapter.OPENAI,
  LLMAdapter.DEEPSEEK,
  LLMAdapter.XAI,
  LLMAdapter.MOONSHOT,
  LLMAdapter.ZAI,
  LLMAdapter.GOOGLE,
  LLMAdapter.OPENROUTER,
  LLMAdapter.AZURE,
  LLMAdapter.AMAZON_BEDROCK,
];

// Curated model catalog per adapter — used for dropdown selection in BYOK provider settings.
// Adapters NOT listed here (azure, amazon-bedrock, openrouter) use free-text input.
export const ADAPTER_MODELS: Partial<Record<LLMAdapter, LLMModelDef[]>> = {
  openai: [
    { id: "gpt-5.4", label: "gpt-5.4" },
    { id: "gpt-5.4-pro", label: "gpt-5.4-pro" },
    { id: "gpt-5.4-mini", label: "gpt-5.4-mini" },
    { id: "gpt-5.4-nano", label: "gpt-5.4-nano" },
    { id: "gpt-5.3-codex", label: "gpt-5.3-codex", apiProtocol: "openai-responses" },
    { id: "gpt-5.2", label: "gpt-5.2" },
    { id: "gpt-5", label: "gpt-5" },
    { id: "gpt-5-mini", label: "gpt-5-mini" },
    { id: "o3", label: "o3" },
    { id: "o4-mini", label: "o4-mini" },
  ],
  anthropic: [
    { id: "claude-opus-4-7", label: "claude-opus-4-7" },
    { id: "claude-opus-4-6", label: "claude-opus-4-6" },
    { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
    { id: "claude-opus-4-5", label: "claude-opus-4-5" },
    { id: "claude-sonnet-4-5", label: "claude-sonnet-4-5" },
    { id: "claude-haiku-4-5", label: "claude-haiku-4-5" },
  ],
  google: [
    { id: "gemini-3.1-pro-preview", label: "gemini-3.1-pro-preview" },
    { id: "gemini-3-flash-preview", label: "gemini-3-flash-preview" },
    { id: "gemini-3.1-flash-lite-preview", label: "gemini-3.1-flash-lite-preview" },
    { id: "gemini-2.5-flash", label: "gemini-2.5-flash" },
    { id: "gemini-2.5-pro", label: "gemini-2.5-pro" },
  ],
  deepseek: [{ id: "deepseek-chat", label: "deepseek-chat" }],
  xai: [
    { id: "grok-4.20", label: "grok-4.20" },
    { id: "grok-4", label: "grok-4" },
  ],
  moonshot: [
    { id: "kimi-k2.5", label: "kimi-k2.5" },
    { id: "kimi-k2-thinking", label: "kimi-k2-thinking" },
  ],
  zai: [
    { id: "glm-5.1", label: "glm-5.1" },
    { id: "glm-5", label: "glm-5" },
    { id: "glm-5-turbo", label: "glm-5-turbo" },
    { id: "glm-4.7", label: "glm-4.7" },
    { id: "glm-4.6", label: "glm-4.6" },
    { id: "glm-4.5", label: "glm-4.5" },
    { id: "glm-4.5-air", label: "glm-4.5-air" },
    { id: "glm-4.5-flash", label: "glm-4.5-flash" },
  ],
};

// Available API protocols per adapter — shown in provider settings UI
// When multiple protocols are available, user can choose; otherwise the default is used.
export const ADAPTER_AVAILABLE_PROTOCOLS: Record<string, { value: string; label: string }[]> = {
  openai: [
    { value: "openai-completions", label: "Chat Completions" },
    { value: "openai-responses", label: "Responses API" },
  ],
  anthropic: [{ value: "anthropic-messages", label: "Messages API" }],
  azure: [{ value: "azure-openai-responses", label: "Azure OpenAI Responses" }],
  google: [{ value: "google-generative-ai", label: "Generative AI" }],
  "amazon-bedrock": [{ value: "bedrock-converse-stream", label: "Bedrock Converse" }],
  deepseek: [{ value: "openai-completions", label: "Chat Completions" }],
  openrouter: [
    { value: "openai-completions", label: "Chat Completions" },
    { value: "openai-responses", label: "Responses API" },
  ],
  xai: [{ value: "openai-completions", label: "Chat Completions" }],
  moonshot: [{ value: "openai-completions", label: "Chat Completions" }],
  zai: [{ value: "openai-completions", label: "Chat Completions" }],
};

// Adapter UI metadata
export const ADAPTER_CONFIG: Record<
  string,
  {
    label: string;
    requiresBaseUrl: boolean;
    credentialType: "api-key" | "aws";
  }
> = {
  openai: {
    label: "OpenAI",
    requiresBaseUrl: false,
    credentialType: "api-key",
  },
  anthropic: {
    label: "Anthropic",
    requiresBaseUrl: false,
    credentialType: "api-key",
  },
  azure: {
    label: "Azure OpenAI",
    requiresBaseUrl: true,
    credentialType: "api-key",
  },
  google: {
    label: "Google Gemini",
    requiresBaseUrl: false,
    credentialType: "api-key",
  },
  "amazon-bedrock": {
    label: "AWS Bedrock",
    requiresBaseUrl: false,
    credentialType: "aws",
  },
  deepseek: {
    label: "DeepSeek",
    requiresBaseUrl: false,
    credentialType: "api-key",
  },
  openrouter: {
    label: "OpenRouter",
    requiresBaseUrl: false,
    credentialType: "api-key",
  },
  xai: {
    label: "xAI",
    requiresBaseUrl: false,
    credentialType: "api-key",
  },
  moonshot: {
    label: "Moonshot (Kimi)",
    requiresBaseUrl: false,
    credentialType: "api-key",
  },
  zai: {
    label: "Z.AI (GLM)",
    requiresBaseUrl: false,
    credentialType: "api-key",
  },
};

export const BEDROCK_USE_DEFAULT_CREDENTIALS = "__BEDROCK_DEFAULT_CREDENTIALS__";
