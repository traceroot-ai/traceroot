import { useState, useEffect } from "react";

export type CloudProvider = "aws" | "tencent" | "jaeger";

export interface CloudProviderSettings {
  selectedProvider: CloudProvider;
  awsRegion: string;
  tencentRegion: string;
  tencentSecretId: string;
  tencentSecretKey: string;
  tencentTraceToken: string;
  jaegerEndpoint: string;
}

const defaultSettings: CloudProviderSettings = {
  selectedProvider: "aws",
  awsRegion: "us-west-2",
  tencentRegion: "ap-hongkong",
  tencentSecretId: "",
  tencentSecretKey: "",
  tencentTraceToken: "",
  jaegerEndpoint: "",
};

// Helper to get user-specific storage key
const getUserStorageKey = (prefix: string): string => {
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

export function useCloudProvider() {
  const [settings, setSettings] =
    useState<CloudProviderSettings>(defaultSettings);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const storageKey = getUserStorageKey("cloudProviderSettings");
    const savedData = localStorage.getItem(storageKey);
    if (savedData) {
      try {
        const parsedData = JSON.parse(savedData);
        setSettings({
          ...defaultSettings,
          ...parsedData,
          // Always reset sensitive credentials to empty (don't load from localStorage)
          tencentSecretId: "",
          tencentSecretKey: "",
          tencentTraceToken: "",
        });
      } catch (error) {
        console.error("Error parsing saved cloud provider settings:", error);
      }
    }
    setIsLoaded(true);
  }, []);

  // Update settings when user changes
  useEffect(() => {
    const handleUserChange = () => {
      const storageKey = getUserStorageKey("cloudProviderSettings");
      const savedData = localStorage.getItem(storageKey);
      if (savedData) {
        try {
          const parsedData = JSON.parse(savedData);
          setSettings({
            ...defaultSettings,
            ...parsedData,
            // Always reset sensitive credentials to empty
            tencentSecretId: "",
            tencentSecretKey: "",
            tencentTraceToken: "",
          });
        } catch (error) {
          console.error("Error parsing saved cloud provider settings:", error);
        }
      } else {
        // Reset to defaults for new user
        setSettings(defaultSettings);
      }
    };

    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "user") {
        handleUserChange();
      }
    };

    window.addEventListener("userDataUpdated", handleUserChange);
    window.addEventListener("storage", handleStorageChange);

    return () => {
      window.removeEventListener("userDataUpdated", handleUserChange);
      window.removeEventListener("storage", handleStorageChange);
    };
  }, []);

  return {
    selectedProvider: settings.selectedProvider,
    settings,
    isLoaded,
  };
}
