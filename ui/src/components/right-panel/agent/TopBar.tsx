import React, {
  useState,
  useRef,
  useEffect,
  useImperativeHandle,
  forwardRef,
} from "react";
import { GoHistory } from "react-icons/go";
import { Plus } from "lucide-react";
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

interface TopBarProps {
  chatId: string | null;
  traceId?: string;
  onNewChat: () => void;
  onHistoryItemClick: (chatId: string) => Promise<void>;
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
  ({ chatId, traceId, onNewChat, onHistoryItemClick }, ref) => {
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
      if (!chatId) {
        setChatMetadata(null);
        return;
      }

      try {
        const response = await fetch(
          `/api/get_chat_metadata?chat_id=${encodeURIComponent(chatId)}`,
          {
            headers: {
              Authorization: `Bearer ${getAuthState()}`,
            },
          },
        );
        if (response.ok) {
          const metadata: ChatMetadata = await response.json();
          setChatMetadata(metadata);
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
      [chatId],
    );

    // Fetch chat metadata when chatId changes
    useEffect(() => {
      fetchChatMetadata();
    }, [chatId]);

    // Fetch chat history when dropdown opens
    useEffect(() => {
      if (dropdownOpen) {
        fetchChatHistory();
      }
    }, [dropdownOpen, traceId]);

    // Animate title transitions
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
        // Phase 1: Make old title disappear instantly
        if (displayedTitle) {
          setDisplayedTitle("");
        }

        // Small pause between animations
        await new Promise((resolve) => setTimeout(resolve, 100));

        // Check if animation was cancelled
        if (controller.cancelled) {
          return;
        }

        // Phase 2: Fade in new title from left to right
        if (newTitle) {
          for (let i = 0; i <= newTitle.length; i++) {
            // Check if animation was cancelled before each character
            if (controller.cancelled) {
              return;
            }

            setDisplayedTitle(newTitle.substring(0, i));
            await new Promise((resolve) => setTimeout(resolve, 40));
          }
        }

        // Only update isAnimating if this animation wasn't cancelled
        if (!controller.cancelled) {
          setIsAnimating(false);
        }
      };

      animateTitle();
    }, [chatMetadata?.chat_title]);

    const handleHistoryItemClick = async (selectedChatId: string) => {
      setDropdownOpen(false);
      await onHistoryItemClick(selectedChatId);
    };

    return (
      <div className="flex items-center justify-between bg-zinc-50 dark:bg-zinc-900 gap-2 mx-4 mt-1 rounded-md p-1">
        <div className="flex items-center pl-3">
          {!chatId && (
            <span className="text-xs font-medium font-mono text-neutral-800 dark:text-neutral-300">
              New Chat
            </span>
          )}
          {chatId && (
            <div className="relative">
              <span
                className={`text-xs font-medium text-gray-700 dark:text-gray-300 transition-opacity duration-300 ${isAnimating ? "opacity-70" : "opacity-100"}`}
              >
                {displayedTitle || (isAnimating ? "" : "Loading...")}
                {isAnimating && (
                  <span className="inline-block animate-pulse ml-1">|</span>
                )}
              </span>
            </div>
          )}
        </div>
        <div className="flex items-center">
          <Button
            variant="ghost"
            size="icon"
            className="mr-1"
            onClick={onNewChat}
            title="Start new chat"
          >
            <Plus className="w-5 h-5" />
          </Button>

          <DropdownMenu open={dropdownOpen} onOpenChange={setDropdownOpen}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="mr-1"
                title="View chat history"
              >
                <GoHistory className="w-5 h-5" />
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
                historyItems.map((item) => (
                  <DropdownMenuItem
                    key={item.chat_id}
                    onClick={() => handleHistoryItemClick(item.chat_id)}
                    className="text-xs cursor-pointer hover:bg-zinc-100 dark:hover:bg-zinc-900/20 hover:text-zinc-600 dark:hover:text-zinc-400 transition-colors duration-200"
                  >
                    <div className="flex items-center gap-2 w-full">
                      <div className="w-4 h-4 flex items-center justify-center">
                        {chatId === item.chat_id && (
                          <div className="w-1.5 h-1.5 rounded-full bg-black dark:bg-white"></div>
                        )}
                      </div>
                      <div className="font-normal truncate font-medium text-neutral-800 dark:text-neutral-300 flex-1">
                        {item.chat_title}
                      </div>
                    </div>
                  </DropdownMenuItem>
                ))
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    );
  },
);

export default TopBar;
