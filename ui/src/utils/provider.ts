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

/**
 * URL parameter names for provider configuration
 */
const URL_PARAMS = {
  TRACE_PROVIDER: "trace_provider",
  TRACE_REGION: "trace_region",
  LOG_PROVIDER: "log_provider",
  LOG_REGION: "log_region",
} as const;

/**
 * Read provider configuration from URL parameters
 */
export const readProvidersFromURL = (): {
  traceProvider?: string;
  traceRegion?: string;
  logProvider?: string;
  logRegion?: string;
} => {
  if (typeof window === "undefined") return {};

  const params = new URLSearchParams(window.location.search);
  return {
    traceProvider: params.get(URL_PARAMS.TRACE_PROVIDER) || undefined,
    traceRegion: params.get(URL_PARAMS.TRACE_REGION) || undefined,
    logProvider: params.get(URL_PARAMS.LOG_PROVIDER) || undefined,
    logRegion: params.get(URL_PARAMS.LOG_REGION) || undefined,
  };
};

/**
 * Write provider configuration to URL parameters
 */
export const writeProvidersToURL = (config: {
  traceProvider?: string;
  traceRegion?: string;
  logProvider?: string;
  logRegion?: string;
}): void => {
  if (typeof window === "undefined") return;

  const params = new URLSearchParams(window.location.search);

  // Update or remove trace provider
  if (config.traceProvider) {
    params.set(URL_PARAMS.TRACE_PROVIDER, config.traceProvider);
  } else {
    params.delete(URL_PARAMS.TRACE_PROVIDER);
  }

  // Update or remove trace region
  if (config.traceRegion) {
    params.set(URL_PARAMS.TRACE_REGION, config.traceRegion);
  } else {
    params.delete(URL_PARAMS.TRACE_REGION);
  }

  // Update or remove log provider
  if (config.logProvider) {
    params.set(URL_PARAMS.LOG_PROVIDER, config.logProvider);
  } else {
    params.delete(URL_PARAMS.LOG_PROVIDER);
  }

  // Update or remove log region
  if (config.logRegion) {
    params.set(URL_PARAMS.LOG_REGION, config.logRegion);
  } else {
    params.delete(URL_PARAMS.LOG_REGION);
  }

  // Update URL without reloading the page
  const newURL = params.toString()
    ? `${window.location.pathname}?${params.toString()}`
    : window.location.pathname;
  window.history.replaceState({}, "", newURL);
};

/**
 * Get region for a specific provider from localStorage (synchronous)
 * Returns empty string for Jaeger since it doesn't use regions
 */
export const getProviderRegion = (
  providerType: ProviderType,
  provider: string,
): string => {
  // Jaeger doesn't use regions
  if (provider === "jaeger") {
    return "";
  }

  if (typeof window === "undefined") {
    return provider === "tencent" ? "ap-hongkong" : "us-west-2";
  }

  const storageKey = getUserStorageKey(
    `${providerType}ProviderConfig-${provider}`,
  );
  const savedConfig = localStorage.getItem(storageKey);

  if (savedConfig) {
    try {
      const config = JSON.parse(savedConfig);

      if (provider === "aws") {
        const configKey =
          providerType === "trace" ? "awsTraceConfig" : "awsLogConfig";
        return config[configKey]?.region || "us-west-2";
      } else if (provider === "tencent") {
        const configKey =
          providerType === "trace" ? "tencentTraceConfig" : "tencentLogConfig";
        return config[configKey]?.region || "ap-hongkong";
      }
    } catch (e) {
      // If parsing fails, return default
    }
  }

  // Default regions
  return provider === "tencent" ? "ap-hongkong" : "us-west-2";
};

/**
 * Initialize providers from URL or localStorage, with defaults
 */
export const initializeProviders = (): {
  traceProvider: string;
  traceRegion: string;
  logProvider: string;
  logRegion: string;
} => {
  // First check URL parameters
  const urlConfig = readProvidersFromURL();

  // Then check localStorage
  const localTraceProvider = loadProviderSelection("trace");
  const localLogProvider = loadProviderSelection("log");

  // Use URL > localStorage > defaults
  const traceProvider = urlConfig.traceProvider || localTraceProvider || "aws";
  const logProvider = urlConfig.logProvider || localLogProvider || "aws";

  // Get regions - URL first, then from saved config, then defaults
  const traceRegion =
    urlConfig.traceRegion || getProviderRegion("trace", traceProvider);
  const logRegion =
    urlConfig.logRegion || getProviderRegion("log", logProvider);

  // Save to localStorage if not already there
  if (!localTraceProvider && traceProvider) {
    saveProviderSelection("trace", traceProvider);
  }
  if (!localLogProvider && logProvider) {
    saveProviderSelection("log", logProvider);
  }

  // Sync to URL
  writeProvidersToURL({
    traceProvider,
    traceRegion,
    logProvider,
    logRegion,
  });

  return { traceProvider, traceRegion, logProvider, logRegion };
};

/**
 * Get provider info with defaults applied
 * @returns Provider info object with defaults (aws) for missing providers
 */
export const getProviderInfo = (): {
  traceProvider: string;
  logProvider: string;
  traceRegion?: string;
  logRegion?: string;
} => {
  const providerInfo = readProvidersFromURL();
  return {
    traceProvider: providerInfo.traceProvider || "aws",
    logProvider: providerInfo.logProvider || "aws",
    traceRegion: providerInfo.traceRegion,
    logRegion: providerInfo.logRegion,
  };
};

/**
 * Build provider query parameters for API URLs
 * @returns Query string with provider parameters
 */
export const buildProviderParams = (): string => {
  const { traceProvider, logProvider, traceRegion, logRegion } =
    getProviderInfo();

  let params = `trace_provider=${encodeURIComponent(traceProvider)}`;
  params += `&log_provider=${encodeURIComponent(logProvider)}`;

  if (traceRegion) {
    params += `&trace_region=${encodeURIComponent(traceRegion)}`;
  }
  if (logRegion) {
    params += `&log_region=${encodeURIComponent(logRegion)}`;
  }

  return params;
};

/**
 * Append provider parameters to a URL object
 * Useful for server-side and client-side code that builds URLs with URLSearchParams
 */
export const appendProviderParams = (
  url: URL,
  traceProvider?: string,
  traceRegion?: string,
  logProvider?: string,
  logRegion?: string,
): void => {
  const finalTraceProvider = traceProvider || "aws";
  const finalLogProvider = logProvider || "aws";

  url.searchParams.append("trace_provider", finalTraceProvider);
  url.searchParams.append("log_provider", finalLogProvider);

  if (traceRegion) {
    url.searchParams.append("trace_region", traceRegion);
  }
  if (logRegion) {
    url.searchParams.append("log_region", logRegion);
  }
};
