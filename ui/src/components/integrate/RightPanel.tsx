"use client";

import React, { useState, useEffect } from "react";
import Item from "./Item";
import { Integration } from "@/types/integration";
import { useUser } from "@clerk/nextjs";
import { ResourceType } from "@/models/integrate";

const initialIntegrations: Integration[] = [
  {
    id: "traceroot",
    name: "TraceRoot.AI",
    description: "TraceRoot.AI Token",
    icon: "traceroot",
    categories: ["Debugging", "Tracing"],
    connected: false,
    docs: "https://docs.traceroot.ai/",
    token: null,
  },
  {
    id: "github",
    name: "GitHub",
    description: "GitHub Token",
    icon: "github",
    categories: ["Code", "Knowledge"],
    connected: false,
    docs: "https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/creating-a-personal-access-token",
    token: null,
  },
  {
    id: "notion",
    name: "Notion",
    description: "Notion Integration",
    icon: "notion",
    categories: ["Knowledge"],
    connected: false,
    docs: "https://developers.notion.com/docs/create-a-notion-integration",
    token: null,
  },
  {
    id: "slack",
    name: "Slack",
    description: "Slack Token",
    icon: "slack",
    categories: ["Communication", "Knowledge"],
    connected: false,
    docs: "https://api.slack.com/authentication/token-types#bot",
    token: null,
  },
  {
    id: "openai",
    name: "OpenAI",
    description: "OpenAI Token",
    icon: "openai",
    categories: ["LLM", "Agent"],
    connected: false,
    docs: "https://platform.openai.com/docs/api-reference/authentication",
    token: null,
  },
  {
    id: "anthropic",
    name: "Anthropic",
    description: "Anthropic API Key",
    icon: "anthropic",
    categories: ["LLM", "Agent"],
    connected: false,
    docs: "https://docs.anthropic.com/en/api/admin-api/apikeys/get-api-key",
    token: null,
  },
];

export default function RightPanel() {
  const [integrations, setIntegrations] =
    useState<Integration[]>(initialIntegrations);
  const { user } = useUser();

  // Function to fetch token for a specific integration
  const fetchIntegrationToken = async (
    resourceType: ResourceType,
  ): Promise<string | null> => {
    try {
      const response = await fetch(
        `/api/get_connect?resourceType=${resourceType}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
          },
        },
      );

      if (!response.ok) {
        console.error(
          `Failed to fetch token for ${resourceType}:`,
          response.statusText,
        );
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
      fetchIntegrationToken(ResourceType.TRACEROOT),
    ];

    try {
      const [
        githubToken,
        notionToken,
        slackToken,
        openaiToken,
        tracerootToken,
      ] = await Promise.all(tokenPromises);

      setIntegrations((prevIntegrations) =>
        prevIntegrations.map((integration) => {
          let token = null;
          let connected = false;

          switch (integration.id) {
            case "github":
              token = githubToken;
              connected = !!githubToken;
              break;
            case "notion":
              token = notionToken;
              connected = !!notionToken;
              break;
            case "slack":
              token = slackToken;
              connected = !!slackToken;
              break;
            case "openai":
              token = openaiToken;
              connected = !!openaiToken;
              break;
            case "traceroot":
              token = tracerootToken;
              connected = !!tracerootToken;
              break;
          }

          return {
            ...integration,
            token,
            connected,
          };
        }),
      );
    } catch (error) {
      console.error("Error fetching integration tokens:", error);
    }
  };

  // Fetch tokens when component mounts
  useEffect(() => {
    fetchAllIntegrationTokens();
  }, [user]);

  const handleUpdateIntegration = (updatedIntegration: Integration) => {
    setIntegrations((prevIntegrations) =>
      prevIntegrations.map((integration) =>
        integration.id === updatedIntegration.id
          ? { ...updatedIntegration, connected: !!updatedIntegration.token }
          : integration,
      ),
    );
  };

  return (
    <div className="min-h-full flex flex-col p-4">
      {/* Container with 75% width and max-width constraint */}
      <div className="w-3/4 max-w-6xl mx-auto m-5 p-10 rounded-lg font-mono bg-zinc-50 dark:bg-zinc-800">
        <h2 className="scroll-m-20 mb-5 text-3xl font-semibold first:mt-0">
          Integrations & Sources
        </h2>
        <p className="leading-7 [&:not(:first-child)]:mb-5">
          Integrate tools and sources to TraceRoot.AI to enable AI-powered
          insights and actions.
        </p>
        <div className="grid grid-cols-2 md:grid-cols-2 gap-5 p-3">
          {integrations.map((integration) => (
            <Item
              key={integration.id}
              integration={integration}
              onUpdateIntegration={handleUpdateIntegration}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
