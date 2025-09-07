import React, {
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import { GoHistory } from "react-icons/go";
import { Plus, X, Check } from "lucide-react";
import { ChatMetadata, ChatMetadataHistory } from "@/models/chat";
import { useUser } from "@/hooks/useUser";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/shadcn-io/spinner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { truncateTitle } from "@/lib/utils";

interface ChatTab {
  chatId: string | null;
  title: string;
}

interface TopBarProps {
  activeChatTabs: ChatTab[];
  activeChatId: string | null;
  traceId?: string;
  onNewChat: () => void;
  onChatSelect: (chatId: string | null) => Promise<void>;
  onChatClose: (chatId: string | null) => void;
  onHistoryItemsSelect: (chatIds: string[]) => Promise<void>;
  onUpdateChatTitle: (chatId: string, title: string) => void;
}

export interface TopBarRef {
  refreshMetadata: () => Promise<void>;
}

interface HistoryItem {
  chat_id: string;
  chat_title: string;
  timestamp: number;
}

const TopBar = forwardRef<TopBarRef, TopBarProps>(
  (
    {
      activeChatTabs,
      activeChatId,
      traceId,
      onNewChat,
      onChatSelect,
      onChatClose,
      onHistoryItemsSelect,
      onUpdateChatTitle,
    },
    ref,
  ) => {
    const { getAuthState } = useUser();
    const [chatMetadata, setChatMetadata] = useState<ChatMetadata | null>(null);
    const [displayedTitle, setDisplayedTitle] = useState<string>("");
    const [isAnimating, setIsAnimating] = useState(false);
    const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = useState(false);
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const animationControllerRef = useRef<{ cancelled: boolean } | null>(null);

    const fetchChatHistory = async () => {
      if (!traceId) return;

      setIsLoadingHistory(true);
      try {
        const response = await fetch(
          `/api/get_chat_metadata_history?trace_id=${encodeURIComponent(traceId)}`,
          {
            headers: {
              Authorization: `Bearer ${getAuthState()}`,
            },
          },
        );
        if (response.ok) {
          const data: ChatMetadataHistory = await response.json();
          const formattedItems: HistoryItem[] = data.history
            .map((item) => ({
              chat_id: item.chat_id,
              chat_title: item.chat_title,
              timestamp: item.timestamp,
            }))
            .sort((a, b) => b.timestamp - a.timestamp);
          setHistoryItems(formattedItems);
        } else {
          console.error("Failed to fetch chat history:", response.statusText);
          setHistoryItems([]);
        }
      } catch (error) {
        console.error("Error fetching chat history:", error);
        setHistoryItems([]);
      } finally {
        setIsLoadingHistory(false);
      }
    };

    // Function to fetch chat metadata
    const fetchChatMetadata = async () => {
      if (!activeChatId) {
        setChatMetadata(null);
        return;
      }

      try {
        const response = await fetch(
          `/api/get_chat_metadata?chat_id=${encodeURIComponent(activeChatId)}`,
          {
            headers: {
              Authorization: `Bearer ${getAuthState()}`,
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
    }, [dropdownOpen, traceId]);

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

    const handleTabChange = async (chatId: string) => {
      await onChatSelect(chatId === "new" ? null : chatId);
    };

    const handleTabClose = (e: React.MouseEvent, chatId: string | null) => {
      e.stopPropagation();
      onChatClose(chatId);
    };

    return (
      <div className="bg-zinc-50 dark:bg-zinc-900 gap-2 mx-4 mt-0 rounded-md p-1 relative">
        <div className="flex items-center">
          <div className="flex-1 pr-20 overflow-hidden">
            {activeChatTabs.length > 0 ? (
              <Tabs
                value={activeChatId || "new"}
                onValueChange={handleTabChange}
              >
                <TabsList className="h-8 overflow-hidden">
                  {activeChatTabs.map((tab) => (
                    <TabsTrigger
                      key={tab.chatId || "new"}
                      value={tab.chatId || "new"}
                      className="text-xs h-6 px-2 relative group"
                    >
                      <span className="mr-1">
                        {!tab.chatId
                          ? "New Chat"
                          : tab.chatId === activeChatId && displayedTitle
                            ? displayedTitle + (isAnimating ? "|" : "")
                            : truncateTitle(tab.title)}
                      </span>
                      {(tab.chatId || activeChatTabs.length > 1) && (
                        <div
                          className={`absolute top-0 right-0 h-full w-6 p-0 opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer rounded-sm flex items-center justify-center ${
                            tab.chatId === activeChatId
                              ? "group-hover:bg-background/80 dark:group-hover:bg-input/50"
                              : "group-hover:bg-muted/50 dark:group-hover:bg-muted/20"
                          }`}
                          onClick={(e) => handleTabClose(e, tab.chatId)}
                        >
                          <X className="h-3 w-3" />
                        </div>
                      )}
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
          <div className="absolute top-1 right-1 flex items-center bg-zinc-50 dark:bg-zinc-900 z-10">
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
                    <DropdownMenuLabel className="text-xs text-gray-600 dark:text-gray-400">
                      Chat History
                    </DropdownMenuLabel>
                    {historyItems.map((item) => (
                      <DropdownMenuItem
                        key={item.chat_id}
                        onClick={() => handleHistoryItemClick(item.chat_id)}
                        className="text-xs cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-900/20 hover:text-zinc-600 dark:hover:text-zinc-400 transition-colors duration-200"
                      >
                        <div className="flex items-center gap-2 w-full">
                          <div className="w-4 h-4 flex items-center justify-center">
                            {activeChatTabs.some(
                              (tab) => tab.chatId === item.chat_id,
                            ) && (
                              <Check className="w-3 h-3 text-zinc-600 dark:text-zinc-300" />
                            )}
                          </div>
                          <div className="font-normal truncate font-medium text-neutral-800 dark:text-neutral-300 flex-1">
                            {item.chat_title}
                          </div>
                        </div>
                      </DropdownMenuItem>
                    ))}
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
