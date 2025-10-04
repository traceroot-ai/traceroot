import React, { useState, useEffect } from "react";
import { Cloud } from "lucide-react";
import { FaAws } from "react-icons/fa";
import { BsTencentQq } from "react-icons/bs";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type LogProvider = "aws" | "tencent";

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

export function LogProviderTabContent() {
  const [selectedProvider, setSelectedProvider] = useState<LogProvider>("aws");
  const [tencentRegion, setTencentRegion] = useState("ap-hongkong");
  const [tencentSecretId, setTencentSecretId] = useState("");
  const [tencentSecretKey, setTencentSecretKey] = useState("");
  const [tencentClsTopicId, setTencentClsTopicId] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);

  // Load saved data from localStorage on component mount
  useEffect(() => {
    const storageKey = getUserStorageKey("logProviderSettings");
    const savedData = localStorage.getItem(storageKey);
    if (savedData) {
      try {
        const parsedData = JSON.parse(savedData);
        setSelectedProvider(parsedData.selectedProvider || "aws");
        setTencentRegion(parsedData.tencentRegion || "ap-hongkong");
        setTencentClsTopicId(parsedData.tencentClsTopicId || "");
        // Don't load sensitive Tencent credentials from localStorage
      } catch (error) {
        console.error("Error parsing saved log provider settings:", error);
      }
    }
    setIsLoaded(true);
  }, []);

  // Update settings when user changes
  useEffect(() => {
    const handleUserChange = () => {
      const storageKey = getUserStorageKey("logProviderSettings");
      const savedData = localStorage.getItem(storageKey);
      if (savedData) {
        try {
          const parsedData = JSON.parse(savedData);
          setSelectedProvider(parsedData.selectedProvider || "aws");
          setTencentRegion(parsedData.tencentRegion || "ap-hongkong");
          setTencentClsTopicId(parsedData.tencentClsTopicId || "");
        } catch (error) {
          console.error("Error parsing saved log provider settings:", error);
        }
      } else {
        // Reset to defaults for new user
        setSelectedProvider("aws");
        setTencentRegion("ap-hongkong");
        setTencentClsTopicId("");
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

  // Save data to localStorage whenever any setting changes (but only after initial load)
  // Exclude sensitive Tencent credentials from localStorage
  useEffect(() => {
    if (!isLoaded) return; // Don't save during initial load

    const settingsData = {
      selectedProvider,
      tencentRegion,
      tencentClsTopicId,
      // Don't save sensitive Tencent credentials to localStorage
    };
    const storageKey = getUserStorageKey("logProviderSettings");
    localStorage.setItem(storageKey, JSON.stringify(settingsData));
  }, [
    isLoaded,
    selectedProvider,
    tencentRegion,
    tencentClsTopicId,
    // Removed sensitive credentials from dependency array
  ]);

  const providers = [
    {
      value: "aws" as const,
      label: "Amazon Web Services",
      icon: FaAws,
    },
    {
      value: "tencent" as const,
      label: "Tencent Cloud",
      icon: BsTencentQq,
    },
  ];

  const tencentRegions = [
    { value: "ap-hongkong", label: "Hong Kong (ap-hongkong)" },
    { value: "ap-beijing", label: "Beijing (ap-beijing)" },
    { value: "ap-shanghai", label: "Shanghai (ap-shanghai)" },
    { value: "ap-guangzhou", label: "Guangzhou (ap-guangzhou)" },
    { value: "ap-singapore", label: "Singapore (ap-singapore)" },
  ];

  return (
    <div className="flex-1 p-6">
      <div className="mb-6">
        <h2 className="text-2xl font-semibold mb-2 flex items-center space-x-2">
          <Cloud size={24} />
          <span>Log Provider</span>
        </h2>
        <p className="text-muted-foreground">
          Configure your log service provider settings for centralized logging.
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label
                htmlFor="log-provider-select"
                className="text-lg font-medium flex items-center space-x-0.5"
              >
                <Cloud size={20} />
                <span>Selected Provider</span>
              </Label>
              <Select
                value={selectedProvider}
                onValueChange={(value: LogProvider) =>
                  setSelectedProvider(value)
                }
              >
                <SelectTrigger id="log-provider-select">
                  <SelectValue placeholder="Select a log provider" />
                </SelectTrigger>
                <SelectContent>
                  {providers.map((provider) => {
                    const Icon = provider.icon;
                    return (
                      <SelectItem key={provider.value} value={provider.value}>
                        <div className="flex items-center space-x-2">
                          <Icon size={18} />
                          <span>{provider.label}</span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
            </div>

            {selectedProvider === "aws" && (
              <div className="space-y-4 border-t pt-4">
                <h3 className="text-lg font-medium flex items-center space-x-2">
                  <FaAws size={20} />
                  <span>Amazon Web Services Configuration</span>
                </h3>
                <p className="text-sm text-muted-foreground">
                  AWS CloudWatch Logs is automatically configured. No additional
                  settings required.
                </p>
              </div>
            )}

            {selectedProvider === "tencent" && (
              <div className="space-y-4 border-t pt-4">
                <h3 className="text-lg font-medium flex items-center space-x-2">
                  <BsTencentQq size={20} />
                  <span>Tencent Cloud Configuration</span>
                </h3>
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="tencent-log-region">Region</Label>
                    <Select
                      value={tencentRegion}
                      onValueChange={setTencentRegion}
                    >
                      <SelectTrigger id="tencent-log-region">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {tencentRegions.map((region) => (
                          <SelectItem key={region.value} value={region.value}>
                            {region.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tencent-log-secret-id">Secret ID</Label>
                    <Input
                      id="tencent-log-secret-id"
                      type="text"
                      placeholder="Enter your Secret ID"
                      value={tencentSecretId}
                      onChange={(e) => setTencentSecretId(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tencent-log-secret-key">Secret Key</Label>
                    <Input
                      id="tencent-log-secret-key"
                      type="password"
                      placeholder="Enter your Secret Key"
                      value={tencentSecretKey}
                      onChange={(e) => setTencentSecretKey(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tencent-cls-topic-id">CLS Topic ID</Label>
                    <Input
                      id="tencent-cls-topic-id"
                      type="text"
                      placeholder="Enter your CLS Topic ID"
                      value={tencentClsTopicId}
                      onChange={(e) => setTencentClsTopicId(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
