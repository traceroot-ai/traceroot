/**
 * Utility functions for managing provider configurations (Trace and Log providers)
 */

import {
  encryptValue,
  decryptValue,
  encryptSensitiveFields,
  decryptSensitiveFields,
} from "./encryption";

export type ProviderType = "trace" | "log";

/**
 * Get user-specific storage key for localStorage
 */
export const getUserStorageKey = (prefix: string): string => {
  if (typeof window === "undefined") return prefix;

  const userData = localStorage.getItem("user");
  if (userData) {
    try {
      const user = JSON.parse(userData);
      const userEmail = user?.email;
      if (userEmail) {
        return `${prefix}-${userEmail}`;
      }
    } catch (e) {
      // If parsing fails, use default key
    }
  }
  return prefix;
};

/**
 * Load provider selection from localStorage
 */
export const loadProviderSelection = (
  providerType: ProviderType,
): string | null => {
  const storageKey = getUserStorageKey(`${providerType}ProviderSelection`);
  return localStorage.getItem(storageKey);
};

/**
 * Save provider selection to localStorage
 */
export const saveProviderSelection = (
  providerType: ProviderType,
  provider: string,
): void => {
  const storageKey = getUserStorageKey(`${providerType}ProviderSelection`);
  localStorage.setItem(storageKey, provider);
};

/**
 * Clear provider selection from localStorage
 */
export const clearProviderSelection = (providerType: ProviderType): void => {
  const storageKey = getUserStorageKey(`${providerType}ProviderSelection`);
  localStorage.removeItem(storageKey);
};

/**
 * Load specific provider's configuration from localStorage
 * @param providerType - "trace" or "log"
 * @param provider - "aws", "tencent", or "jaeger"
 */
export const loadSpecificProviderConfig = async (
  providerType: ProviderType,
  provider: string,
): Promise<any | null> => {
  const storageKey = getUserStorageKey(
    `${providerType}ProviderConfig-${provider}`,
  );
  const savedConfig = localStorage.getItem(storageKey);
  if (savedConfig) {
    try {
      const config = JSON.parse(savedConfig);

      // Decrypt sensitive fields only for Tencent provider (secretId and secretKey)
      if (provider === "tencent") {
        const configKey =
          providerType === "trace" ? "tencentTraceConfig" : "tencentLogConfig";

        if (config[configKey]) {
          config[configKey] = await decryptSensitiveFields(config[configKey], [
            "secretId",
            "secretKey",
          ]);
        }
      }

      return config;
    } catch (e) {
      console.error(
        `Error parsing ${providerType} ${provider} provider config:`,
        e,
      );
      return null;
    }
  }
  return null;
};

/**
 * Save specific provider's configuration to localStorage
 * @param providerType - "trace" or "log"
 * @param provider - "aws", "tencent", or "jaeger"
 * @param config - The configuration object for this specific provider
 */
export const saveSpecificProviderConfig = async (
  providerType: ProviderType,
  provider: string,
  config: any,
): Promise<void> => {
  const storageKey = getUserStorageKey(
    `${providerType}ProviderConfig-${provider}`,
  );

  // Encrypt sensitive fields before saving
  let configToSave = { ...config };
  if (provider === "tencent") {
    const configKey =
      providerType === "trace" ? "tencentTraceConfig" : "tencentLogConfig";

    if (configToSave[configKey]) {
      configToSave[configKey] = await encryptSensitiveFields(
        configToSave[configKey],
        ["secretId", "secretKey"],
      );
    }
  }

  localStorage.setItem(storageKey, JSON.stringify(configToSave));
};

/**
 * Delete specific provider's configuration from localStorage
 * @param providerType - "trace" or "log"
 * @param provider - "aws", "tencent", or "jaeger"
 */
export const deleteSpecificProviderConfig = (
  providerType: ProviderType,
  provider: string,
): void => {
  const storageKey = getUserStorageKey(
    `${providerType}ProviderConfig-${provider}`,
  );
  localStorage.removeItem(storageKey);
};

/**
 * Load all providers' configurations and merge them
 * Used for backward compatibility and MongoDB sync
 */
export const loadAllProviderConfigs = async (
  providerType: ProviderType,
): Promise<any> => {
  const providers = ["aws", "tencent", "jaeger"];
  const allConfigs: any = {};

  for (const provider of providers) {
    const config = await loadSpecificProviderConfig(providerType, provider);
    if (config) {
      Object.assign(allConfigs, config);
    }
  }

  return allConfigs;
};

/**
 * Get user email from localStorage
 */
export const getUserEmail = (): string | null => {
  const userData = localStorage.getItem("user");
  if (!userData) return null;

  try {
    const user = JSON.parse(userData);
    return user?.email || null;
  } catch (e) {
    console.error("Error parsing user data:", e);
    return null;
  }
};

/**
 * Copy text to clipboard
 */
export const copyToClipboard = (text: string): void => {
  if (!text) return;
  navigator.clipboard.writeText(text);
};

/**
 * Apply configuration from MongoDB or localStorage to state setters
 */
interface ConfigSetters {
  setTencentRegion: (region: string) => void;
  setTencentSecretId: (id: string) => void;
  setTencentSecretKey: (key: string) => void;
  setJaegerEndpoint: (endpoint: string) => void;
  setTencentInstanceId?: (id: string) => void;
  setTencentTopicId?: (id: string) => void;
}

export const applyTraceConfig = (config: any, setters: ConfigSetters): void => {
  if (config.tencentTraceConfig) {
    setters.setTencentRegion(config.tencentTraceConfig.region || "ap-hongkong");
    setters.setTencentSecretId(config.tencentTraceConfig.secretId || "");
    setters.setTencentSecretKey(config.tencentTraceConfig.secretKey || "");
    if (setters.setTencentInstanceId) {
      setters.setTencentInstanceId(
        config.tencentTraceConfig.apmInstanceId || "",
      );
    }
  }
  if (config.jaegerTraceConfig) {
    setters.setJaegerEndpoint(config.jaegerTraceConfig.endpoint || "");
  }
};

export const applyLogConfig = (config: any, setters: ConfigSetters): void => {
  if (config.tencentLogConfig) {
    setters.setTencentRegion(config.tencentLogConfig.region || "ap-hongkong");
    setters.setTencentSecretId(config.tencentLogConfig.secretId || "");
    setters.setTencentSecretKey(config.tencentLogConfig.secretKey || "");
    if (setters.setTencentTopicId) {
      setters.setTencentTopicId(config.tencentLogConfig.clsTopicId || "");
    }
  }
  if (config.jaegerLogConfig) {
    setters.setJaegerEndpoint(config.jaegerLogConfig.endpoint || "");
  }
};
