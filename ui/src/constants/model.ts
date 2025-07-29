export const CHAT_MODELS = {
  GPT_4O: 'gpt-4o',
  GPT_4O_MINI: 'gpt-4o-mini',
  O4_MINI: 'o4-mini',
  O3: 'o3',
  GPT_4_1_MINI: 'gpt-4.1-mini',
  GPT_4_1: 'gpt-4.1',
  AUTO: 'auto'
} as const;

export type ChatModel = typeof CHAT_MODELS[keyof typeof CHAT_MODELS];

export const CHAT_MODEL_DISPLAY_NAMES: Record<ChatModel, string> = {
  [CHAT_MODELS.GPT_4O]: 'GPT-4o',
  [CHAT_MODELS.GPT_4O_MINI]: 'GPT-4o Mini',
  [CHAT_MODELS.O4_MINI]: 'o4-mini',
  [CHAT_MODELS.O3]: 'o3',
  [CHAT_MODELS.GPT_4_1_MINI]: 'GPT-4.1 Mini',
  [CHAT_MODELS.GPT_4_1]: 'GPT-4.1',
  [CHAT_MODELS.AUTO]: 'Auto'
};

export const DEFAULT_MODEL: ChatModel = CHAT_MODELS.AUTO;


export const CHAT_MODE = {
  AGENT: 'agent',
  CHAT: 'chat'
} as const;

export type ChatMode = typeof CHAT_MODE[keyof typeof CHAT_MODE];

export const DEFAULT_MODE: ChatMode = CHAT_MODE.AGENT;
