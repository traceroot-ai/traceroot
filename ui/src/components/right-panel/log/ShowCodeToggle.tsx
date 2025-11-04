"use client";

import React, { useState, useEffect } from "react";
import { FaCode } from "react-icons/fa";
import { LogEntry } from "@/models/log";
import { CodeResponse } from "@/models/code";
import { useAuth } from "@clerk/nextjs";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ShowCodeToggleProps {
  logEntries: { entry: LogEntry; spanId: string }[];
  onLogEntriesUpdate?: () => void;
  showCode: boolean;
  onShowCodeChange: (showCode: boolean) => void;
}

export default function ShowCodeToggle({
  logEntries,
  onLogEntriesUpdate,
  showCode,
  onShowCodeChange,
}: ShowCodeToggleProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { getToken } = useAuth();

  // Function to clear all code data from log entries
  const clearCodeDataFromLogEntries = () => {
    logEntries.forEach(({ entry }) => {
      entry.line = undefined;
      entry.lines_above = undefined;
      entry.lines_below = undefined;
    });
  };

  // Ensure code data is cleared whenever showCode changes to false
  useEffect(() => {
    if (!showCode) {
      clearCodeDataFromLogEntries();
      if (onLogEntriesUpdate) {
        onLogEntriesUpdate();
      }
    }
  }, [showCode]); // Only depend on showCode to prevent infinite loops

  // Ensure code data is cleared when component mounts or log entries change if showCode is false
  // This handles cases where user switches between panels and returns with existing code data
  useEffect(() => {
    if (
      !showCode &&
      logEntries.some(
        ({ entry }) => entry.line || entry.lines_above || entry.lines_below,
      )
    ) {
      clearCodeDataFromLogEntries();
      if (onLogEntriesUpdate) {
        onLogEntriesUpdate();
      }
    }
  }, [logEntries.length, showCode]); // Depend on logEntries.length to avoid infinite loops but still detect changes

  // Auto-dismiss error popup after 30 seconds
  useEffect(() => {
    if (errorMessage) {
      const timer = setTimeout(() => {
        setErrorMessage(null);
      }, 30000); // 30 seconds

      return () => clearTimeout(timer);
    }
  }, [errorMessage]);

  const handleToggle = async () => {
    if (showCode) {
      // Clear code data from log entries when hiding code
      clearCodeDataFromLogEntries();

      // Notify parent component to re-render
      if (onLogEntriesUpdate) {
        onLogEntriesUpdate();
      }

      onShowCodeChange(false);
      return;
    }

    setIsLoading(true);
    setErrorMessage(null);
    try {
      // Get unique git URLs from log entries
      const uniqueGitUrls = [
        ...new Set(
          logEntries.map(({ entry }) => entry.git_url).filter((url) => url), // Filter out null/undefined URLs
        ),
      ];

      // Get user token for authentication
      const token = await getToken();

      // Fetch code content for each unique git URL
      const promises = uniqueGitUrls.map(async (gitUrl) => {
        try {
          const headers: Record<string, string> = {
            "Content-Type": "application/json",
          };

          // Add Authorization header if token is available
          if (token) {
            headers["Authorization"] = `Bearer ${token}`;
          }

          console.log(`Fetching code content for ${gitUrl}`);
          const response = await fetch(
            `/api/get_line_context_content?url=${encodeURIComponent(gitUrl!)}`,
            {
              headers,
            },
          );
          const data: CodeResponse = await response.json();
          return { gitUrl, data };
        } catch (error) {
          console.error(`Failed to fetch code for ${gitUrl}:`, error);
          return { gitUrl, data: null };
        }
      });

      const results = await Promise.all(promises);

      // Check for error messages in responses
      const errors: string[] = [];
      results.forEach(({ gitUrl, data }) => {
        if (data?.error_message) {
          errors.push(`Error for ${gitUrl}: ${data.error_message}`);
        }
      });

      // If there are errors, show popup and don't proceed with showing code
      if (errors.length > 0) {
        setErrorMessage(errors.join("\n"));
        setIsLoading(false);
        return;
      }

      // Create a map of git_url to code data for easy lookup
      const codeDataMap = new Map<string, CodeResponse>();
      results.forEach(({ gitUrl, data }) => {
        if (data && gitUrl) {
          codeDataMap.set(gitUrl, data);
        }
      });

      // Update log entries with code data only if showCode is still false (meaning we want to turn it on)
      // This prevents race conditions where toggle might be turned off while we're processing
      if (!showCode) {
        logEntries.forEach(({ entry }) => {
          if (entry.git_url && codeDataMap.has(entry.git_url)) {
            const codeData = codeDataMap.get(entry.git_url);
            if (codeData) {
              entry.line = codeData.line || undefined;
              entry.lines_above = codeData.lines_above || undefined;
              entry.lines_below = codeData.lines_below || undefined;
            }
          }
        });

        // Notify parent component to re-render
        if (onLogEntriesUpdate) {
          onLogEntriesUpdate();
        }

        onShowCodeChange(true);
      } else {
        // If showCode became true while we were processing, clear any code data
        clearCodeDataFromLogEntries();
        if (onLogEntriesUpdate) {
          onLogEntriesUpdate();
        }
      }
    } catch (error) {
      console.error("Error fetching code content:", error);
      setErrorMessage("Failed to fetch code content. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  const closeErrorPopup = () => {
    setErrorMessage(null);
  };

  return (
    <>
      <div className="flex items-center space-x-3 mr-3">
        <Switch
          id="show-code-toggle"
          checked={showCode}
          onCheckedChange={handleToggle}
          disabled={isLoading}
          title={showCode ? "Hide code context" : "Show code context"}
        />
        <Label
          htmlFor="show-code-toggle"
          className="flex items-center space-x-2 text-sm cursor-pointer"
        >
          <FaCode className={`w-4 h-4 ${isLoading ? "animate-spin" : ""}`} />
        </Label>
      </div>

      {/* Error Dialog */}
      <Dialog
        open={!!errorMessage}
        onOpenChange={(open) => !open && closeErrorPopup()}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-red-600 dark:text-red-400">
              Code Loading Error
            </DialogTitle>
            <DialogDescription className="text-red-700 dark:text-red-300 whitespace-pre-line">
              {errorMessage}
            </DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}
