import React, { useState, useEffect } from "react";
import { Cloud } from "lucide-react";
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

type CloudProvider = "aws" | "tencent" | "jaeger";

export function CloudProviderTabContent() {
  const [selectedProvider, setSelectedProvider] =
    useState<CloudProvider>("aws");
  const [awsRegion, setAwsRegion] = useState("us-west-2");
  const [tencentRegion, setTencentRegion] = useState("ap-hongkong");
  const [tencentSecretId, setTencentSecretId] = useState("");
  const [tencentSecretKey, setTencentSecretKey] = useState("");
  const [tencentTraceToken, setTencentTraceToken] = useState("");
  const [jaegerEndpoint, setJaegerEndpoint] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);

  // Load saved data from localStorage on component mount
  useEffect(() => {
    const savedData = localStorage.getItem("cloudProviderSettings");
    if (savedData) {
      try {
        const parsedData = JSON.parse(savedData);
        setSelectedProvider(parsedData.selectedProvider || "aws");
        setAwsRegion(parsedData.awsRegion || "us-west-2");
        setTencentRegion(parsedData.tencentRegion || "ap-hongkong");
        setJaegerEndpoint(parsedData.jaegerEndpoint || "");
        // Don't load sensitive Tencent credentials from localStorage
      } catch (error) {
        console.error("Error parsing saved cloud provider settings:", error);
      }
    }
    setIsLoaded(true);
  }, []);

  // Save data to localStorage whenever any setting changes (but only after initial load)
  // Exclude sensitive Tencent credentials from localStorage
  useEffect(() => {
    if (!isLoaded) return; // Don't save during initial load

    const settingsData = {
      selectedProvider,
      awsRegion,
      tencentRegion,
      jaegerEndpoint,
      // Don't save sensitive Tencent credentials to localStorage
    };
    localStorage.setItem("cloudProviderSettings", JSON.stringify(settingsData));
  }, [
    isLoaded,
    selectedProvider,
    awsRegion,
    tencentRegion,
    jaegerEndpoint,
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
          <span>Cloud Provider</span>
        </h2>
        <p className="text-muted-foreground">
          Configure your cloud service provider settings for tracing and
          monitoring.
        </p>
      </div>

      <div className="space-y-6">
        <Card>
          <CardContent className="space-y-6">
            <div className="space-y-2">
              <Label
                htmlFor="provider-select"
                className="text-lg font-medium flex items-center space-x-0.5"
              >
                <Cloud size={20} />
                <span>Selected Provider</span>
              </Label>
              <Select
                value={selectedProvider}
                onValueChange={(value: CloudProvider) =>
                  setSelectedProvider(value)
                }
              >
                <SelectTrigger id="provider-select">
                  <SelectValue placeholder="Select a cloud provider" />
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
                <div className="space-y-2">
                  <Label htmlFor="aws-region">Region</Label>
                  <Select value={awsRegion} onValueChange={setAwsRegion}>
                    <SelectTrigger id="aws-region">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="us-west-2">
                        US West 2 (Oregon)
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
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
                    <Label htmlFor="tencent-region">Region</Label>
                    <Select
                      value={tencentRegion}
                      onValueChange={setTencentRegion}
                    >
                      <SelectTrigger id="tencent-region">
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
                    <Label htmlFor="tencent-secret-id">Secret ID</Label>
                    <Input
                      id="tencent-secret-id"
                      type="text"
                      placeholder="Enter your Secret ID"
                      value={tencentSecretId}
                      onChange={(e) => setTencentSecretId(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tencent-secret-key">Secret Key</Label>
                    <Input
                      id="tencent-secret-key"
                      type="password"
                      placeholder="Enter your Secret Key"
                      value={tencentSecretKey}
                      onChange={(e) => setTencentSecretKey(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tencent-trace-token">Trace Token</Label>
                    <Input
                      id="tencent-trace-token"
                      type="text"
                      placeholder="Enter your Trace Token"
                      value={tencentTraceToken}
                      onChange={(e) => setTencentTraceToken(e.target.value)}
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
                  <p className="text-xs text-muted-foreground">
                    Enter the full URL to your Jaeger collector endpoint
                  </p>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
