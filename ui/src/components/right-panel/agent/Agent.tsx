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
import TopBar, { TopBarRef } from "./TopBar";

interface ChatTab {
  chatId: string | null;
  title: string;
  messages: Message[];
}
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
  onSpanSelect?: (spanId: string) => void;
  onViewTypeChange?: (viewType: "log" | "agent" | "trace") => void;
}

export default function Agent({
  traceId,
  spanIds = [],
  userAvatarUrl,
  queryStartTime,
  queryEndTime,
  onSpanSelect,
  onViewTypeChange,
}: AgentProps) {
  const [chatTabs, setChatTabs] = useState<ChatTab[]>([]);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [inputMessage, setInputMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ChatModel>(DEFAULT_MODEL);
  const [selectedMode, setSelectedMode] = useState<Mode>("agent");
  const [selectedProvider, setSelectedProvider] =
    useState<Provider>(DEFAULT_PROVIDER);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<TopBarRef>(null);
  const { getAuthState } = useUser();

  // Get current active chat
  const activeChat =
    chatTabs.find((tab) => tab.chatId === activeChatId) || chatTabs[0];
  const messages = activeChat?.messages || [];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Initialize with one new chat tab on first load
  useEffect(() => {
    if (!isInitialized) {
      const initialTab: ChatTab = {
        chatId: null,
        title: "New Chat",
        messages: [],
      };
      setChatTabs([initialTab]);
      setActiveChatId(null);
      setIsInitialized(true);
    }
  }, [isInitialized]);

  // Reset chat when traceId changes (including when it becomes null/undefined)
  useEffect(() => {
    if (isInitialized) {
      if (!traceId) {
        // Show single "New Chat" tab when no trace is selected
        const defaultTab: ChatTab = {
          chatId: null,
          title: "New Chat",
          messages: [],
        };
        setChatTabs([defaultTab]);
        setActiveChatId(null);
      } else {
        // Reset all chat tabs and create a single new chat when a trace is selected
        const newTab: ChatTab = {
          chatId: null,
          title: "New Chat",
          messages: [],
        };
        setChatTabs([newTab]);
        setActiveChatId(null);
        setInputMessage("");
        setIsLoading(false);
      }
    }
  }, [traceId, isInitialized]);

  const handleNewChat = () => {
    // Stop any ongoing loading/response generation
    setIsLoading(false);
    // Clear input
    setInputMessage("");
    // Check if there's already a "New Chat" tab (without chatId)
    const existingNewChatTab = chatTabs.find((tab) => tab.chatId === null);
    if (existingNewChatTab) {
      // Just switch to the existing new chat tab
      setActiveChatId(null);
    } else {
      // Add new chat tab at the beginning only if none exists
      const newTab: ChatTab = { chatId: null, title: "New Chat", messages: [] };
      setChatTabs((prev) => [newTab, ...prev]);
      setActiveChatId(null);
    }
  };

  const handleChatSelect = async (chatId: string | null) => {
    setActiveChatId(chatId);
  };

  const handleChatClose = (chatId: string | null) => {
    setChatTabs((prev) => {
      const filtered = prev.filter((tab) => tab.chatId !== chatId);
      // If we're closing the active chat, switch to the first remaining tab
      if (chatId === activeChatId && filtered.length > 0) {
        setActiveChatId(filtered[0].chatId);
      }
      // If no tabs left, create a new chat
      if (filtered.length === 0) {
        const newTab: ChatTab = {
          chatId: null,
          title: "New Chat",
          messages: [],
        };
        setActiveChatId(null);
        return [newTab];
      }
      return filtered;
    });
  };

  const updateChatMessages = (
    chatId: string | null,
    newMessages: Message[],
  ) => {
    // Sort by converting timestamps to consistent numeric values for proper comparison
    const sortedMessages = [...newMessages].sort((a, b) => {
      let timeA: number, timeB: number;

      if (a.timestamp instanceof Date) {
        timeA = a.timestamp.getTime();
      } else if (typeof a.timestamp === "string") {
        timeA = new Date(a.timestamp).getTime();
      } else {
        // Handle numeric timestamps - use directly (already in milliseconds)
        const numTimestamp = Number(a.timestamp);
        timeA = numTimestamp;
      }

      if (b.timestamp instanceof Date) {
        timeB = b.timestamp.getTime();
      } else if (typeof b.timestamp === "string") {
        timeB = new Date(b.timestamp).getTime();
      } else {
        // Handle numeric timestamps - use directly (already in milliseconds)
        const numTimestamp = Number(b.timestamp);
        timeB = numTimestamp;
      }

      return timeA - timeB;
    });

    setChatTabs((prev) =>
      prev.map((tab) =>
        tab.chatId === chatId ? { ...tab, messages: sortedMessages } : tab,
      ),
    );
  };

  const updateChatTitle = (chatId: string, title: string) => {
    setChatTabs((prev) =>
      prev.map((tab) => (tab.chatId === chatId ? { ...tab, title } : tab)),
    );
  };

  const handleModeChange = (mode: Mode) => {
    setSelectedMode(mode);
    // Reset active chat when mode changes
    setActiveChatId(null);
  };

  const handleHistoryItemsSelect = async (chatIds: string[]) => {
    for (const chatId of chatIds) {
      // Skip if chat is already open
      if (chatTabs.some((tab) => tab.chatId === chatId)) continue;

      // Add tab with loading state first
      const loadingTab: ChatTab = {
        chatId,
        title: "Loading...",
        messages: [],
      };
      setChatTabs((prev) => [...prev, loadingTab]);

      // Set as active chat
      setActiveChatId(chatId);

      try {
        // Fetch the chat history for each selected chat
        const response = await fetch(
          `/api/get_chat_history?chat_id=${encodeURIComponent(chatId)}`,
          {
            headers: {
              Authorization: `Bearer ${getAuthState()}`,
            },
          },
        );

        if (!response.ok) {
          console.error(
            `Failed to fetch chat history for ${chatId}: ${response.status}`,
          );
          continue;
        }

        const chatHistoryResponse: ChatHistoryResponse = await response.json();
        let historyMessages: Message[] = [];
        let chatTitle = "Loading...";

        if (chatHistoryResponse && chatHistoryResponse.history) {
          // Sort the chat history by timestamp (from small to large)
          const sortedHistory = [...chatHistoryResponse.history].sort(
            (a, b) => a.time - b.time,
          );

          // Convert ChatHistoryResponse to Message format, maintaining chronological order
          historyMessages = sortedHistory.map((historyItem, index) => {
            const rawTime = historyItem.time;
            // API returns timestamp in milliseconds, use directly
            const dateObj = new Date(rawTime);
            return {
              id: `${chatId}-${index}`,
              content: historyItem.message,
              role: historyItem.message_type,
              timestamp: dateObj, // Store as Date object
              references: historyItem.reference,
            };
          });

          // Get chat title from metadata
          try {
            const metadataResponse = await fetch(
              `/api/get_chat_metadata?chat_id=${encodeURIComponent(chatId)}`,
              {
                headers: {
                  Authorization: `Bearer ${getAuthState()}`,
                },
              },
            );
            if (metadataResponse.ok) {
              const metadata = await metadataResponse.json();
              if (metadata.chat_title) {
                chatTitle = metadata.chat_title;
              }
            }
          } catch (error) {
            console.warn("Failed to fetch metadata for chat:", chatId);
          }
        }

        // Update the existing loading tab with actual data and sort messages
        setChatTabs((prev) =>
          prev.map((tab) =>
            tab.chatId === chatId
              ? {
                  ...tab,
                  title: chatTitle,
                  messages: [], // Clear first, will be updated by updateChatMessages
                }
              : tab,
          ),
        );

        // Use updateChatMessages to properly sort the history messages
        updateChatMessages(chatId, historyMessages);
      } catch (error) {
        console.error("Error loading chat history for:", chatId, error);
      }
    }

    // Set the first opened chat as active if no chat is currently active
    if (!activeChatId && chatIds.length > 0) {
      setActiveChatId(chatIds[0]);
    }

    // Refresh TopBar metadata after loading chats
    setTimeout(() => {
      topBarRef.current?.refreshMetadata();
    }, 100);
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!inputMessage.trim() || isLoading) return;

    // Generate new chat ID if this is the first message in the conversation
    let currentChatId = activeChatId;
    if (!currentChatId) {
      currentChatId = generateUuidHex();
      // Update the current new chat tab with the generated chat ID
      setChatTabs((prev) =>
        prev.map((tab) =>
          tab.chatId === null
            ? { ...tab, chatId: currentChatId, title: "Loading..." }
            : tab,
        ),
      );
      setActiveChatId(currentChatId);
    }

    // Add user message to current active chat
    const currentTime = new Date();
    const userMessage: Message = {
      id: Date.now().toString(),
      content: inputMessage,
      role: "user",
      timestamp: currentTime,
    };
    updateChatMessages(currentChatId!, [...messages, userMessage]);
    const currentMessage = inputMessage;
    setInputMessage("");
    setIsLoading(true);

    // Function to fetch chat history and filter for GitHub and statistics messages
    const fetchSpecialMessages = async () => {
      try {
        const historyResponse = await fetch(
          `/api/get_chat_history?chat_id=${encodeURIComponent(currentChatId!)}`,
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

            // Convert ChatHistoryResponse to Message format, focusing on GitHub and statistics messages
            const historyMessages: Message[] = sortedHistory
              .filter(
                (historyItem) =>
                  historyItem.message_type === "github" ||
                  historyItem.message_type === "statistics",
              ) // GitHub and statistics messages
              .map((historyItem, index) => {
                const rawTime = historyItem.time;
                // API returns timestamp in milliseconds, use directly
                const dateObj = new Date(rawTime);
                return {
                  id: `${currentChatId}-${historyItem.message_type}-${historyItem.time}-${index}`,
                  content: historyItem.message,
                  role: historyItem.message_type,
                  timestamp: dateObj, // Store as Date object
                  references: historyItem.reference,
                };
              });

            // Use functional state update for GitHub messages to avoid race conditions
            setChatTabs((prev) => {
              const currentTab = prev.find(
                (tab) => tab.chatId === currentChatId,
              );
              if (!currentTab) return prev;

              const currentMessages = currentTab.messages;
              const existingMessageIds = new Set(
                currentMessages.map((msg) => msg.id),
              );
              const newSpecialMessages = historyMessages.filter(
                (msg) => !existingMessageIds.has(msg.id),
              );

              if (newSpecialMessages.length > 0) {
                // Refresh TopBar metadata when new special messages are added
                topBarRef.current?.refreshMetadata();

                const allMessages = [...currentMessages, ...newSpecialMessages];

                // Sort by timestamp
                const sortedMessages = allMessages.sort((a, b) => {
                  const timeA =
                    a.timestamp instanceof Date
                      ? a.timestamp.getTime()
                      : new Date(a.timestamp).getTime();
                  const timeB =
                    b.timestamp instanceof Date
                      ? b.timestamp.getTime()
                      : new Date(b.timestamp).getTime();
                  return timeA - timeB;
                });

                return prev.map((tab) =>
                  tab.chatId === currentChatId
                    ? { ...tab, messages: sortedMessages }
                    : tab,
                );
              }

              return prev;
            });
          }
        }
      } catch (error) {
        console.error("Error fetching special messages during loading:", error);
      }
    };

    // Set up polling for special messages every second while loading
    let pollingInterval: NodeJS.Timeout | null = null;

    try {
      // Start polling for special messages every second
      pollingInterval = setInterval(fetchSpecialMessages, 1000);

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
        // Update chat_id if provided in response
        if (
          chatResponse.data!.chat_id &&
          chatResponse.data!.chat_id !== currentChatId
        ) {
          setChatTabs((prev) =>
            prev.map((tab) =>
              tab.chatId === currentChatId
                ? { ...tab, chatId: chatResponse.data!.chat_id }
                : tab,
            ),
          );
          setActiveChatId(chatResponse.data!.chat_id);
          currentChatId = chatResponse.data!.chat_id;
        }

        const rawAssistantTime = chatResponse.data!.time;
        // API returns timestamp in milliseconds, use directly
        const assistantDateObj = new Date(rawAssistantTime);

        const assistantMessage: Message = {
          id: (Date.now() + 1).toString(),
          content: chatResponse.data!.message,
          role: "assistant",
          timestamp: assistantDateObj, // Store as Date object
          references: chatResponse.data!.reference,
        };
        // Use functional state update to ensure we get the latest messages
        setChatTabs((prev) => {
          const currentTab = prev.find((tab) => tab.chatId === currentChatId);
          if (!currentTab) {
            return prev;
          }
          const currentMessages = currentTab.messages;
          const newMessages = [...currentMessages, assistantMessage];

          // Sort the messages by timestamp
          const sortedMessages = newMessages.sort((a, b) => {
            const timeA =
              a.timestamp instanceof Date
                ? a.timestamp.getTime()
                : new Date(a.timestamp).getTime();
            const timeB =
              b.timestamp instanceof Date
                ? b.timestamp.getTime()
                : new Date(b.timestamp).getTime();
            return timeA - timeB;
          });
          return prev.map((tab) =>
            tab.chatId === currentChatId
              ? { ...tab, messages: sortedMessages }
              : tab,
          );
        });

        // Refresh TopBar metadata when assistant message is posted
        topBarRef.current?.refreshMetadata();
      } else {
        throw new Error(
          chatResponse.error || "Failed to get response from chat API",
        );
      }
    } catch (error) {
      console.error("Error processing message:", error);
      const currentTime = new Date();
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        content:
          "Sorry, I encountered an error while processing your request. Please try again.",
        role: "assistant",
        timestamp: currentTime,
      };
      // Use functional state update for error message too
      setChatTabs((prev) => {
        const currentTab = prev.find((tab) => tab.chatId === currentChatId);
        if (!currentTab) return prev;

        const currentMessages = currentTab.messages;
        const newMessages = [...currentMessages, errorMessage];

        // Sort the messages by timestamp
        const sortedMessages = newMessages.sort((a, b) => {
          const timeA =
            a.timestamp instanceof Date
              ? a.timestamp.getTime()
              : new Date(a.timestamp).getTime();
          const timeB =
            b.timestamp instanceof Date
              ? b.timestamp.getTime()
              : new Date(b.timestamp).getTime();
          return timeA - timeB;
        });

        return prev.map((tab) =>
          tab.chatId === currentChatId
            ? { ...tab, messages: sortedMessages }
            : tab,
        );
      });

      // Refresh TopBar metadata when error message is posted
      topBarRef.current?.refreshMetadata();
    } finally {
      // Clear the polling interval when loading is complete
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }
      setIsLoading(false);
    }
  };

  return (
    <div className="h-full bg-white dark:bg-zinc-950 flex flex-col">
      {/* Top bar */}
      <TopBar
        activeChatTabs={chatTabs}
        activeChatId={activeChatId}
        traceId={traceId}
        onNewChat={handleNewChat}
        onChatSelect={handleChatSelect}
        onChatClose={handleChatClose}
        onHistoryItemsSelect={handleHistoryItemsSelect}
        onUpdateChatTitle={updateChatTitle}
        ref={topBarRef}
      />

      {/* Chat messages area */}
      <ChatMessage
        messages={messages}
        isLoading={isLoading}
        userAvatarUrl={userAvatarUrl}
        messagesEndRef={messagesEndRef}
        onSpanSelect={onSpanSelect}
        onViewTypeChange={onViewTypeChange}
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
