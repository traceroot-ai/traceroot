'use client';

import React, { useState, useEffect } from 'react';
import { TbEye, TbEyeOff } from 'react-icons/tb';
import { FiCopy } from "react-icons/fi";
import { FaGithub } from "react-icons/fa";
import { SiNotion, SiSlack, SiOpenai } from "react-icons/si";
import { FaCheck } from "react-icons/fa";
import { Integration } from '@/types/integration';
import { TokenResource, ResourceType } from '@/models/integrate';
import { useUser } from '@/hooks/useUser';

interface ItemProps {
  integration: Integration;
  onUpdateIntegration?: (integration: Integration) => void;
}

export default function Item({ integration, onUpdateIntegration }: ItemProps) {
  const [authSecret, setAuthSecret] = useState('');
  const [showSecret, setShowSecret] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showError, setShowError] = useState(false);
  const [displayToken, setDisplayToken] = useState<string>('');
  const [isEditing, setIsEditing] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  const { user, getAuthState } = useUser();

  // Initialize display token from integration
  useEffect(() => {
    setDisplayToken(integration.token || '');
  }, [integration.token]);

  const renderIcon = (iconName: string, size: number = 24) => {
    switch (iconName) {
      case 'github':
        return <FaGithub size={size} className="text-black" />;
      case 'notion':
        return <SiNotion size={size} className="text-black" />;
      case 'slack':
        return <SiSlack size={size} className="text-black" />;
      case 'openai':
        return <SiOpenai size={size} className="text-black" />;
      case 'traceroot':
        return (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            viewBox="0 0 24 24"
            fill="none"
            stroke="#0a8638"
            strokeWidth="1.25"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="4" r="2.5"></circle>
            <circle cx="6" cy="12" r="2.5"></circle>
            <circle cx="18" cy="12" r="2.5"></circle>
            <line x1="12" y1="6.5" x2="12" y2="8.5"></line>
            <line x1="12" y1="8.5" x2="8" y2="10.5"></line>
            <line x1="12" y1="8.5" x2="16" y2="10.5"></line>
            <line x1="6" y1="14.5" x2="6" y2="17.5"></line>
            <line x1="18" y1="14.5" x2="18" y2="17.5"></line>
            <circle cx="6" cy="20" r="2.5"></circle>
            <circle cx="18" cy="20" r="2.5"></circle>
          </svg>
        );
      default:
        return <span className="text-lg font-semibold text-black">{iconName}</span>;
    }
  };

  const getResourceType = (integrationName: string): ResourceType => {
    switch (integrationName.toLowerCase()) {
      case 'github':
        return ResourceType.GITHUB;
      case 'notion':
        return ResourceType.NOTION;
      case 'slack':
        return ResourceType.SLACK;
      case 'openai':
        return ResourceType.OPENAI;
      case 'traceroot':
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
    if (!process.env.NEXT_PUBLIC_LOCAL_MODE || process.env.NEXT_PUBLIC_LOCAL_MODE !== 'true') {
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
      const response = await fetch('/api/post_connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authState}`,
        },
        body: JSON.stringify({
          token: null,
          resourceType: ResourceType.TRACEROOT
        }),
      });

      const result = await response.json();

      if (result.success) {
        // Update the display token with the generated token
        const newToken = result.token;
        setDisplayToken(newToken);
        setAuthSecret(''); // Clear the input field
        setIsEditing(false); // Reset editing state

        // Update the integration with the new token
        const updatedIntegration: Integration = {
          ...integration,
          token: newToken,
          connected: true
        };

        if (onUpdateIntegration) {
          onUpdateIntegration(updatedIntegration);
        }
      } else {
        console.error('Failed to generate token:', result.error);
        setShowError(true);
        setTimeout(() => setShowError(false), 2000);
      }
    } catch (error) {
      console.error('Error generating token:', error);
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
    if (!process.env.NEXT_PUBLIC_LOCAL_MODE || process.env.NEXT_PUBLIC_LOCAL_MODE !== 'true') {
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
        resourceType: getResourceType(integration.name),
      };

      const response = await fetch('/api/post_connect', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authState}`,
        },
        body: JSON.stringify(tokenResource),
      });

      const result = await response.json();

      if (result.success) {
        // Update the display token with the returned token or the input token
        const newToken = result.token || authSecret;
        setDisplayToken(newToken);
        setAuthSecret(''); // Clear the input field
        setIsEditing(false); // Reset editing state

        // Update the integration with the new token
        const updatedIntegration: Integration = {
          ...integration,
          token: newToken,
          connected: true
        };

        if (onUpdateIntegration) {
          onUpdateIntegration(updatedIntegration);
        }
      } else {
        console.error('Failed to save configuration:', result.error);
        setShowError(true);
        setTimeout(() => setShowError(false), 2000);
      }
    } catch (error) {
      console.error('Error saving configuration:', error);
      setShowError(true);
      setTimeout(() => setShowError(false), 2000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCancel = async () => {
    // If there's no token to remove, just reset the form
    if (!displayToken) {
      setAuthSecret('');
      setDisplayToken('');
      setShowError(false);
      return;
    }

    const authState = getAuthState();
    // Show error if there is no NEXT_PUBLIC_LOCAL_MODE or
    // NEXT_PUBLIC_LOCAL_MODE is not set or not 'true', and no authState
    if (!process.env.NEXT_PUBLIC_LOCAL_MODE || process.env.NEXT_PUBLIC_LOCAL_MODE !== 'true') {
      if (!authState) {
        setShowError(true);
        setTimeout(() => setShowError(false), 2000);
        return;
      }
    }

    setIsLoading(true);
    setShowError(false);

    try {
      const response = await fetch('/api/delete_connect', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${authState}`,
        },
        body: JSON.stringify({
          resource_type: getResourceType(integration.name)
        }),
      });

      const result = await response.json();

      if (result.success) {
        // Reset form and clear token
        setAuthSecret('');
        setDisplayToken('');
        setShowError(false);
        setIsEditing(false); // Reset editing state

        // Update the integration to remove token
        const updatedIntegration: Integration = {
          ...integration,
          token: null,
          connected: false
        };

        if (onUpdateIntegration) {
          onUpdateIntegration(updatedIntegration);
        }
      } else {
        console.error('Failed to remove configuration:', result.error);
        setShowError(true);
        setTimeout(() => setShowError(false), 2000);
      }
    } catch (error) {
      console.error('Error removing configuration:', error);
      setShowError(true);
      setTimeout(() => setShowError(false), 2000);
    } finally {
      setIsLoading(false);
    }
  };

  const handleCopyToken = async () => {
    const tokenToCopy = isEditing ? authSecret : (displayToken || authSecret);
    if (tokenToCopy) {
      try {
        await navigator.clipboard.writeText(tokenToCopy);
        setIsCopied(true);
        // Reset the copied state after 2 seconds
        setTimeout(() => setIsCopied(false), 2000);
      } catch (err) {
        console.error('Failed to copy token:', err);
      }
    }
  };

  return (
    <>
      {/* Card */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-6 shadow-sm hover:shadow-md transition-shadow">
        {/* Icon and Title */}
        <div className="flex items-center mb-4">
          <div className="w-12 h-12 bg-gray-100 dark:bg-gray-700 rounded-lg flex items-center justify-center mr-3">
            {renderIcon(integration.icon)}
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              {integration.name}
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400 underline">
              <a
                href={integration.docs}
                target="_blank"
                rel="noopener noreferrer"
              >
                {integration.description}{' '}
              </a>
            </p>
          </div>
        </div>

        {/* Category Tags */}
        <div className="mb-4">
          <div className="flex flex-wrap gap-2">
            {integration.categories.map((category, index) => (
              <span
                key={index}
                className="inline-block bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 px-3 py-1 rounded-full text-sm font-medium"
              >
                {category}
              </span>
            ))}
          </div>
        </div>

        {/* Status */}
        <div className="ml-1 mb-2 flex items-center">
          <div className={`w-2 h-2 rounded-full mr-2 ${integration.connected ? 'bg-green-500' : 'bg-gray-400'}`}></div>
          <span className="text-sm text-gray-600 dark:text-gray-400">
            {integration.connected ? 'Connected' : 'Disconnected'}
          </span>
        </div>

        {/* Configuration Section */}
        <div className="mt-2 mb-2 rounded-lg">
            <div className="relative">
              <input
                type={showSecret ? 'text' : 'password'}
                value={isEditing ? authSecret : (displayToken || authSecret)}
                onChange={(e) => {
                  // Only allow editing if not TraceRoot
                  if (integration.id !== 'traceroot') {
                    setAuthSecret(e.target.value);
                    if (!isEditing) setIsEditing(true);
                  }
                }}
                onFocus={() => {
                  // Only allow editing if not TraceRoot
                  if (integration.id !== 'traceroot' && displayToken && !isEditing) {
                    setAuthSecret(displayToken);
                    setIsEditing(true);
                  }
                }}
                placeholder={integration.id === 'traceroot' ? 'Generate the TraceRoot token' : `Enter your ${integration.name} Authentication`}
                readOnly={integration.id === 'traceroot'}
                className={`w-full px-3 py-2 border rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-500 dark:placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent ${
                  integration.id === 'traceroot' ? 'pr-20' : 'pr-10'
                } ${
                  showError
                    ? 'border-red-500 focus:ring-red-500'
                    : 'border-gray-300 dark:border-gray-600'
                } ${integration.id === 'traceroot' ? 'cursor-not-allowed bg-gray-50 dark:bg-gray-800' : ''}`}
              />

              {/* Copy button for TraceRoot only */}
              {integration.id === 'traceroot' && (
                <button
                  type="button"
                  onClick={handleCopyToken}
                  className="absolute inset-y-0 right-10 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
                >
                  {isCopied ? <FaCheck size={18} /> : <FiCopy size={20} />}
                </button>
              )}

              <button
                type="button"
                onClick={() => setShowSecret(!showSecret)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                {showSecret ? <TbEyeOff size={20} /> : <TbEye size={20} />}
              </button>
          </div>

          <br />

          <div className="flex justify-between gap-4">
            {integration.id === 'traceroot' ? (
              <button
                onClick={handleGenerateToken}
                disabled={isLoading}
                className={`w-[50%] px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  isLoading
                    ? 'bg-gray-400 dark:bg-gray-600 text-gray-600 dark:text-gray-400 cursor-not-allowed'
                    : 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200'
                }`}
              >
                {isLoading ? 'Generating...' : 'Generate'}
              </button>
            ) : (
              <button
                onClick={handleSaveConfiguration}
                disabled={isLoading}
                className={`w-[50%] px-4 py-2 rounded-md text-sm font-medium transition-colors ${
                  isLoading
                    ? 'bg-gray-400 dark:bg-gray-600 text-gray-600 dark:text-gray-400 cursor-not-allowed'
                    : 'bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-200'
                }`}
              >
                {isLoading ? 'Saving...' : 'Save'}
              </button>
            )}
            <button
              onClick={handleCancel}
              disabled={isLoading}
              className={`w-[50%] px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-md text-sm font-medium transition-colors ${
                isLoading
                  ? 'bg-gray-400 dark:bg-gray-600 text-gray-600 dark:text-gray-400 cursor-not-allowed'
                  : 'text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              {isLoading ? 'Removing...' : 'Remove'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
