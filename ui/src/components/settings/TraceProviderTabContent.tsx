import React, { useState, useEffect } from "react";
import { Telescope } from "lucide-react";
import { FaAws } from "react-icons/fa";
import { BsTencentQq } from "react-icons/bs";
import { SiJaeger } from "react-icons/si";
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

type TraceProvider = "aws" | "tencent" | "jaeger";

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

export function TraceProviderTabContent() {
  const [selectedProvider, setSelectedProvider] =
    useState<TraceProvider>("aws");
  const [tencentRegion, setTencentRegion] = useState("ap-hongkong");
  const [tencentSecretId, setTencentSecretId] = useState("");
  const [tencentSecretKey, setTencentSecretKey] = useState("");
  const [tencentApmInstanceId, setTencentApmInstanceId] = useState("");
  const [jaegerEndpoint, setJaegerEndpoint] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);

  // Load saved data from localStorage on component mount
  useEffect(() => {
    const storageKey = getUserStorageKey("traceProviderSettings");
    const savedData = localStorage.getItem(storageKey);
    if (savedData) {
      try {
        const parsedData = JSON.parse(savedData);
        setSelectedProvider(parsedData.selectedProvider || "aws");
        setTencentRegion(parsedData.tencentRegion || "ap-hongkong");
        setJaegerEndpoint(parsedData.jaegerEndpoint || "");
        setTencentApmInstanceId(parsedData.tencentApmInstanceId || "");
        // Don't load sensitive Tencent credentials from localStorage
      } catch (error) {
        console.error("Error parsing saved trace provider settings:", error);
      }
    }
    setIsLoaded(true);
  }, []);

  // Update settings when user changes
  useEffect(() => {
    const handleUserChange = () => {
      const storageKey = getUserStorageKey("traceProviderSettings");
      const savedData = localStorage.getItem(storageKey);
      if (savedData) {
        try {
          const parsedData = JSON.parse(savedData);
          setSelectedProvider(parsedData.selectedProvider || "aws");
          setTencentRegion(parsedData.tencentRegion || "ap-hongkong");
          setJaegerEndpoint(parsedData.jaegerEndpoint || "");
          setTencentApmInstanceId(parsedData.tencentApmInstanceId || "");
        } catch (error) {
          console.error("Error parsing saved trace provider settings:", error);
        }
      } else {
        // Reset to defaults for new user
        setSelectedProvider("aws");
        setTencentRegion("ap-hongkong");
        setJaegerEndpoint("");
        setTencentApmInstanceId("");
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
      jaegerEndpoint,
      tencentApmInstanceId,
      // Don't save sensitive Tencent credentials to localStorage
    };
    const storageKey = getUserStorageKey("traceProviderSettings");
    localStorage.setItem(storageKey, JSON.stringify(settingsData));
  }, [
    isLoaded,
    selectedProvider,
    tencentRegion,
    jaegerEndpoint,
    tencentApmInstanceId,
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
    {
      value: "jaeger" as const,
      label: "Jaeger",
      icon: SiJaeger,
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
          <Telescope size={24} />
          <span>Trace Provider</span>
        </h2>
        <p className="text-muted-foreground">
          Configure your trace service provider settings for distributed
          tracing.
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label
                htmlFor="trace-provider-select"
                className="text-lg font-medium flex items-center space-x-0.5"
              >
                <Telescope size={20} />
                <span>Selected Provider</span>
              </Label>
              <Select
                value={selectedProvider}
                onValueChange={(value: TraceProvider) =>
                  setSelectedProvider(value)
                }
              >
                <SelectTrigger id="trace-provider-select">
                  <SelectValue placeholder="Select a trace provider" />
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
                  AWS X-Ray tracing is automatically configured. No additional
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
                    <Label htmlFor="tencent-trace-region">Region</Label>
                    <Select
                      value={tencentRegion}
                      onValueChange={setTencentRegion}
                    >
                      <SelectTrigger id="tencent-trace-region">
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
                    <Label htmlFor="tencent-trace-secret-id">Secret ID</Label>
                    <Input
                      id="tencent-trace-secret-id"
                      type="text"
                      placeholder="Enter your Secret ID"
                      value={tencentSecretId}
                      onChange={(e) => setTencentSecretId(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tencent-trace-secret-key">Secret Key</Label>
                    <Input
                      id="tencent-trace-secret-key"
                      type="password"
                      placeholder="Enter your Secret Key"
                      value={tencentSecretKey}
                      onChange={(e) => setTencentSecretKey(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tencent-apm-instance-id">
                      APM Instance ID
                    </Label>
                    <Input
                      id="tencent-apm-instance-id"
                      type="text"
                      placeholder="Enter your APM Instance ID"
                      value={tencentApmInstanceId}
                      onChange={(e) => setTencentApmInstanceId(e.target.value)}
                    />
                  </div>
                </div>
              </div>
            )}

            {selectedProvider === "jaeger" && (
              <div className="space-y-4 border-t pt-4">
                <h3 className="text-lg font-medium flex items-center space-x-2">
                  <SiJaeger size={20} />
                  <span>Jaeger Configuration</span>
                </h3>
                <div className="space-y-2">
                  <Label htmlFor="jaeger-endpoint">Jaeger Endpoint</Label>
                  <Input
                    id="jaeger-endpoint"
                    type="url"
                    placeholder="https://your-jaeger-endpoint.com"
                    value={jaegerEndpoint}
                    onChange={(e) => setJaegerEndpoint(e.target.value)}
                  />
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
