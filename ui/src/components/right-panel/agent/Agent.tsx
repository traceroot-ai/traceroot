import React, { useState, useRef, useEffect } from "react";
import {
  DEFAULT_MODEL,
  type ChatModel,
  DEFAULT_PROVIDER,
  type Provider,
} from "../../../constants/model";
import {
  ChatRequest,
  ChatResponse,
  MessageType,
  ChatHistoryResponse,
  Reference,
} from "@/models/chat";
import { useUser } from "@/hooks/useUser";
import { generateUuidHex } from "@/utils/uuid";
import { formatUTCAsLocal } from "@/utils/timezone";
import TopBar, { TopBarRef } from "./TopBar";
import MessageInput from "./MessageInput";
import ChatMessage from "./ChatMessage";

type Mode = "agent" | "chat";

interface Message {
  id: string;
  content: string;
  role: MessageType;
  timestamp: Date | string; // Allow both Date and string for formatted timestamps
  references?: Reference[];
}

interface AgentProps {
  traceId?: string;
  spanIds?: string[];
  userAvatarUrl?: string;
  queryStartTime?: Date;
  queryEndTime?: Date;
}

export default function Agent({
  traceId,
  spanIds = [],
  userAvatarUrl,
  queryStartTime,
  queryEndTime,
}: AgentProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ChatModel>(DEFAULT_MODEL);
  const [selectedMode, setSelectedMode] = useState<Mode>("agent");
  const [selectedProvider, setSelectedProvider] =
    useState<Provider>(DEFAULT_PROVIDER);
  const [chatId, setChatId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<TopBarRef>(null);
  const { getAuthState } = useUser();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Reset chat when traceId changes
  useEffect(() => {
    if (traceId) {
      handleNewChat();
    }
  }, [traceId]);

  const handleNewChat = () => {
    // Stop any ongoing loading/response generation
    setIsLoading(false);
    // Clear all messages and input
    setMessages([]);
    setInputMessage("");
    // Reset chat_id to null
    setChatId(null);
    // Note: We do not clear selected spans here as they should be managed
    // at the parent level and persist across panel switches
  };

  const handleModeChange = (mode: Mode) => {
    setSelectedMode(mode);
    // Reset chat_id when mode changes
    setChatId(null);
  };

  const handleHistoryItemClick = async (chatId: string) => {
    try {
      // Set loading state while fetching
      setIsLoading(true);

      // Fetch the chat history for the selected chat
      const response = await fetch(
        `/api/get_chat_history?chat_id=${encodeURIComponent(chatId)}`,
        {
          headers: {
            Authorization: `Bearer ${getAuthState()}`,
          },
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch chat history: ${response.status}`);
      }

      const chatHistoryResponse: ChatHistoryResponse = await response.json();

      if (chatHistoryResponse && chatHistoryResponse.history) {
        // Sort the chat history by timestamp (from small to large)
        const sortedHistory = [...chatHistoryResponse.history].sort(
          (a, b) => a.time - b.time,
        );

        // Convert ChatHistoryResponse to Message format, maintaining chronological order
        const historyMessages: Message[] = sortedHistory.map(
          (historyItem, index) => ({
            id: `${chatId}-${index}`,
            content: historyItem.message,
            role: historyItem.message_type,
            timestamp: formatUTCAsLocal(historyItem.time),
            references: historyItem.reference,
          }),
        );

        // Set the messages in reverse order (most recent first) for display
        setMessages([...historyMessages].reverse());

        // Set the chat ID
        setChatId(chatId);

        // Refresh TopBar metadata
        await topBarRef.current?.refreshMetadata();
      } else {
        console.warn("No chat history found for chat ID:", chatId);
        // Still set the chat ID even if no history is found
        setChatId(chatId);
        setMessages([]);

        // Refresh TopBar metadata
        await topBarRef.current?.refreshMetadata();
      }
    } catch (error) {
      console.error("Error loading chat history:", error);
      // Still set the chat ID and clear messages on error
      setChatId(chatId);
      setMessages([]);

      // Refresh TopBar metadata
      await topBarRef.current?.refreshMetadata();
    } finally {
      setIsLoading(false);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim() || isLoading) return;

    // Generate new chat ID if this is the first message in the conversation
    let currentChatId = chatId;
    if (!currentChatId) {
      currentChatId = generateUuidHex();
      setChatId(currentChatId);
    }

    // Add user message
    const userMessage: Message = {
      id: Date.now().toString(),
      content: inputMessage,
      role: "user",
      timestamp: new Date(), // Use Date object directly - no conversion needed for local timestamps
    };
    setMessages((prev) => [userMessage, ...prev]);
    const currentMessage = inputMessage;
    setInputMessage("");
    setIsLoading(true);

    // Function to fetch chat history and filter for GitHub messages
    const fetchGitHubMessages = async () => {
      try {
        const historyResponse = await fetch(
          `/api/get_chat_history?chat_id=${encodeURIComponent(currentChatId)}`,
          {
            headers: {
              Authorization: `Bearer ${getAuthState()}`,
            },
          },
        );

        if (historyResponse.ok) {
          const chatHistoryResponse: ChatHistoryResponse =
            await historyResponse.json();

          if (chatHistoryResponse && chatHistoryResponse.history) {
            // Sort the chat history by timestamp (from small to large)
            const sortedHistory = [...chatHistoryResponse.history].sort(
              (a, b) => a.time - b.time,
            );

            // Convert ChatHistoryResponse to Message format, focusing on GitHub messages
            const historyMessages: Message[] = sortedHistory
              .filter((historyItem) => historyItem.message_type === "github") // Only GitHub messages
              .map((historyItem, index) => ({
                id: `${currentChatId}-github-${historyItem.time}-${index}`,
                content: historyItem.message,
                role: historyItem.message_type,
                timestamp: formatUTCAsLocal(historyItem.time),
                references: historyItem.reference,
              }));

            // Filter out messages that are already in the current messages state
            setMessages((prev) => {
              const existingMessageIds = new Set(prev.map((msg) => msg.id));
              const newGitHubMessages = historyMessages
                .filter((msg) => !existingMessageIds.has(msg.id))
                .reverse(); // Most recent first for display

              if (newGitHubMessages.length > 0) {
                console.log(
                  "Adding new GitHub messages:",
                  newGitHubMessages.length,
                );
                // Refresh TopBar metadata when new GitHub messages are added
                topBarRef.current?.refreshMetadata();
                return [...newGitHubMessages, ...prev];
              }
              return prev;
            });
          }
        }
      } catch (error) {
        console.error("Error fetching GitHub messages during loading:", error);
      }
    };

    // Set up polling for GitHub messages every second while loading
    let pollingInterval: NodeJS.Timeout | null = null;

    try {
      // Start polling for GitHub messages every second
      pollingInterval = setInterval(fetchGitHubMessages, 1000);

      // Create chat request using Chat.ts models
      const chatRequest: ChatRequest = {
        time: new Date().getTime(),
        message: currentMessage,
        message_type: "user" as MessageType,
        trace_id: traceId || "",
        span_ids: spanIds || [],
        start_time: queryStartTime?.getTime() || new Date().getTime(),
        end_time: queryEndTime?.getTime() || new Date().getTime(),
        model: selectedModel,
        mode: selectedMode,
        chat_id: currentChatId,
        provider: selectedProvider,
      };

      const response = await fetch("/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getAuthState()}`,
        },
        body: JSON.stringify(chatRequest),
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const chatResponse: ChatResponse = await response.json();

      if (chatResponse.success && chatResponse.data) {
        // Set chat_id if provided in response
        if (chatResponse.data.chat_id) {
          setChatId(chatResponse.data.chat_id);
        }

        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          content: chatResponse.data.message,
          role: "assistant",
          timestamp: formatUTCAsLocal(chatResponse.data.time),
          references: chatResponse.data.reference,
        };
        setMessages((prev) => [assistantMessage, ...prev]);

        // Refresh TopBar metadata when assistant message is posted
        topBarRef.current?.refreshMetadata();
      } else {
        throw new Error(
          chatResponse.error || "Failed to get response from chat API",
        );
      }
    } catch (error) {
      console.error("Error processing message:", error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        content:
          "Sorry, I encountered an error while processing your request. Please try again.",
        role: "assistant",
        timestamp: new Date(),
      };
      setMessages((prev) => [errorMessage, ...prev]);

      // Refresh TopBar metadata when error message is posted
      topBarRef.current?.refreshMetadata();
    } finally {
      // Clear the polling interval when loading is complete
      if (pollingInterval) {
        clearInterval(pollingInterval);
        console.log("Stopped polling for GitHub messages");
      }
      setIsLoading(false);
    }
  };

  return (
    <div className="h-full bg-white dark:bg-zinc-800 flex flex-col">
      {/* Top bar */}
      <TopBar
        chatId={chatId}
        traceId={traceId}
        onNewChat={handleNewChat}
        onHistoryItemClick={handleHistoryItemClick}
        ref={topBarRef}
      />

      {/* Chat messages area */}
      <ChatMessage
        messages={messages}
        isLoading={isLoading}
        userAvatarUrl={userAvatarUrl}
        messagesEndRef={messagesEndRef}
      />

      {/* Message input area - fixed at bottom */}
      <MessageInput
        inputMessage={inputMessage}
        setInputMessage={setInputMessage}
        isLoading={isLoading}
        onSendMessage={handleSendMessage}
        selectedModel={selectedModel}
        setSelectedModel={setSelectedModel}
        selectedMode={selectedMode}
        setSelectedMode={handleModeChange}
        selectedProvider={selectedProvider}
        setSelectedProvider={setSelectedProvider}
        traceId={traceId}
        spanIds={spanIds}
      />
    </div>
  );
}
