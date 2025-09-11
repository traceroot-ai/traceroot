"use client";

import React, { useState, useEffect } from "react";
import { TbEye, TbEyeOff } from "react-icons/tb";
import { FiCopy } from "react-icons/fi";
import { FaGithub } from "react-icons/fa";
import { SiNotion, SiSlack, SiOpenai, SiAnthropic } from "react-icons/si";
import { Groq } from "@lobehub/icons";
import { FaCheck } from "react-icons/fa";
import { Integration } from "@/types/integration";
import { TokenResource, ResourceType } from "@/models/integrate";
import { useUser } from "@/hooks/useUser";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { useTheme } from "next-themes";

interface ItemProps {
  integration: Integration;
  onUpdateIntegration?: (integration: Integration) => void;
}

export default function Item({ integration, onUpdateIntegration }: ItemProps) {
  const { theme } = useTheme();
  const [authSecret, setAuthSecret] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showError, setShowError] = useState(false);
  const [displayToken, setDisplayToken] = useState<string>("");
  const [isEditing, setIsEditing] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const { user, getAuthState } = useUser();

  // Initialize display token from integration
  useEffect(() => {
    setDisplayToken(integration.token || "");
  }, [integration.token]);

  const renderIcon = (iconName: string, size: number = 24) => {
    const getIconElement = () => {
      switch (iconName) {
        case "github":
          return <FaGithub size={size} className="text-foreground" />;
        case "notion":
          return <SiNotion size={size} className="text-foreground" />;
        case "slack":
          return <SiSlack size={size} className="text-foreground" />;
        case "openai":
          return <SiOpenai size={size} className="text-foreground" />;
        case "groq":
          return <Groq size={size} className="text-foreground" />;
        case "anthropic":
          return <SiAnthropic size={size} className="text-foreground" />;
        case "traceroot":
          return (
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className={`h-6 w-6 ${theme === "dark" ? "text-black" : "text-white"}`}
              viewBox="0 0 22 22"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="11" cy="3" r="2.5" />
              <circle cx="5" cy="11" r="2.5" />
              <circle cx="17" cy="11" r="2.5" />
              <line x1="11" y1="5.5" x2="11" y2="7.5" />
              <line x1="11" y1="7.5" x2="7" y2="9.5" />
              <line x1="11" y1="7.5" x2="15" y2="9.5" />
              <line x1="5" y1="13.5" x2="5" y2="16.5" />
              <line x1="17" y1="13.5" x2="17" y2="16.5" />
              <circle cx="5" cy="19" r="2.5" />
              <circle cx="17" cy="19" r="2.5" />
            </svg>
          );
        default:
          return (
            <span className="text-lg font-semibold text-foreground">
              {iconName}
            </span>
          );
      }
    };

    return (
      <Avatar className="size-9 rounded-md">
        <AvatarFallback
          className={`rounded-md ${iconName === "traceroot" ? (theme === "dark" ? "bg-white" : "bg-black") : "bg-muted"}`}
        >
          {getIconElement()}
        </AvatarFallback>
      </Avatar>
    );
  };

  const getResourceType = (integrationName: string): ResourceType => {
    switch (integrationName.toLowerCase()) {
      case "github":
        return ResourceType.GITHUB;
      case "notion":
        return ResourceType.NOTION;
      case "slack":
        return ResourceType.SLACK;
      case "openai":
        return ResourceType.OPENAI;
      case "groq":
        return ResourceType.GROQ;
      case "traceroot":
        return ResourceType.TRACEROOT;
      default:
        return ResourceType.GITHUB;
    }
  };

  const handleGenerateToken = async () => {
    // Check if user is authenticated (skip if in local mode)
    const authState = getAuthState();
    // Show error if there is no NEXT_PUBLIC_LOCAL_MODE or
    // NEXT_PUBLIC_LOCAL_MODE is not set or not 'true', and no authState
    if (
      !process.env.NEXT_PUBLIC_LOCAL_MODE ||
      process.env.NEXT_PUBLIC_LOCAL_MODE !== "true"
    ) {
      if (!authState) {
        setShowError(true);
        setTimeout(() => setShowError(false), 2000);
        return;
      }
    }

    setIsLoading(true);
    setShowError(false);

    try {
      // Use the existing post_connect endpoint with null token to generate TraceRoot token
      const response = await fetch("/api/post_connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authState}`,
        },
        body: JSON.stringify({
          token: null,
          resourceType: ResourceType.TRACEROOT,
        }),
      });

      const result = await response.json();

      if (result.success) {
        // Update the display token with the generated token
        const newToken = result.token;
        setDisplayToken(newToken);
        setAuthSecret(""); // Clear the input field
        setIsEditing(false); // Reset editing state

        // Update the integration with the new token
        const updatedIntegration: Integration = {
          ...integration,
          token: newToken,
          connected: true,
        };

        if (onUpdateIntegration) {
          onUpdateIntegration(updatedIntegration);
        }
      } else {
        console.error("Failed to generate token:", result.error);
        setShowError(true);
        setTimeout(() => setShowError(false), 2000);
      }
    } catch (error) {
      console.error("Error generating token:", error);
      setShowError(true);
      setTimeout(() => setShowError(false), 2000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSaveConfiguration = async () => {
    // Check if token is null or empty
    if (!authSecret.trim()) {
      setShowError(true);
      // Remove red border after 2 seconds
      setTimeout(() => setShowError(false), 2000);
      return;
    }

    // Check if user is authenticated (skip if in local mode)
    const authState = getAuthState();
    // Show error if there is no NEXT_PUBLIC_LOCAL_MODE or
    // NEXT_PUBLIC_LOCAL_MODE is not set or not 'true', and no authState
    if (
      !process.env.NEXT_PUBLIC_LOCAL_MODE ||
      process.env.NEXT_PUBLIC_LOCAL_MODE !== "true"
    ) {
      if (!authState) {
        setShowError(true);
        setTimeout(() => setShowError(false), 2000);
        return;
      }
    }

    setIsLoading(true);
    setShowError(false);

    try {
      const tokenResource: TokenResource = {
        token: authSecret,
        resourceType: getResourceType(integration.id),
      };

      const response = await fetch("/api/post_connect", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authState}`,
        },
        body: JSON.stringify(tokenResource),
      });

      const result = await response.json();

      if (result.success) {
        // Update the display token with the returned token or the input token
        const newToken = result.token || authSecret;
        setDisplayToken(newToken);
        setAuthSecret(""); // Clear the input field
        setIsEditing(false); // Reset editing state

        // Update the integration with the new token
        const updatedIntegration: Integration = {
          ...integration,
          token: newToken,
          connected: true,
        };

        if (onUpdateIntegration) {
          onUpdateIntegration(updatedIntegration);
        }
      } else {
        console.error("Failed to save configuration:", result.error);
        setShowError(true);
        setTimeout(() => setShowError(false), 2000);
      }
    } catch (error) {
      console.error("Error saving configuration:", error);
      setShowError(true);
      setTimeout(() => setShowError(false), 2000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async () => {
    // If there's no token to remove, just reset the form
    if (!displayToken) {
      setAuthSecret("");
      setDisplayToken("");
      setShowError(false);
      return;
    }

    const authState = getAuthState();
    // Show error if there is no NEXT_PUBLIC_LOCAL_MODE or
    // NEXT_PUBLIC_LOCAL_MODE is not set or not 'true', and no authState
    if (
      !process.env.NEXT_PUBLIC_LOCAL_MODE ||
      process.env.NEXT_PUBLIC_LOCAL_MODE !== "true"
    ) {
      if (!authState) {
        setShowError(true);
        setTimeout(() => setShowError(false), 2000);
        return;
      }
    }

    setIsLoading(true);
    setShowError(false);

    try {
      const response = await fetch("/api/delete_connect", {
        method: "DELETE",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${authState}`,
        },
        body: JSON.stringify({
          resource_type: getResourceType(integration.id),
        }),
      });

      const result = await response.json();

      if (result.success) {
        // Reset form and clear token
        setAuthSecret("");
        setDisplayToken("");
        setShowError(false);
        setIsEditing(false); // Reset editing state

        // Update the integration to remove token
        const updatedIntegration: Integration = {
          ...integration,
          token: null,
          connected: false,
        };

        if (onUpdateIntegration) {
          onUpdateIntegration(updatedIntegration);
        }
      } else {
        console.error("Failed to remove configuration:", result.error);
        setShowError(true);
        setTimeout(() => setShowError(false), 2000);
      }
    } catch (error) {
      console.error("Error removing configuration:", error);
      setShowError(true);
      setTimeout(() => setShowError(false), 2000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyToken = async () => {
    const tokenToCopy = isEditing ? authSecret : displayToken || authSecret;
    if (tokenToCopy) {
      try {
        await navigator.clipboard.writeText(tokenToCopy);
        setIsCopied(true);
        // Reset the copied state after 2 seconds
        setTimeout(() => setIsCopied(false), 2000);
      } catch (err) {
        console.error("Failed to copy token:", err);
      }
    }
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center space-x-2.5">
          {renderIcon(integration.icon)}
          <div className="flex-1 min-w-0">
            <CardTitle className="text-base font-semibold truncate">
              {integration.name}
            </CardTitle>
            <CardDescription className="text-sm underline truncate">
              <a
                href={integration.docs}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs"
              >
                {integration.description}
              </a>
            </CardDescription>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        <div className="flex flex-wrap gap-1">
          {/* Status Badge - First */}
          <Badge
            variant={integration.connected ? "default" : "secondary"}
            className={
              integration.connected
                ? "bg-lime-600 text-white hover:bg-lime-600 text-xs px-2 py-0.5"
                : "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 text-xs px-2 py-0.5"
            }
          >
            {integration.connected ? "Connected" : "Disconnected"}
          </Badge>

          {/* Category Tags - Show max 3, then +N */}
          {integration.categories.slice(0, 3).map((category, index) => (
            <Badge
              key={index}
              variant="outline"
              className="text-xs px-1.5 py-0.5"
            >
              {category}
            </Badge>
          ))}
          {integration.categories.length > 3 && (
            <Badge variant="outline" className="text-xs px-1.5 py-0.5">
              +{integration.categories.length - 3}
            </Badge>
          )}
        </div>

        {/* Configuration Section */}
        <div className="space-y-6">
          <div className="relative font-mono">
            <Input
              type={showSecret ? "text" : "password"}
              value={isEditing ? authSecret : displayToken || authSecret}
              onChange={(e) => {
                // Only allow editing if not TraceRoot
                if (integration.id !== "traceroot") {
                  setAuthSecret(e.target.value);
                  if (!isEditing) setIsEditing(true);
                }
              }}
              onFocus={() => {
                // Only allow editing if not TraceRoot
                if (
                  integration.id !== "traceroot" &&
                  displayToken &&
                  !isEditing
                ) {
                  setAuthSecret(displayToken);
                  setIsEditing(true);
                }
              }}
              placeholder={
                integration.id === "traceroot"
                  ? "Generate the TraceRoot token"
                  : `Enter your ${integration.name} Authentication`
              }
              readOnly={integration.id === "traceroot"}
              aria-invalid={showError}
              className={`${
                integration.id === "traceroot" ? "pr-20" : "pr-10"
              } ${integration.id === "traceroot" ? "cursor-not-allowed" : ""}`}
            />

            {/* Copy button for TraceRoot only */}
            {integration.id === "traceroot" && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={handleCopyToken}
                className="absolute inset-y-0 right-10 h-auto w-auto p-1 hover:bg-transparent"
              >
                {isCopied ? <FaCheck size={12} /> : <FiCopy size={20} />}
              </Button>
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setShowSecret(!showSecret)}
              className="absolute inset-y-0 right-0 h-auto w-auto p-1 pr-3 hover:bg-transparent"
            >
              {showSecret ? <TbEyeOff size={20} /> : <TbEye size={20} />}
            </Button>
          </div>

          <div className="flex gap-2">
            {integration.id === "traceroot" ? (
              <Button
                onClick={handleGenerateToken}
                disabled={isLoading}
                variant="default"
                size="sm"
                className="flex-1"
              >
                {isLoading ? "Generating..." : "Generate"}
              </Button>
            ) : (
              <Button
                onClick={handleSaveConfiguration}
                disabled={isLoading}
                variant="default"
                size="sm"
                className="flex-1"
              >
                {isLoading ? "Saving..." : "Save"}
              </Button>
            )}
            <Button
              onClick={handleCancel}
              disabled={isLoading}
              variant="outline"
              size="sm"
              className="flex-1"
            >
              {isLoading ? "Removing..." : "Remove"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
