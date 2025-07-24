'use client';

import React, { useState, useEffect } from 'react';
import Item from './Item';
import { Integration } from '@/types/integration';
import { useUser } from '@/hooks/useUser';
import { ResourceType } from '@/models/integrate';

const initialIntegrations: Integration[] = [
  {
    id: 'traceroot',
    name: 'TraceRoot',
    description: 'TraceRoot.AI Token',
    icon: 'traceroot',
    categories: ['Platform', 'Debugging', 'Tracing', 'Metrics'],
    connected: false,
    docs: 'https://docs.traceroot.ai/',
    token: null,
  },
  {
    id: 'github',
    name: 'GitHub',
    description: 'GitHub Integration',
    icon: 'github',
    categories: ['Code', 'Knowledge'],
    connected: false,
    docs: 'https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token',
    token: null,
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Notion Integration',
    icon: 'notion',
    categories: ['Knowledge'],
    connected: false,
    docs: 'https://developers.notion.com/docs/create-a-notion-integration',
    token: null,
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Slack Integration',
    icon: 'slack',
    categories: ['Communication', 'Knowledge'],
    connected: false,
    docs: 'https://api.slack.com/authentication/token-types#bot',
    token: null,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI Integration',
    icon: 'openai',
    categories: ['LLM', 'Agent'],
    connected: false,
    docs: 'https://platform.openai.com/docs/api-reference/authentication',
    token: null,
  }
];

export default function RightPanel() {
  const [integrations, setIntegrations] = useState<Integration[]>(initialIntegrations);
  const { user, getAuthState } = useUser();

  // Function to fetch token for a specific integration
  const fetchIntegrationToken = async (resourceType: ResourceType): Promise<string | null> => {
    try {
      const user_secret = getAuthState();
      if ((!process.env.NEXT_PUBLIC_LOCAL_MODE || process.env.NEXT_PUBLIC_LOCAL_MODE !== 'true') && !user_secret) {
        console.warn('No user secret found, skipping token fetch for:', resourceType);
        return null;
      }

      const response = await fetch(`/api/get_connect?resourceType=${resourceType}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${user_secret}`,
        },
      });

      if (!response.ok) {
        console.error(`Failed to fetch token for ${resourceType}:`, response.statusText);
        return null;
      }

      const data = await response.json();

      if (data.success && data.token) {
        return data.token;
      }

      return null;
    } catch (error) {
      console.error(`Error fetching token for ${resourceType}:`, error);
      return null;
    }
  };

  // Function to fetch all integration tokens
  const fetchAllIntegrationTokens = async () => {
    const tokenPromises = [
      fetchIntegrationToken(ResourceType.GITHUB),
      fetchIntegrationToken(ResourceType.NOTION),
      fetchIntegrationToken(ResourceType.SLACK),
      fetchIntegrationToken(ResourceType.OPENAI),
      fetchIntegrationToken(ResourceType.TRACEROOT)
    ];

    try {
      const [githubToken, notionToken, slackToken, openaiToken, tracerootToken] = await Promise.all(tokenPromises);

      setIntegrations(prevIntegrations =>
        prevIntegrations.map(integration => {
          let token = null;
          let connected = false;

          switch (integration.id) {
            case 'github':
              token = githubToken;
              connected = !!githubToken;
              break;
            case 'notion':
              token = notionToken;
              connected = !!notionToken;
              break;
            case 'slack':
              token = slackToken;
              connected = !!slackToken;
              break;
            case 'openai':
              token = openaiToken;
              connected = !!openaiToken;
              break;
            case 'traceroot':
              token = tracerootToken;
              connected = !!tracerootToken;
              break;
          }

          return {
            ...integration,
            token,
            connected
          };
        })
      );
    } catch (error) {
      console.error('Error fetching integration tokens:', error);
    }
  };

  // Fetch tokens when component mounts
  useEffect(() => {
    fetchAllIntegrationTokens();
  }, [user]);

  const handleUpdateIntegration = (updatedIntegration: Integration) => {
    setIntegrations(prevIntegrations =>
      prevIntegrations.map(integration =>
        integration.id === updatedIntegration.id
          ? { ...updatedIntegration, connected: !!updatedIntegration.token }
          : integration
      )
    );
  };

  return (
    <div className="h-full flex flex-col bg-gray-50 dark:bg-gray-900 p-6">
      {/* Header */}
      <div className="mb-6">
        <h1 className="text-2xl font-medium text-gray-900 dark:text-white mb-2">
          Sources & Integrations
        </h1>
      </div>

      {/* Grid of integration cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {integrations.map((integration) => (
          <Item
            key={integration.id}
            integration={integration}
            onUpdateIntegration={handleUpdateIntegration}
          />
        ))}
      </div>
    </div>
  );
}
