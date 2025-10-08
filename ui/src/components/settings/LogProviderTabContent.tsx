import React, { useState, useEffect, useCallback, useRef } from "react";
import {
  Cloud,
  Trash2,
  Save,
  Copy,
  Eye,
  EyeOff,
  ShieldCheck,
} from "lucide-react";
import { useAuth } from "@clerk/nextjs";
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
  applyLogConfig,
  saveSpecificProviderConfig,
  deleteSpecificProviderConfig,
  loadAllProviderConfigs,
  writeProvidersToURL,
  readProvidersFromURL,
} from "@/utils/provider";

type LogProvider = "aws" | "tencent" | "jaeger";

export function LogProviderTabContent() {
  const { getToken } = useAuth();
  const [selectedProvider, setSelectedProvider] = useState<LogProvider>("aws");
  const isUpdatingRef = useRef(false);
  const isUpdatingRegionRef = useRef(false);
  const isUpdatingAwsRegionRef = useRef(false);
  const [awsRegion, setAwsRegion] = useState("us-west-2");
  const [tencentRegion, setTencentRegion] = useState("ap-hongkong");
  const [tencentSecretId, setTencentSecretId] = useState("");
  const [tencentSecretKey, setTencentSecretKey] = useState("");
  const [tencentClsTopicId, setTencentClsTopicId] = useState("");
  const [jaegerEndpoint, setJaegerEndpoint] = useState("");
  const [isLoaded, setIsLoaded] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [mongoAvailable, setMongoAvailable] = useState(true);
  const [showSecretId, setShowSecretId] = useState(false);
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [showClsTopicId, setShowClsTopicId] = useState(false);
  const [showSaveDialog, setShowSaveDialog] = useState(false);
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);

  // Track initial loaded values to detect changes
  const [initialValues, setInitialValues] = useState({
    awsRegion: "us-west-2",
    tencentRegion: "ap-hongkong",
    tencentSecretId: "",
    tencentSecretKey: "",
    tencentClsTopicId: "",
    jaegerEndpoint: "",
  });

  // Load saved data from API and localStorage on component mount
  useEffect(() => {
    const loadConfig = async () => {
      const userEmail = getUserEmail();
      if (!userEmail) {
        setIsLoaded(true);
        return;
      }

      try {
        // Load selected provider from localStorage first
        const savedSelection = loadProviderSelection(
          "log",
        ) as LogProvider | null;

        const providerHasStoredConfig = (
          provider: LogProvider | null,
          config: any,
        ) => {
          if (!provider || !config) return false;

          if (provider === "aws") {
            return Boolean(config.awsLogConfig?.region);
          }

          if (provider === "tencent") {
            const tencentConfig = config.tencentLogConfig;
            if (!tencentConfig) return false;
            return Boolean(
              tencentConfig.secretId ||
                tencentConfig.secretKey ||
                tencentConfig.clsTopicId,
            );
          }

          if (provider === "jaeger") {
            return Boolean(config.jaegerLogConfig?.endpoint);
          }

          return false;
        };

        const resolveSelectedProvider = (config: any): LogProvider => {
          if (savedSelection) {
            if (providerHasStoredConfig(savedSelection, config)) {
              return savedSelection;
            }

            if (savedSelection !== "aws") {
              saveProviderSelection("log", "aws");
            }
            return "aws";
          }

          const storedProvider = config?.logProvider as LogProvider | undefined;
          if (
            storedProvider &&
            providerHasStoredConfig(storedProvider, config)
          ) {
            saveProviderSelection("log", storedProvider);
            return storedProvider;
          }

          return "aws";
        };

        // Try to fetch from API - server will tell us if MongoDB is available
        const authToken = await getToken();
        const response = await fetch(
          `/api/provider-config?userEmail=${encodeURIComponent(userEmail)}`,
          {
            headers: {
              Authorization: `Bearer ${authToken}`,
            },
          },
        );
        const data = await response.json();

        if (response.ok) {
          // Server confirms MongoDB is available
          setMongoAvailable(data.mongoAvailable !== false);

          // Decrypt sensitive fields from MongoDB
          let decryptedConfig = data.config ? { ...data.config } : null;
          if (decryptedConfig?.tencentLogConfig) {
            const { decryptSensitiveFields } = await import(
              "@/utils/encryption"
            );
            decryptedConfig.tencentLogConfig = await decryptSensitiveFields(
              decryptedConfig.tencentLogConfig,
              ["secretId", "secretKey"],
            );
          }

          if (decryptedConfig) {
            // Load configuration details from MongoDB
            applyLogConfig(decryptedConfig, {
              setTencentRegion,
              setTencentSecretId,
              setTencentSecretKey,
              setJaegerEndpoint,
              setTencentTopicId: setTencentClsTopicId,
            });

            // Store initial values (use decrypted config)
            setInitialValues({
              awsRegion: decryptedConfig.awsLogConfig?.region || "us-west-2",
              tencentRegion:
                decryptedConfig.tencentLogConfig?.region || "ap-hongkong",
              tencentSecretId: decryptedConfig.tencentLogConfig?.secretId || "",
              tencentSecretKey:
                decryptedConfig.tencentLogConfig?.secretKey || "",
              tencentClsTopicId:
                decryptedConfig.tencentLogConfig?.clsTopicId || "",
              jaegerEndpoint: decryptedConfig.jaegerLogConfig?.endpoint || "",
            });

            // Load AWS region
            if (decryptedConfig.awsLogConfig?.region) {
              setAwsRegion(decryptedConfig.awsLogConfig.region);
            }
          }

          const resolvedProvider = resolveSelectedProvider(decryptedConfig);
          setSelectedProvider(resolvedProvider);
        } else if (response.status === 503) {
          // Server says MongoDB not available, load from localStorage
          setMongoAvailable(false);

          // Load all provider configs separately
          const allConfigs = await loadAllProviderConfigs("log");
          if (allConfigs && Object.keys(allConfigs).length > 0) {
            applyLogConfig(allConfigs, {
              setTencentRegion,
              setTencentSecretId,
              setTencentSecretKey,
              setJaegerEndpoint,
              setTencentTopicId: setTencentClsTopicId,
            });

            // Store initial values
            setInitialValues({
              awsRegion: allConfigs.awsLogConfig?.region || "us-west-2",
              tencentRegion:
                allConfigs.tencentLogConfig?.region || "ap-hongkong",
              tencentSecretId: allConfigs.tencentLogConfig?.secretId || "",
              tencentSecretKey: allConfigs.tencentLogConfig?.secretKey || "",
              tencentClsTopicId: allConfigs.tencentLogConfig?.clsTopicId || "",
              jaegerEndpoint: allConfigs.jaegerLogConfig?.endpoint || "",
            });

            // Load AWS region
            if (allConfigs.awsLogConfig?.region) {
              setAwsRegion(allConfigs.awsLogConfig.region);
            }
          }

          const resolvedProvider = resolveSelectedProvider(allConfigs);
          setSelectedProvider(resolvedProvider);
        } else {
          const resolvedProvider = resolveSelectedProvider(null);
          setSelectedProvider(resolvedProvider);
        }
      } catch (error) {
        console.error("Error loading log provider settings:", error);
      }

      setIsLoaded(true);
    };

    loadConfig();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run once on mount - getAuthState just reads localStorage

  // Update settings when user changes
  useEffect(() => {
    const handleUserChange = () => {
      const savedSelection = loadProviderSelection("log");
      if (savedSelection) {
        setSelectedProvider(savedSelection as LogProvider);
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
    (value: LogProvider) => {
      if (isUpdatingRef.current) return; // Prevent multiple rapid calls

      isUpdatingRef.current = true;
      setSelectedProvider(value);

      if (isLoaded) {
        saveProviderSelection("log", value);

        // Sync to URL only when on /explore route
        if (window.location.pathname === "/explore") {
          const urlConfig = readProvidersFromURL();
          writeProvidersToURL({
            ...urlConfig,
            logProvider: value,
            logRegion:
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
        logRegion: value,
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
        logRegion: value,
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
  ];

  // Check if there's any data entered for the current provider
  const hasData = () => {
    if (selectedProvider === "aws") {
      return true; // AWS always has region data
    } else if (selectedProvider === "tencent") {
      return !!(tencentSecretId || tencentSecretKey || tencentClsTopicId);
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
        tencentClsTopicId
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
        tencentClsTopicId !== initialValues.tencentClsTopicId
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
    const userEmail = getUserEmail();
    if (!userEmail) {
      setShowSaveDialog(false);
      return;
    }

    try {
      setIsSaving(true);

      // Prepare config for current provider
      let currentProviderConfig: any = {};
      if (selectedProvider === "aws") {
        currentProviderConfig = {
          awsLogConfig: {
            region: awsRegion,
          },
        };
      } else if (selectedProvider === "tencent") {
        currentProviderConfig = {
          tencentLogConfig: {
            region: tencentRegion,
            secretId: tencentSecretId,
            secretKey: tencentSecretKey,
            clsTopicId: tencentClsTopicId,
          },
        };
      } else if (selectedProvider === "jaeger") {
        currentProviderConfig = {
          jaegerLogConfig: {
            endpoint: jaegerEndpoint,
          },
        };
      }

      if (!mongoAvailable) {
        // MongoDB not available, save to localStorage only (provider-specific)
        // Only save if there are actual configuration values
        if (
          selectedProvider === "tencent" &&
          (tencentSecretId || tencentSecretKey || tencentClsTopicId)
        ) {
          await saveSpecificProviderConfig(
            "log",
            selectedProvider,
            currentProviderConfig,
          );
          // Save provider selection only when config is saved
          saveProviderSelection("log", selectedProvider);
        } else if (selectedProvider === "jaeger" && jaegerEndpoint) {
          await saveSpecificProviderConfig(
            "log",
            selectedProvider,
            currentProviderConfig,
          );
          // Save provider selection only when config is saved
          saveProviderSelection("log", selectedProvider);
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
      if (selectedProvider === "tencent" && configData.tencentLogConfig) {
        const { encryptSensitiveFields } = await import("@/utils/encryption");
        configData.tencentLogConfig = await encryptSensitiveFields(
          configData.tencentLogConfig,
          ["secretId", "secretKey"],
        );
      }

      // Save to MongoDB
      const payload: any = {
        userEmail,
        logProvider: selectedProvider,
        ...configData,
      };

      const authToken = await getToken();
      const response = await fetch("/api/provider-config", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(payload),
      });

      const data = await response.json();

      if (!response.ok) {
        console.error("Failed to save configuration:", data.error);
      } else {
        // Update initial values after successful save
        setInitialValues({
          awsRegion,
          tencentRegion,
          tencentSecretId,
          tencentSecretKey,
          tencentClsTopicId,
          jaegerEndpoint,
        });
        // Save provider selection after successful MongoDB save
        saveProviderSelection("log", selectedProvider);

        // Also save to localStorage for quick access (used by sidebar and URL)
        await saveSpecificProviderConfig(
          "log",
          selectedProvider,
          currentProviderConfig,
        );
      }
    } catch (error) {
      console.error("Error saving log provider config:", error);
    } finally {
      setIsSaving(false);
      setShowSaveDialog(false);
    }
  };

  const handleDeleteClick = () => {
    setShowDeleteDialog(true);
  };

  const handleDeleteConfirm = async () => {
    const userEmail = getUserEmail();
    if (!userEmail) {
      setShowDeleteDialog(false);
      return;
    }

    try {
      setIsDeleting(true);

      // Reset to defaults
      const resetDefaults = () => {
        setAwsRegion("us-west-2");
        setTencentRegion("ap-hongkong");
        setTencentSecretId("");
        setTencentSecretKey("");
        setTencentClsTopicId("");
        setJaegerEndpoint("");
      };

      if (!mongoAvailable) {
        // MongoDB not available, delete from localStorage only (provider-specific)
        deleteSpecificProviderConfig("log", selectedProvider);
        // Clear provider selection after deleting config
        clearProviderSelection("log");
        resetDefaults();
        // Switch back to AWS after deletion
        setSelectedProvider("aws");
        setIsDeleting(false);
        setShowDeleteDialog(false);
        return;
      }

      // Delete from MongoDB
      const authToken = await getToken();
      const response = await fetch(
        `/api/provider-config?userEmail=${encodeURIComponent(
          userEmail,
        )}&providerType=log`,
        {
          method: "DELETE",
          headers: {
            Authorization: `Bearer ${authToken}`,
          },
        },
      );

      if (response.ok) {
        resetDefaults();
        // Clear provider selection after deleting config
        clearProviderSelection("log");
        // Switch back to AWS after deletion
        setSelectedProvider("aws");
        // Reset initial values after delete
        setInitialValues({
          awsRegion: "us-west-2",
          tencentRegion: "ap-hongkong",
          tencentSecretId: "",
          tencentSecretKey: "",
          tencentClsTopicId: "",
          jaegerEndpoint: "",
        });
      } else {
        const data = await response.json();
        console.error("Failed to delete configuration:", data.error);
      }
    } catch (error) {
      console.error("Error deleting log provider config:", error);
    } finally {
      setIsDeleting(false);
      setShowDeleteDialog(false);
    }
  };

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
                onValueChange={handleProviderChange}
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
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="aws-log-region">Region</Label>
                    <Select
                      value={awsRegion}
                      onValueChange={handleAwsRegionChange}
                    >
                      <SelectTrigger id="aws-log-region">
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
                    <Label htmlFor="tencent-log-region">Region</Label>
                    <Select
                      value={tencentRegion}
                      onValueChange={handleRegionChange}
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
                    <div className="flex items-center gap-2">
                      <Label htmlFor="tencent-log-secret-id">Secret ID</Label>
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
                        id="tencent-log-secret-id"
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
                      <Label htmlFor="tencent-log-secret-key">Secret Key</Label>
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
                        id="tencent-log-secret-key"
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
                    <Label htmlFor="tencent-cls-topic-id">CLS Topic ID</Label>
                    <div className="relative">
                      <Input
                        id="tencent-cls-topic-id"
                        type={showClsTopicId ? "text" : "password"}
                        placeholder="Enter your CLS Topic ID"
                        value={tencentClsTopicId}
                        onChange={(e) => setTencentClsTopicId(e.target.value)}
                        className="pr-20"
                      />
                      <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={() => setShowClsTopicId(!showClsTopicId)}
                          disabled={!tencentClsTopicId}
                        >
                          {showClsTopicId ? (
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
                          onClick={() => copyToClipboard(tencentClsTopicId)}
                          disabled={!tencentClsTopicId}
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
                    <Label htmlFor="jaeger-log-endpoint">Jaeger Endpoint</Label>
                    <div className="relative">
                      <Input
                        id="jaeger-log-endpoint"
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
              Are you sure you want to save the log provider configuration?
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
              Are you sure you want to delete your log provider configuration?
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
