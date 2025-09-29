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

export function useCloudProvider() {
  const [settings, setSettings] =
    useState<CloudProviderSettings>(defaultSettings);
  const [isLoaded, setIsLoaded] = useState(false);

  useEffect(() => {
    const savedData = localStorage.getItem("cloudProviderSettings");
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

  return {
    selectedProvider: settings.selectedProvider,
    settings,
    isLoaded,
  };
}
