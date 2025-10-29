import React, {
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import { GoHistory } from "react-icons/go";
import { Plus, X, Check, Download, ArrowUpRight } from "lucide-react";
import { ChatMetadata, ChatMetadataHistory } from "@/models/chat";
import { useAuth } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { loadProviderSelection, getProviderRegion } from "@/utils/provider";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/shadcn-io/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { truncateTitle } from "@/lib/utils";

interface Message {
  id: string;
  content: string;
  role: "user" | "assistant" | "github" | "statistics";
  timestamp: Date | string;
  references?: any[];
}

interface ChatTab {
  chatId: string | null;
  title: string;
  tempId?: string;
}

interface TopBarProps {
  activeChatTabs: ChatTab[];
  activeChatId: string | null;
  activeTempId?: string;
  traceId?: string;
  messages?: Message[];
  chatTitle?: string;
  onNewChat: () => void;
  onChatSelect: (chatId: string | null, tempId?: string) => Promise<void>;
  onChatClose: (chatId: string | null, tempId?: string) => void;
  onHistoryItemsSelect: (chatIds: string[]) => Promise<void>;
  onUpdateChatTitle: (chatId: string, title: string) => void;
  useUserBasedHistory?: boolean;
}

export interface TopBarRef {
  refreshMetadata: () => Promise<void>;
}

interface HistoryItem {
  chat_id: string;
  chat_title: string;
  timestamp: number;
}

interface GroupedHistoryItems {
  label: string;
  items: HistoryItem[];
}

// Helper function to format relative time
const formatRelativeTime = (timestamp: number): string => {
  const now = Date.now();
  const diffInMs = now - timestamp;
  const diffInMinutes = Math.floor(diffInMs / (1000 * 60));
  const diffInHours = Math.floor(diffInMs / (1000 * 60 * 60));
  const diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));

  if (diffInMinutes < 1) {
    return "now";
  } else if (diffInMinutes < 60) {
    return `${diffInMinutes}m`;
  } else if (diffInHours < 24) {
    return `${diffInHours}h`;
  } else {
    return `${diffInDays}d`;
  }
};

// Helper function to group history items by time period
const groupHistoryByTime = (items: HistoryItem[]): GroupedHistoryItems[] => {
  const now = Date.now();
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  const lastWeekStart = new Date(todayStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastMonthStart = new Date(todayStart);
  lastMonthStart.setDate(lastMonthStart.getDate() - 30);

  const groups: GroupedHistoryItems[] = [
    { label: "Today", items: [] },
    { label: "Yesterday", items: [] },
    { label: "Last Week", items: [] },
    { label: "Last Month", items: [] },
    { label: "Older", items: [] },
  ];

  items.forEach((item) => {
    const itemDate = item.timestamp;
    if (itemDate >= todayStart.getTime()) {
      groups[0].items.push(item);
    } else if (itemDate >= yesterdayStart.getTime()) {
      groups[1].items.push(item);
    } else if (itemDate >= lastWeekStart.getTime()) {
      groups[2].items.push(item);
    } else if (itemDate >= lastMonthStart.getTime()) {
      groups[3].items.push(item);
    } else {
      groups[4].items.push(item);
    }
  });

  // Filter out empty groups
  return groups.filter((group) => group.items.length > 0);
};

const TopBar = forwardRef<TopBarRef, TopBarProps>(
  (
    {
      activeChatTabs,
      activeChatId,
      activeTempId,
      traceId,
      messages = [],
      chatTitle,
      onNewChat,
      onChatSelect,
      onChatClose,
      onHistoryItemsSelect,
      onUpdateChatTitle,
      useUserBasedHistory = false,
    },
    ref,
  ) => {
    const { getToken } = useAuth();
    const router = useRouter();
    const [chatMetadata, setChatMetadata] = useState<ChatMetadata | null>(null);
    const [displayedTitle, setDisplayedTitle] = useState<string>("");
    const [isAnimating, setIsAnimating] = useState(false);
    const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [hasMoreHistory, setHasMoreHistory] = useState(false);
    const [isLoadingMore, setIsLoadingMore] = useState(false);
    const [skip, setSkip] = useState(0);
    const animationControllerRef = useRef<{ cancelled: boolean } | null>(null);
    const previousTitleRef = useRef<string>("");

    const fetchChatHistory = async (loadMore: boolean = false) => {
      // When using user-based history, don't require traceId
      if (!useUserBasedHistory && !traceId) return;

      if (loadMore) {
        setIsLoadingMore(true);
      } else {
        setIsLoadingHistory(true);
        setSkip(0); // Reset skip when fetching initial history
      }

      try {
        const token = await getToken();
        const currentSkip = loadMore ? skip : 0;
        const limit = 5;

        // Use different API endpoint based on useUserBasedHistory flag
        const apiUrl = useUserBasedHistory
          ? `/api/get_chat_metadata_by_user?limit=${limit}&skip=${currentSkip}`
          : `/api/get_chat_metadata_history?trace_id=${encodeURIComponent(traceId!)}&limit=${limit}&skip=${currentSkip}`;

        const response = await fetch(apiUrl, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        });

        if (response.ok) {
          const data: ChatMetadataHistory = await response.json();
          const formattedItems: HistoryItem[] = data.history
            .map((item) => ({
              chat_id: item.chat_id,
              chat_title: item.chat_title,
              timestamp: item.timestamp,
            }))
            .sort((a, b) => b.timestamp - a.timestamp);

          if (loadMore) {
            // Append new items to existing items
            setHistoryItems((prev) => [...prev, ...formattedItems]);
            setSkip(currentSkip + limit);
          } else {
            // Replace items with new items
            setHistoryItems(formattedItems);
            setSkip(limit);
          }

          setHasMoreHistory(data.hasMore || false);
        } else {
          console.error("Failed to fetch chat history:", response.statusText);
          if (!loadMore) {
            setHistoryItems([]);
          }
          setHasMoreHistory(false);
        }
      } catch (error) {
        console.error("Error fetching chat history:", error);
        if (!loadMore) {
          setHistoryItems([]);
        }
        setHasMoreHistory(false);
      } finally {
        if (loadMore) {
          setIsLoadingMore(false);
        } else {
          setIsLoadingHistory(false);
        }
      }
    };

    // Function to fetch chat metadata
    const fetchChatMetadata = async () => {
      if (!activeChatId) {
        setChatMetadata(null);
        return;
      }

      try {
        const token = await getToken();
        const response = await fetch(
          `/api/get_chat_metadata?chat_id=${encodeURIComponent(activeChatId)}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        );
        if (response.ok) {
          const metadata: ChatMetadata = await response.json();
          setChatMetadata(metadata);
          // Update the chat title in the parent component if we have a title
          if (metadata.chat_title && activeChatId) {
            onUpdateChatTitle(activeChatId, metadata.chat_title);
          }
        } else {
          console.error("Failed to fetch chat metadata:", response.status);
          setChatMetadata(null);
        }
      } catch (error) {
        console.error("Error fetching chat metadata:", error);
        setChatMetadata(null);
      }
    };

    // Expose refreshMetadata function through ref
    useImperativeHandle(
      ref,
      () => ({
        refreshMetadata: fetchChatMetadata,
      }),
      [activeChatId],
    );

    // Fetch chat metadata when activeChatId changes
    useEffect(() => {
      fetchChatMetadata();
    }, [activeChatId]);

    // Animate title transitions when switching chats
    useEffect(() => {
      const newTitle = chatMetadata?.chat_title || "";

      // Only animate if the title actually changed from the previous value
      if (newTitle === previousTitleRef.current) return;

      // Update the previous title reference
      previousTitleRef.current = newTitle;

      if (newTitle === displayedTitle) return;

      // Cancel any ongoing animation
      if (animationControllerRef.current) {
        animationControllerRef.current.cancelled = true;
      }

      // Create new animation controller
      const controller = { cancelled: false };
      animationControllerRef.current = controller;

      setIsAnimating(true);

      const animateTitle = async () => {
        // Get the current tab to find its truncated title
        const currentTab = activeChatTabs.find(
          (tab) => tab.chatId === activeChatId,
        );
        const truncatedTitle = currentTab
          ? truncateTitle(currentTab.title).replace("...", "")
          : "";

        // Phase 1: Start from truncated title (without ellipsis)
        if (truncatedTitle && newTitle.startsWith(truncatedTitle)) {
          setDisplayedTitle(truncatedTitle);
        } else {
          setDisplayedTitle("");
        }

        // Small pause between animations
        await new Promise((resolve) => setTimeout(resolve, 50));

        // Check if animation was cancelled
        if (controller.cancelled) {
          return;
        }

        // Phase 2: Continue from truncated title or start from beginning
        if (newTitle) {
          const startIndex =
            truncatedTitle && newTitle.startsWith(truncatedTitle)
              ? truncatedTitle.length
              : 0;

          for (let i = startIndex; i <= newTitle.length; i++) {
            // Check if animation was cancelled before each character
            if (controller.cancelled) {
              return;
            }

            setDisplayedTitle(newTitle.substring(0, i));
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }

        // Only update isAnimating if this animation wasn't cancelled
        if (!controller.cancelled) {
          setIsAnimating(false);
        }
      };

      animateTitle();
    }, [chatMetadata?.chat_title, activeChatTabs, activeChatId]);

    // Fetch chat history when dropdown opens
    useEffect(() => {
      if (dropdownOpen) {
        fetchChatHistory();
      }
    }, [dropdownOpen, traceId, useUserBasedHistory]);

    const handleHistoryItemClick = async (selectedChatId: string) => {
      // Skip if chat is already open
      if (activeChatTabs.some((tab) => tab.chatId === selectedChatId)) {
        // Just switch to the existing tab
        setDropdownOpen(false);
        await onChatSelect(selectedChatId);
        return;
      }

      // Close dropdown and open the selected chat
      setDropdownOpen(false);
      await onHistoryItemsSelect([selectedChatId]);
    };

    const handleTabChange = async (value: string) => {
      // Check if the value is a tempId or chatId
      const tab = activeChatTabs.find(
        (t) => t.chatId === value || t.tempId === value,
      );
      if (tab) {
        await onChatSelect(tab.chatId, tab.tempId);
      }
    };

    const handleTabClose = (
      e: React.MouseEvent,
      chatId: string | null,
      tempId?: string,
    ) => {
      e.stopPropagation();
      onChatClose(chatId, tempId);
    };

    const handleGoToTrace = () => {
      // Get trace_id from chat metadata
      const trace_id = chatMetadata?.trace_id;
      if (!trace_id) return;

      // Build explore URL with provider parameters and trace_id
      const traceProvider = loadProviderSelection("trace") || "aws";
      const logProvider = loadProviderSelection("log") || "aws";

      const traceRegion = getProviderRegion("trace", traceProvider);
      const logRegion = getProviderRegion("log", logProvider);

      const params = new URLSearchParams();
      params.set("trace_provider", traceProvider);
      if (traceRegion) {
        params.set("trace_region", traceRegion);
      }
      params.set("log_provider", logProvider);
      if (logRegion) {
        params.set("log_region", logRegion);
      }
      params.set("trace_id", trace_id);

      // Open explore page in a new tab
      const url = `/explore?${params.toString()}`;
      window.open(url, "_blank");
    };

    const handleDownload = () => {
      if (messages.length === 0) return;

      // Filter messages to only include user and assistant messages (no github or statistics)
      const relevantMessages = messages.filter(
        (msg) => msg.role === "user" || msg.role === "assistant",
      );

      if (relevantMessages.length === 0) return;

      // Generate markdown content
      let markdownContent = "";

      relevantMessages.forEach((message) => {
        if (message.role === "user") {
          markdownContent += "**User**\n\n" + message.content + "\n\n";
        } else if (message.role === "assistant") {
          markdownContent += "**TraceRoot**\n\n" + message.content;

          // Add references if they exist
          if (message.references && message.references.length > 0) {
            markdownContent += "\n\n**References:**\n\n";
            message.references.forEach((ref, index) => {
              markdownContent += `[${ref.number || index + 1}] `;

              if (ref.span_id) {
                markdownContent += `Span ID: ${ref.span_id}`;
              }

              if (ref.span_function_name) {
                markdownContent += ref.span_id
                  ? `, Function: ${ref.span_function_name}`
                  : `Function: ${ref.span_function_name}`;
              }

              if (ref.line_number) {
                markdownContent += `, Line: ${ref.line_number}`;
              }

              if (ref.log_message) {
                markdownContent += `\n   Log: ${ref.log_message}`;
              }

              markdownContent += "\n";
            });
          }

          markdownContent += "\n\n";
        }
      });

      // Generate filename using the chat title or default
      const title =
        chatTitle || chatMetadata?.chat_title || displayedTitle || "chat";
      const filename = `${title.replace(/[^a-zA-Z0-9\s-_]/g, "").replace(/\s+/g, "_")}.md`;

      // Create and download the file
      const blob = new Blob([markdownContent], { type: "text/markdown" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    };

    return (
      <div className="bg-zinc-50 dark:bg-zinc-900 gap-2 mx-4 mt-2 mb-1 rounded-md p-1 relative">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0 overflow-hidden">
            {activeChatTabs.length > 0 ? (
              <Tabs
                value={activeChatId || activeTempId || "new"}
                onValueChange={handleTabChange}
              >
                <TabsList className="h-9 overflow-x-auto flex-nowrap w-full justify-start items-center">
                  {activeChatTabs.map((tab) => (
                    <TabsTrigger
                      key={tab.chatId || tab.tempId || "new"}
                      value={tab.chatId || tab.tempId || "new"}
                      className="text-xs h-6 px-2 pr-6 relative group flex-none"
                    >
                      <span className="mr-1 whitespace-nowrap">
                        {!tab.chatId
                          ? "New Chat"
                          : tab.chatId === activeChatId && displayedTitle
                            ? displayedTitle + (isAnimating ? "|" : "")
                            : tab.title}
                      </span>
                      <div
                        className={`absolute top-0 right-0 h-full w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer rounded-sm flex items-center justify-center ${
                          tab.chatId === activeChatId
                            ? "group-hover:bg-background/80 dark:group-hover:bg-input/50"
                            : "group-hover:bg-muted/50 dark:group-hover:bg-muted/20"
                        }`}
                        onClick={(e) =>
                          handleTabClose(e, tab.chatId, tab.tempId)
                        }
                      >
                        <X className="h-3 w-3" />
                      </div>
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
            ) : (
              <div className="flex items-center ml-2">
                <span className="text-xs font-medium font-mono text-neutral-800 dark:text-neutral-300">
                  New Chat
                </span>
              </div>
            )}
          </div>
          <div className="flex items-center flex-shrink-0">
            {useUserBasedHistory && (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="mr-1 h-8 w-8"
                      onClick={handleGoToTrace}
                      disabled={!chatMetadata?.trace_id}
                    >
                      <ArrowUpRight className="w-4 h-4" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent>
                    <p>View more details in a new tab</p>
                  </TooltipContent>
                </Tooltip>
              </TooltipProvider>
            )}

            <Button
              variant="ghost"
              size="icon"
              className="mr-1 h-8 w-8"
              onClick={handleDownload}
              title="Download chat as markdown"
              disabled={messages.length === 0}
            >
              <Download className="w-4 h-4" />
            </Button>

            <Button
              variant="ghost"
              size="icon"
              className="mr-1 h-8 w-8"
              onClick={onNewChat}
              title="Start new chat"
            >
              <Plus className="w-4 h-4" />
            </Button>

            <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="mr-1 h-8 w-8"
                  title="View chat history"
                >
                  <GoHistory className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="end"
                className="min-w-[300px] max-w-[400px] max-h-[300px] overflow-y-auto"
              >
                {isLoadingHistory ? (
                  <div className="flex items-center justify-center px-2 py-2 space-x-1">
                    <Spinner
                      variant="infinite"
                      className="w-5 h-5 text-gray-500 dark:text-gray-400"
                    />
                  </div>
                ) : historyItems.length === 0 ? (
                  <div className="px-2 py-3 text-xs text-gray-500 dark:text-gray-400">
                    No Chat History Available
                  </div>
                ) : (
                  <>
                    {groupHistoryByTime(historyItems).map(
                      (group, groupIndex) => (
                        <div key={group.label}>
                          <DropdownMenuLabel className="text-xs text-gray-500 dark:text-gray-500 px-2 py-1.5">
                            {group.label}
                          </DropdownMenuLabel>
                          {group.items.map((item) => (
                            <DropdownMenuItem
                              key={item.chat_id}
                              onClick={() =>
                                handleHistoryItemClick(item.chat_id)
                              }
                              className="text-xs cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-900/20 hover:text-zinc-600 dark:hover:text-zinc-400 transition-colors duration-200"
                            >
                              <div className="flex items-center gap-2 w-full">
                                <div className="w-4 h-4 flex items-center justify-center flex-shrink-0">
                                  {activeChatTabs.some(
                                    (tab) => tab.chatId === item.chat_id,
                                  ) && (
                                    <Check className="w-3 h-3 text-zinc-600 dark:text-zinc-300" />
                                  )}
                                </div>
                                <div className="font-normal truncate font-medium text-neutral-800 dark:text-neutral-300 flex-1 min-w-0">
                                  {item.chat_title}
                                </div>
                                <div className="text-xs text-gray-500 dark:text-gray-500 flex-shrink-0 ml-2">
                                  {formatRelativeTime(item.timestamp)}
                                </div>
                              </div>
                            </DropdownMenuItem>
                          ))}
                        </div>
                      ),
                    )}
                    {hasMoreHistory && (
                      <div className="px-2 py-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full text-xs h-[40px]"
                          onClick={() => fetchChatHistory(true)}
                          disabled={isLoadingMore}
                        >
                          {isLoadingMore ? (
                            <div className="flex items-center justify-center space-x-1">
                              <Spinner
                                variant="infinite"
                                className="w-4 h-4 text-gray-500 dark:text-gray-400"
                              />
                            </div>
                          ) : (
                            "Load more..."
                          )}
                        </Button>
                      </div>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    );
  },
);

export default TopBar;
