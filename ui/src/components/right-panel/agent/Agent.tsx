import React, { useState, useRef, useEffect, useMemo } from 'react';
import {
  DEFAULT_MODEL,
  type ChatModel,
  DEFAULT_PROVIDER,
  type Provider,
} from '../../../constants/model';
import {
  ChatRequest,
  ChatResponse,
  MessageType,
  ChatHistoryResponse,
  Reference,
} from '@/models/chat';
import { useUser } from '@/hooks/useUser';
import { generateUuidHex } from '@/utils/uuid';
import { formatUTCAsLocal } from '@/utils/timezone';
import TopBar, { TopBarRef } from './TopBar';
import MessageInput from './MessageInput';
import ChatMessage from './ChatMessage';

type Mode = 'agent' | 'chat';

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
  const [estimatedTokens, setEstimatedTokens] = useState(0);
  const [inputMessage, setInputMessage] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [selectedModel, setSelectedModel] = useState<ChatModel>(DEFAULT_MODEL);
  const [selectedMode, setSelectedMode] = useState<Mode>('agent');
  const [selectedProvider, setSelectedProvider] =
    useState<Provider>(DEFAULT_PROVIDER);
  const [chatId, setChatId] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const topBarRef = useRef<TopBarRef>(null);
  const { getAuthState } = useUser();

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Reset chat when traceId changes (including when it becomes null/undefined)
  useEffect(() => {
    handleNewChat();
  }, [traceId]);

  function normalizeMessages(
    messages: Message[],
    inputMessage: string
  ): { role: string; content: string }[] {
    const systemMessage = {
      role: 'system',
      content: `You are a helpful TraceRoot.AI assistant that is the best assistant for debugging with logs, traces, metrics and source code. You will be provided with a tree of spans where each span has span related information and maybe logs (and maybe the source code and context for the logs) logged within the span.

Please answer user's question based on the given data. Keep your answer concise and to the point. You also need to follow following rules:
1. Please remember you are a TraceRoot AI agent. You are not allowed to hallucinate or make up information.
2. If you are very unsure about the answer, you should answer that you don't know.
3. Please provide insightful answer other than just simply returning the information directly.
4. Be more like a real and very helpful person.
5. If there is any reference to the answer, ALWAYS directly write the reference such as [1], [2], [3] etc. at the end of the line of the corresponding answer to indicate the reference.
6. If there is any reference, please make sure at least and at most either of log, trace (span) and source code is provided in the reference.
7. Please include all reference for each answer. If each answer has a reference, please MAKE SURE you also include the reference in the reference list.

8. If user wants to create a GitHub PR or issue, say that you cannot do that and suggest them to use https://traceroot.ai production service instead.`,
    };

    const sorted = [...messages].sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const spanTree: Record<string, any> = {};
    sorted.forEach((msg) => {
      if (msg.references?.length) {
        msg.references.forEach((ref, i) => {
          spanTree[ref.span_id] = {
            span_id: ref.span_id,
            func_full_name: ref.span_function_name,
            [`log_${i}`]: {
              'log message value': ref.log_message,
              'line number': ref.line_number,
            },
          };
        });
      }
    });

    const normalized = sorted.map((msg) => ({
      role: msg.role,
      content: msg.content,
    }));

    if (inputMessage) {
      let userContent = inputMessage;
      if (Object.keys(spanTree).length > 0) {
        userContent =
          `Here is the structure of the tree with related information:\n` +
          JSON.stringify(spanTree, null, 2) +
          `\n\n${inputMessage}`;
      }
      normalized.push({ role: 'user', content: userContent });
    }

    return [systemMessage, ...normalized];
  }

  const normalizedMessages = useMemo(
    () => normalizeMessages(messages, inputMessage),
    [messages, inputMessage]
  );

  // --- Estimate tokens ---
  function estimateTokens(messages: { role: string; content: string }[]) {
    let charCount = 0;
    const extraPerMessage = 5;
    messages.forEach(
      (msg) => (charCount += msg.content.length + extraPerMessage)
    );
    const naiveTokens = Math.ceil(charCount / 4);
    const adjustedTokens = naiveTokens * 2;
    return adjustedTokens;
  }

  // --- Debounced token estimation ---
  useEffect(() => {
    if (!inputMessage) return;

    const timer = setTimeout(() => {
      if (!inputMessage.trim() || isLoading) return;
      setEstimatedTokens(estimateTokens(normalizedMessages));
    }, 500);

    return () => clearTimeout(timer);
  }, [inputMessage, isLoading, normalizedMessages]);

  const handleNewChat = () => {
    // Stop any ongoing loading/response generation
    setIsLoading(false);
    // Clear all messages and input
    setMessages([]);
    setInputMessage('');
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
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to fetch chat history: ${response.status}`);
      }

      const chatHistoryResponse: ChatHistoryResponse = await response.json();

      if (chatHistoryResponse && chatHistoryResponse.history) {
        // Sort the chat history by timestamp (from small to large)
        const sortedHistory = [...chatHistoryResponse.history].sort(
          (a, b) => a.time - b.time
        );

        // Convert ChatHistoryResponse to Message format, maintaining chronological order
        const historyMessages: Message[] = sortedHistory.map(
          (historyItem, index) => ({
            id: `${chatId}-${index}`,
            content: historyItem.message,
            role: historyItem.message_type,
            timestamp: formatUTCAsLocal(historyItem.time),
            references: historyItem.reference,
          })
        );

        // Set the messages in reverse order (most recent first) for display
        setMessages([...historyMessages].reverse());

        // Set the chat ID
        setChatId(chatId);

        // Refresh TopBar metadata
        await topBarRef.current?.refreshMetadata();
      } else {
        console.warn('No chat history found for chat ID:', chatId);
        // Still set the chat ID even if no history is found
        setChatId(chatId);
        setMessages([]);

        // Refresh TopBar metadata
        await topBarRef.current?.refreshMetadata();
      }
    } catch (error) {
      console.error('Error loading chat history:', error);
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
      role: 'user',
      timestamp: new Date(), // Use Date object directly - no conversion needed for local timestamps
    };
    setMessages((prev) => [userMessage, ...prev]);
    const currentMessage = inputMessage;
    setInputMessage('');
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
          }
        );

        if (historyResponse.ok) {
          const chatHistoryResponse: ChatHistoryResponse =
            await historyResponse.json();

          if (chatHistoryResponse && chatHistoryResponse.history) {
            // Sort the chat history by timestamp (from small to large)
            const sortedHistory = [...chatHistoryResponse.history].sort(
              (a, b) => a.time - b.time
            );

            // Convert ChatHistoryResponse to Message format, focusing on GitHub messages
            const historyMessages: Message[] = sortedHistory
              .filter((historyItem) => historyItem.message_type === 'github') // Only GitHub messages
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
                  'Adding new GitHub messages:',
                  newGitHubMessages.length
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
        console.error('Error fetching GitHub messages during loading:', error);
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
        message_type: 'user' as MessageType,
        trace_id: traceId || '',
        span_ids: spanIds || [],
        start_time: queryStartTime?.getTime() || new Date().getTime(),
        end_time: queryEndTime?.getTime() || new Date().getTime(),
        model: selectedModel,
        mode: selectedMode,
        chat_id: currentChatId,
        provider: selectedProvider,
      };

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
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
          role: 'assistant',
          timestamp: formatUTCAsLocal(chatResponse.data.time),
          references: chatResponse.data.reference,
        };
        setMessages((prev) => [assistantMessage, ...prev]);

        // Refresh TopBar metadata when assistant message is posted
        topBarRef.current?.refreshMetadata();
      } else {
        throw new Error(
          chatResponse.error || 'Failed to get response from chat API'
        );
      }
    } catch (error) {
      console.error('Error processing message:', error);
      const errorMessage: Message = {
        id: (Date.now() + 1).toString(),
        content:
          'Sorry, I encountered an error while processing your request. Please try again.',
        role: 'assistant',
        timestamp: new Date(),
      };
      setMessages((prev) => [errorMessage, ...prev]);

      // Refresh TopBar metadata when error message is posted
      topBarRef.current?.refreshMetadata();
    } finally {
      // Clear the polling interval when loading is complete
      if (pollingInterval) {
        clearInterval(pollingInterval);
        console.log('Stopped polling for GitHub messages');
      }
      setIsLoading(false);
    }
  };

  return (
    <div className="h-full bg-white dark:bg-zinc-950 flex flex-col">
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
        estimatedTokens={estimatedTokens}
      />
    </div>
  );
}
