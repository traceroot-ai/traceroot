'use client';

import React, { useState, useEffect } from 'react';
import { FaCode } from 'react-icons/fa';
import { LogEntry } from '@/models/log';
import { CodeResponse } from '@/models/code';
import { useUser } from '@/hooks/useUser';

interface ShowCodeToggleProps {
  logEntries: { entry: LogEntry; spanId: string }[];
  onLogEntriesUpdate?: () => void;
  showCode: boolean;
  onShowCodeChange: (showCode: boolean) => void;
}

export default function ShowCodeToggle({ logEntries, onLogEntriesUpdate, showCode, onShowCodeChange }: ShowCodeToggleProps) {
  const [isLoading, setIsLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const { getAuthState } = useUser();

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
    if (!showCode && logEntries.some(({ entry }) => entry.line || entry.lines_above || entry.lines_below)) {
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
      const uniqueGitUrls = [...new Set(
        logEntries
          .map(({ entry }) => entry.git_url)
          .filter(url => url) // Filter out null/undefined URLs
      )];

      // Get user secret for authentication
      const user_secret = getAuthState();

      // Fetch code content for each unique git URL
      const promises = uniqueGitUrls.map(async (gitUrl) => {
        try {
          const headers: Record<string, string> = {
            'Content-Type': 'application/json',
          };

          // Add Authorization header if user secret is available
          if (user_secret) {
            headers['Authorization'] = `Bearer ${user_secret}`;
          }

          console.log(`Fetching code content for ${gitUrl}`);
          const response = await fetch(`/api/get_line_context_content?url=${encodeURIComponent(gitUrl!)}`, {
            headers,
          });
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
        setErrorMessage(errors.join('\n'));
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
      console.error('Error fetching code content:', error);
      setErrorMessage('Failed to fetch code content. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const closeErrorPopup = () => {
    setErrorMessage(null);
  };

  return (
    <>
      <div className="inline-flex rounded-md bg-gray-10 dark:bg-gray-300 ring-1 ring-gray-200 dark:ring-gray-600 border-gray-200 dark:border-gray-600">
        <button
          onClick={handleToggle}
          disabled={isLoading}
          className={`flex items-center space-x-2 px-4 py-2 text-sm rounded-md my-0.5 ${
            showCode
              ? 'bg-green-50 dark:bg-green-900/10 text-green-700 dark:text-green-300'
              : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
          } ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
          title={showCode ? 'Hide code context' : 'Show code context'}
        >
          <FaCode className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          <span>{isLoading ? 'Loading...' : showCode ? 'Hide Code' : 'Show Code'}</span>
        </button>
      </div>

      {/* Error Popup */}
      {errorMessage && (
        <div className="fixed top-4 left-1/2 transform -translate-x-1/2 z-50 w-3/4 max-h-[30px]">
          <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg shadow-xl overflow-hidden">
            <div className="flex items-center h-[30px] px-3">
              <div className="flex-1 overflow-hidden">
                <div className="text-sm text-red-700 dark:text-red-300 truncate">
                  {errorMessage}
                </div>
              </div>
              <button
                onClick={closeErrorPopup}
                className="ml-2 text-red-400 hover:text-red-600 dark:hover:text-red-300 flex-shrink-0"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
