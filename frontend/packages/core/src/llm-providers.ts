// Adapter enum — maps to pi-ai provider names
export const LLMAdapter = {
  OPENAI: "openai",
  ANTHROPIC: "anthropic",
  AZURE: "azure",
  GOOGLE: "google",
  AMAZON_BEDROCK: "amazon-bedrock",
  DEEPSEEK: "deepseek",
  OPENROUTER: "openrouter",
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
};

// Default base URLs for adapters
export const ADAPTER_DEFAULT_BASE_URL: Record<string, string> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  google: "https://generativelanguage.googleapis.com",
  deepseek: "https://api.deepseek.com/v1",
  openrouter: "https://openrouter.ai/api/v1",
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
};

export interface LLMModelDef {
  id: string;
  label: string;
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
      { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ],
  },
  {
    provider: "OpenAI",
    envVar: "OPENAI_API_KEY",
    piAIProvider: "openai",
    apiProtocol: "openai-completions",
    models: [
      { id: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
      { id: "gpt-5", label: "GPT-5" },
      { id: "gpt-5-mini", label: "GPT-5 Mini" },
      { id: "o3", label: "o3" },
      { id: "o4-mini", label: "o4-mini" },
    ],
  },
];

// Default models per adapter (for BYOK providers)

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
};

// Adapter UI metadata
export const ADAPTER_CONFIG: Record<
  string,
  {
    label: string;
    requiresBaseUrl: boolean;
    requiresCustomModels: boolean;
    credentialType: "api-key" | "aws";
  }
> = {
  openai: {
    label: "OpenAI",
    requiresBaseUrl: false,
    requiresCustomModels: false,
    credentialType: "api-key",
  },
  anthropic: {
    label: "Anthropic",
    requiresBaseUrl: false,
    requiresCustomModels: false,
    credentialType: "api-key",
  },
  azure: {
    label: "Azure OpenAI",
    requiresBaseUrl: true,
    requiresCustomModels: true,
    credentialType: "api-key",
  },
  google: {
    label: "Google Gemini",
    requiresBaseUrl: false,
    requiresCustomModels: false,
    credentialType: "api-key",
  },
  "amazon-bedrock": {
    label: "AWS Bedrock",
    requiresBaseUrl: false,
    requiresCustomModels: true,
    credentialType: "aws",
  },
  deepseek: {
    label: "DeepSeek",
    requiresBaseUrl: false,
    requiresCustomModels: false,
    credentialType: "api-key",
  },
  openrouter: {
    label: "OpenRouter",
    requiresBaseUrl: false,
    requiresCustomModels: true,
    credentialType: "api-key",
  },
};

export const BEDROCK_USE_DEFAULT_CREDENTIALS = "__BEDROCK_DEFAULT_CREDENTIALS__";
