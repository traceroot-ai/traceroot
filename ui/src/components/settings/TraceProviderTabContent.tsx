import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Telescope,
  Trash2,
  Save,
  Copy,
  Eye,
  EyeOff,
  ShieldCheck,
} from "lucide-react";
import { FaAws } from "react-icons/fa";
import { BsTencentQq } from "react-icons/bs";
import { SiJaeger } from "react-icons/si";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  loadProviderSelection,
  saveProviderSelection,
  clearProviderSelection,
  getUserEmail,
  copyToClipboard,
  applyTraceConfig,
  saveSpecificProviderConfig,
  deleteSpecificProviderConfig,
  loadAllProviderConfigs,
  writeProvidersToURL,
  readProvidersFromURL,
} from "@/utils/provider";

type TraceProvider = "aws" | "tencent" | "jaeger";

export function TraceProviderTabContent() {
  const [selectedProvider, setSelectedProvider] =
    useState<TraceProvider>("aws");
  const isUpdatingRef = useRef(false);
  const isUpdatingRegionRef = useRef(false);
  const isUpdatingAwsRegionRef = useRef(false);
  const [awsRegion, setAwsRegion] = useState("us-west-2");
  const [tencentRegion, setTencentRegion] = useState("ap-hongkong");
  const [tencentSecretId, setTencentSecretId] = useState("");
  const [tencentSecretKey, setTencentSecretKey] = useState("");
  const [tencentApmInstanceId, setTencentApmInstanceId] = useState("");
  const [jaegerEndpoint, setJaegerEndpoint] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [mongoAvailable, setMongoAvailable] = useState(true);
  const [showSecretId, setShowSecretId] = useState(false);
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [showApmInstanceId, setShowApmInstanceId] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Track initial loaded values to detect changes
  const [initialValues, setInitialValues] = useState({
    awsRegion: "us-west-2",
    tencentRegion: "ap-hongkong",
    tencentSecretId: "",
    tencentSecretKey: "",
    tencentApmInstanceId: "",
    jaegerEndpoint: "",
  });

  // Load saved data from API and localStorage on component mount
  useEffect(() => {
    const loadConfig = async () => {
      try {
        // Load selected provider from localStorage first
        const savedSelection = loadProviderSelection(
          "trace",
        ) as TraceProvider | null;

        const providerHasStoredConfig = (
          provider: TraceProvider | null,
          config: any,
        ) => {
          if (!provider || !config) return false;

          if (provider === "aws") {
            return Boolean(config.awsTraceConfig?.region);
          }

          if (provider === "tencent") {
            const tencentConfig = config.tencentTraceConfig;
            if (!tencentConfig) return false;
            return Boolean(
              tencentConfig.secretId ||
                tencentConfig.secretKey ||
                tencentConfig.apmInstanceId,
            );
          }

          if (provider === "jaeger") {
            return Boolean(config.jaegerTraceConfig?.endpoint);
          }

          return false;
        };

        const resolveSelectedProvider = (config: any): TraceProvider => {
          if (savedSelection) {
            if (providerHasStoredConfig(savedSelection, config)) {
              return savedSelection;
            }

            if (savedSelection !== "aws") {
              saveProviderSelection("trace", "aws");
            }
            return "aws";
          }

          const storedProvider = config?.traceProvider as
            | TraceProvider
            | undefined;
          if (
            storedProvider &&
            providerHasStoredConfig(storedProvider, config)
          ) {
            saveProviderSelection("trace", storedProvider);
            return storedProvider;
          }

          return "aws";
        };

        // Try to fetch from API - server will get userEmail from Clerk auth
        const response = await fetch(`/api/provider-config`);
        const data = await response.json();

        if (response.ok) {
          // Server confirms MongoDB is available
          setMongoAvailable(data.mongoAvailable !== false);

          // Decrypt sensitive fields from MongoDB
          let decryptedConfig = data.config ? { ...data.config } : null;
          if (decryptedConfig?.tencentTraceConfig) {
            const { decryptSensitiveFields } = await import(
              "@/utils/encryption"
            );
            decryptedConfig.tencentTraceConfig = await decryptSensitiveFields(
              decryptedConfig.tencentTraceConfig,
              ["secretId", "secretKey"],
            );
          }

          if (decryptedConfig) {
            // Load configuration details from MongoDB
            applyTraceConfig(decryptedConfig, {
              setTencentRegion,
              setTencentSecretId,
              setTencentSecretKey,
              setJaegerEndpoint,
              setTencentInstanceId: setTencentApmInstanceId,
            });

            // Store initial values (use decrypted config)
            setInitialValues({
              awsRegion: decryptedConfig.awsTraceConfig?.region || "us-west-2",
              tencentRegion:
                decryptedConfig.tencentTraceConfig?.region || "ap-hongkong",
              tencentSecretId:
                decryptedConfig.tencentTraceConfig?.secretId || "",
              tencentSecretKey:
                decryptedConfig.tencentTraceConfig?.secretKey || "",
              tencentApmInstanceId:
                decryptedConfig.tencentTraceConfig?.apmInstanceId || "",
              jaegerEndpoint: decryptedConfig.jaegerTraceConfig?.endpoint || "",
            });

            // Load AWS region
            if (decryptedConfig.awsTraceConfig?.region) {
              setAwsRegion(decryptedConfig.awsTraceConfig.region);
            }
          }

          const resolvedProvider = resolveSelectedProvider(decryptedConfig);
          setSelectedProvider(resolvedProvider);
        } else if (response.status === 503) {
          // Server says MongoDB not available, load from localStorage
          setMongoAvailable(false);

          // Load all provider configs separately
          const allConfigs = await loadAllProviderConfigs("trace");
          if (allConfigs && Object.keys(allConfigs).length > 0) {
            applyTraceConfig(allConfigs, {
              setTencentRegion,
              setTencentSecretId,
              setTencentSecretKey,
              setJaegerEndpoint,
              setTencentInstanceId: setTencentApmInstanceId,
            });

            // Store initial values
            setInitialValues({
              awsRegion: allConfigs.awsTraceConfig?.region || "us-west-2",
              tencentRegion:
                allConfigs.tencentTraceConfig?.region || "ap-hongkong",
              tencentSecretId: allConfigs.tencentTraceConfig?.secretId || "",
              tencentSecretKey: allConfigs.tencentTraceConfig?.secretKey || "",
              tencentApmInstanceId:
                allConfigs.tencentTraceConfig?.apmInstanceId || "",
              jaegerEndpoint: allConfigs.jaegerTraceConfig?.endpoint || "",
            });

            // Load AWS region
            if (allConfigs.awsTraceConfig?.region) {
              setAwsRegion(allConfigs.awsTraceConfig.region);
            }
          }

          const resolvedProvider = resolveSelectedProvider(allConfigs);
          setSelectedProvider(resolvedProvider);
        } else {
          const resolvedProvider = resolveSelectedProvider(null);
          setSelectedProvider(resolvedProvider);
        }
      } catch (error) {
        console.error("Error loading trace provider settings:", error);
      }

      setIsLoaded(true);
    };

    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount - getAuthState just reads localStorage

  // Update settings when user changes
  useEffect(() => {
    const handleUserChange = () => {
      const savedSelection = loadProviderSelection("trace");
      if (savedSelection) {
        setSelectedProvider(savedSelection as TraceProvider);
      } else {
        // Reset to defaults for new user
        setSelectedProvider("aws");
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

  const handleProviderChange = useCallback(
    (value: TraceProvider) => {
      if (isUpdatingRef.current) return; // Prevent multiple rapid calls

      isUpdatingRef.current = true;
      setSelectedProvider(value);

      if (isLoaded) {
        saveProviderSelection("trace", value);

        // Sync to URL only when on /explore route
        if (window.location.pathname === "/explore") {
          const urlConfig = readProvidersFromURL();
          writeProvidersToURL({
            ...urlConfig,
            traceProvider: value,
            traceRegion:
              value === "aws"
                ? awsRegion
                : value === "tencent"
                  ? tencentRegion
                  : undefined,
          });
        }
      }

      // Reset the flag after a short delay
      setTimeout(() => {
        isUpdatingRef.current = false;
      }, 100);
    },
    [isLoaded, awsRegion, tencentRegion],
  );

  const handleRegionChange = useCallback((value: string) => {
    if (isUpdatingRegionRef.current) return; // Prevent multiple rapid calls

    isUpdatingRegionRef.current = true;
    setTencentRegion(value);

    // Sync to URL only when on /explore route
    if (window.location.pathname === "/explore") {
      const urlConfig = readProvidersFromURL();
      writeProvidersToURL({
        ...urlConfig,
        traceRegion: value,
      });
    }

    // Reset the flag after a short delay
    setTimeout(() => {
      isUpdatingRegionRef.current = false;
    }, 100);
  }, []);

  const handleAwsRegionChange = useCallback((value: string) => {
    if (isUpdatingAwsRegionRef.current) return; // Prevent multiple rapid calls

    isUpdatingAwsRegionRef.current = true;
    setAwsRegion(value);

    // Sync to URL only when on /explore route
    if (window.location.pathname === "/explore") {
      const urlConfig = readProvidersFromURL();
      writeProvidersToURL({
        ...urlConfig,
        traceRegion: value,
      });
    }

    // Reset the flag after a short delay
    setTimeout(() => {
      isUpdatingAwsRegionRef.current = false;
    }, 100);
  }, []);

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

  const awsRegions = [
    { value: "us-west-2", label: "US West (Oregon) - us-west-2" },
  ];

  const tencentRegions = [
    { value: "ap-hongkong", label: "Hong Kong (ap-hongkong)" },
    { value: "ap-beijing", label: "Beijing (ap-beijing)" },
    { value: "ap-shanghai", label: "Shanghai (ap-shanghai)" },
    { value: "ap-guangzhou", label: "Guangzhou (ap-guangzhou)" },
    { value: "ap-singapore", label: "Singapore (ap-singapore)" },
    { value: "na-siliconvalley", label: "Silicon Valley (na-siliconvalley)" },
  ];

  // Check if there's any data entered for the current provider
  const hasData = () => {
    if (selectedProvider === "aws") {
      return true; // AWS always has region data
    } else if (selectedProvider === "tencent") {
      return !!(tencentSecretId || tencentSecretKey || tencentApmInstanceId);
    } else if (selectedProvider === "jaeger") {
      return !!jaegerEndpoint;
    }
    return false;
  };

  // Check if all required fields are filled for the current provider
  const isFormValid = () => {
    if (selectedProvider === "tencent") {
      return !!(
        tencentRegion &&
        tencentSecretId &&
        tencentSecretKey &&
        tencentApmInstanceId
      );
    } else if (selectedProvider === "jaeger") {
      return !!jaegerEndpoint;
    }
    return true; // AWS doesn't need validation
  };

  // Check if current values differ from initial loaded values
  const hasChanges = () => {
    if (selectedProvider === "aws") {
      return awsRegion !== initialValues.awsRegion;
    } else if (selectedProvider === "tencent") {
      return (
        tencentRegion !== initialValues.tencentRegion ||
        tencentSecretId !== initialValues.tencentSecretId ||
        tencentSecretKey !== initialValues.tencentSecretKey ||
        tencentApmInstanceId !== initialValues.tencentApmInstanceId
      );
    } else if (selectedProvider === "jaeger") {
      return jaegerEndpoint !== initialValues.jaegerEndpoint;
    }
    return false;
  };

  const handleSaveClick = () => {
    setShowSaveDialog(true);
  };

  const handleSaveConfirm = async () => {
    try {
      setIsSaving(true);

      // Prepare config for current provider
      let currentProviderConfig: any = {};
      if (selectedProvider === "aws") {
        currentProviderConfig = {
          awsTraceConfig: {
            region: awsRegion,
          },
        };
      } else if (selectedProvider === "tencent") {
        currentProviderConfig = {
          tencentTraceConfig: {
            region: tencentRegion,
            secretId: tencentSecretId,
            secretKey: tencentSecretKey,
            apmInstanceId: tencentApmInstanceId,
          },
        };
      } else if (selectedProvider === "jaeger") {
        currentProviderConfig = {
          jaegerTraceConfig: {
            endpoint: jaegerEndpoint,
          },
        };
      }

      if (!mongoAvailable) {
        // MongoDB not available, save to localStorage only (provider-specific)
        // Only save if there are actual configuration values
        if (
          selectedProvider === "tencent" &&
          (tencentSecretId || tencentSecretKey || tencentApmInstanceId)
        ) {
          await saveSpecificProviderConfig(
            "trace",
            selectedProvider,
            currentProviderConfig,
          );
          // Save provider selection only when config is saved
          saveProviderSelection("trace", selectedProvider);
        } else if (selectedProvider === "jaeger" && jaegerEndpoint) {
          await saveSpecificProviderConfig(
            "trace",
            selectedProvider,
            currentProviderConfig,
          );
          // Save provider selection only when config is saved
          saveProviderSelection("trace", selectedProvider);
        }
        // AWS is disabled for now, so we don't save it
        setIsSaving(false);
        setShowSaveDialog(false);
        return;
      }

      // For MongoDB, only send the current provider's config
      // Don't merge with other providers from localStorage
      let configData = { ...currentProviderConfig };

      // Encrypt sensitive fields before sending to MongoDB
      if (selectedProvider === "tencent" && configData.tencentTraceConfig) {
        const { encryptSensitiveFields } = await import("@/utils/encryption");
        configData.tencentTraceConfig = await encryptSensitiveFields(
          configData.tencentTraceConfig,
          ["secretId", "secretKey"],
        );
      }

      // Save to MongoDB
      // Note: userEmail is no longer sent - API will get it from Clerk auth
      const payload: any = {
        traceProvider: selectedProvider,
        ...configData,
      };

      const response = await fetch("/api/provider-config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok) {
        console.error(
          "❌ [Frontend] Failed to save configuration:",
          data.error,
        );
      } else {
        // Update initial values after successful save
        setInitialValues({
          awsRegion,
          tencentRegion,
          tencentSecretId,
          tencentSecretKey,
          tencentApmInstanceId,
          jaegerEndpoint,
        });
        // Save provider selection after successful MongoDB save
        saveProviderSelection("trace", selectedProvider);

        // Also save to localStorage for quick access (used by sidebar and URL)
        await saveSpecificProviderConfig(
          "trace",
          selectedProvider,
          currentProviderConfig,
        );
      }
    } catch (error) {
      console.error("Error saving trace provider config:", error);
    } finally {
      setIsSaving(false);
      setShowSaveDialog(false);
    }
  };

  const handleDeleteClick = () => {
    setShowDeleteDialog(true);
  };

  const handleDeleteConfirm = async () => {
    try {
      setIsDeleting(true);

      // Reset to defaults
      const resetDefaults = () => {
        setAwsRegion("us-west-2");
        setTencentRegion("ap-hongkong");
        setTencentSecretId("");
        setTencentSecretKey("");
        setTencentApmInstanceId("");
        setJaegerEndpoint("");
      };

      if (!mongoAvailable) {
        // MongoDB not available, delete from localStorage only (provider-specific)
        deleteSpecificProviderConfig("trace", selectedProvider);
        // Clear provider selection after deleting config
        clearProviderSelection("trace");
        resetDefaults();
        // Switch back to AWS after deletion
        setSelectedProvider("aws");
        setIsDeleting(false);
        setShowDeleteDialog(false);
        return;
      }

      // Delete from MongoDB - API will get userEmail from Clerk auth
      // Pass provider parameter to delete only this provider's config
      const response = await fetch(
        `/api/provider-config?providerType=trace&provider=${selectedProvider}`,
        {
          method: "DELETE",
        },
      );

      const data = await response.json();

      if (response.ok) {
        resetDefaults();
        // Clear provider selection after deleting config
        clearProviderSelection("trace");
        // Switch back to AWS after deletion
        setSelectedProvider("aws");
        // Reset initial values after delete
        setInitialValues({
          awsRegion: "us-west-2",
          tencentRegion: "ap-hongkong",
          tencentSecretId: "",
          tencentSecretKey: "",
          tencentApmInstanceId: "",
          jaegerEndpoint: "",
        });
      } else {
        console.error("Failed to delete configuration:", data.error);
      }
    } catch (error) {
      console.error("Error deleting trace provider config:", error);
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

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
                onValueChange={handleProviderChange}
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
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="aws-trace-region">Region</Label>
                    <Select
                      value={awsRegion}
                      onValueChange={handleAwsRegionChange}
                    >
                      <SelectTrigger id="aws-trace-region">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {awsRegions.map((region) => (
                          <SelectItem key={region.value} value={region.value}>
                            {region.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="flex items-center gap-4 pt-2">
                    <Button onClick={handleSaveClick} disabled={true}>
                      <Save size={16} />
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={handleDeleteClick}
                      disabled={true}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {selectedProvider === "tencent" && (
              <div className="space-y-4 border-t pt-4">
                <h3 className="text-lg font-medium flex items-center space-x-2">
                  <BsTencentQq size={20} />
                  <span>Tencent Cloud Configuration</span>
                </h3>
                {!mongoAvailable && (
                  <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-md p-3">
                    <p className="text-sm text-yellow-800 dark:text-yellow-200">
                      MongoDB is not configured. Tencent Cloud settings will
                      only be stored locally.
                    </p>
                  </div>
                )}
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="tencent-trace-region">Region</Label>
                    <Select
                      value={tencentRegion}
                      onValueChange={handleRegionChange}
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
                    <div className="flex items-center gap-2">
                      <Label htmlFor="tencent-trace-secret-id">Secret ID</Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>
                            This credential will be encrypted before storage
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <div className="relative">
                      <Input
                        id="tencent-trace-secret-id"
                        type={showSecretId ? "text" : "password"}
                        placeholder="Enter your Secret ID"
                        value={tencentSecretId}
                        onChange={(e) => setTencentSecretId(e.target.value)}
                        className="pr-20"
                      />
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setShowSecretId(!showSecretId)}
                          disabled={!tencentSecretId}
                        >
                          {showSecretId ? (
                            <EyeOff size={14} />
                          ) : (
                            <Eye size={14} />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => copyToClipboard(tencentSecretId)}
                          disabled={!tencentSecretId}
                        >
                          <Copy size={14} />
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <div className="flex items-center gap-2">
                      <Label htmlFor="tencent-trace-secret-key">
                        Secret Key
                      </Label>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <ShieldCheck className="h-4 w-4 text-green-600 dark:text-green-400 cursor-help" />
                        </TooltipTrigger>
                        <TooltipContent>
                          <p>
                            This credential will be encrypted before storage
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    </div>
                    <div className="relative">
                      <Input
                        id="tencent-trace-secret-key"
                        type={showSecretKey ? "text" : "password"}
                        placeholder="Enter your Secret Key"
                        value={tencentSecretKey}
                        onChange={(e) => setTencentSecretKey(e.target.value)}
                        className="pr-20"
                      />
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setShowSecretKey(!showSecretKey)}
                          disabled={!tencentSecretKey}
                        >
                          {showSecretKey ? (
                            <EyeOff size={14} />
                          ) : (
                            <Eye size={14} />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => copyToClipboard(tencentSecretKey)}
                          disabled={!tencentSecretKey}
                        >
                          <Copy size={14} />
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="tencent-apm-instance-id">
                      APM Instance ID
                    </Label>
                    <div className="relative">
                      <Input
                        id="tencent-apm-instance-id"
                        type={showApmInstanceId ? "text" : "password"}
                        placeholder="Enter your APM Instance ID"
                        value={tencentApmInstanceId}
                        onChange={(e) =>
                          setTencentApmInstanceId(e.target.value)
                        }
                        className="pr-20"
                      />
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() =>
                            setShowApmInstanceId(!showApmInstanceId)
                          }
                          disabled={!tencentApmInstanceId}
                        >
                          {showApmInstanceId ? (
                            <EyeOff size={14} />
                          ) : (
                            <Eye size={14} />
                          )}
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => copyToClipboard(tencentApmInstanceId)}
                          disabled={!tencentApmInstanceId}
                        >
                          <Copy size={14} />
                        </Button>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 pt-2">
                    <Button
                      onClick={handleSaveClick}
                      disabled={
                        isSaving ||
                        isDeleting ||
                        !isFormValid() ||
                        !hasChanges()
                      }
                    >
                      <Save size={16} />
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={handleDeleteClick}
                      disabled={isDeleting || isSaving || !hasData()}
                    >
                      <Trash2 size={16} />
                    </Button>
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
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="jaeger-endpoint">Jaeger Endpoint</Label>
                    <div className="relative">
                      <Input
                        id="jaeger-endpoint"
                        type="url"
                        placeholder="https://your-jaeger-endpoint.com"
                        value={jaegerEndpoint}
                        onChange={(e) => setJaegerEndpoint(e.target.value)}
                        className="pr-12"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-2 top-1/2 -translate-y-1/2 h-7 w-7"
                        onClick={() => copyToClipboard(jaegerEndpoint)}
                        disabled={!jaegerEndpoint}
                      >
                        <Copy size={14} />
                      </Button>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 pt-2">
                    <Button
                      onClick={handleSaveClick}
                      disabled={
                        isSaving ||
                        isDeleting ||
                        !isFormValid() ||
                        !hasChanges()
                      }
                    >
                      <Save size={16} />
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={handleDeleteClick}
                      disabled={isDeleting || isSaving || !hasData()}
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog open={showSaveDialog} onOpenChange={setShowSaveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Save Configuration</DialogTitle>
            <DialogDescription>
              Are you sure you want to save the trace provider configuration?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowSaveDialog(false)}
              disabled={isSaving}
            >
              Cancel
            </Button>
            <Button onClick={handleSaveConfirm} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Configuration</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete your trace provider configuration?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowDeleteDialog(false)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeleteConfirm}
              disabled={isDeleting}
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
