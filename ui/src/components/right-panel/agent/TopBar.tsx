import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { GoHistory, GoPlus } from "react-icons/go";
import { ChatMetadata } from '@/models/chat';
import { useUser } from '@/hooks/useUser';
import History from './History';

interface TopBarProps {
  chatId: string | null;
  traceId?: string;
  onNewChat: () => void;
  onHistoryItemClick: (chatId: string) => Promise<void>;
}

export interface TopBarRef {
  refreshMetadata: () => Promise<void>;
}

const TopBar = forwardRef<TopBarRef, TopBarProps>(({ chatId, traceId, onNewChat, onHistoryItemClick }, ref) => {
  const { getAuthState } = useUser();
  const [showHistoryDropdown, setShowHistoryDropdown] = useState(false);
  const [chatMetadata, setChatMetadata] = useState<ChatMetadata | null>(null);
  const [displayedTitle, setDisplayedTitle] = useState<string>('');
  const [isAnimating, setIsAnimating] = useState(false);
  const historyButtonRef = useRef<HTMLDivElement>(null);
  const animationControllerRef = useRef<{ cancelled: boolean } | null>(null);

  // Function to fetch chat metadata
  const fetchChatMetadata = async () => {
    if (!chatId) {
      setChatMetadata(null);
      return;
    }

    try {
      const response = await fetch(`/api/get_chat_metadata?chat_id=${encodeURIComponent(chatId)}`, {
        headers: {
          'Authorization': `Bearer ${getAuthState()}`,
        },
      });
      if (response.ok) {
        const metadata: ChatMetadata = await response.json();
        setChatMetadata(metadata);
      } else {
        console.error('Failed to fetch chat metadata:', response.status);
        setChatMetadata(null);
      }
    } catch (error) {
      console.error('Error fetching chat metadata:', error);
      setChatMetadata(null);
    }
  };

  // Expose refreshMetadata function through ref
  useImperativeHandle(ref, () => ({
    refreshMetadata: fetchChatMetadata,
  }), [chatId]);

  // Fetch chat metadata when chatId changes
  useEffect(() => {
    fetchChatMetadata();
  }, [chatId]);

  // Animate title transitions
  useEffect(() => {
    const newTitle = chatMetadata?.chat_title || '';

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
        setDisplayedTitle('');
      }

      // Small pause between animations
      await new Promise(resolve => setTimeout(resolve, 100));

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
          await new Promise(resolve => setTimeout(resolve, 40));
        }
      }

      // Only update isAnimating if this animation wasn't cancelled
      if (!controller.cancelled) {
        setIsAnimating(false);
      }
    };

    animateTitle();
  }, [chatMetadata?.chat_title]);

  // Handle clicking outside the history dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (historyButtonRef.current && !historyButtonRef.current.contains(event.target as Node)) {
        setShowHistoryDropdown(false);
      }
    };

    if (showHistoryDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showHistoryDropdown]);

  const handleHistoryClick = () => {
    setShowHistoryDropdown(!showHistoryDropdown);
  };

  const handleCloseHistory = () => {
    setShowHistoryDropdown(false);
  };

  const handleHistoryItemClickInternal = async (chatId: string) => {
    setShowHistoryDropdown(false);
    await onHistoryItemClick(chatId);
  };

  return (
    <div className="flex items-center justify-between bg-gray-100 dark:bg-gray-700 gap-2 mx-4 py-1 rounded-md">
      <div className="flex items-center pl-3">
        {!chatId && (
          <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
            New Chat
          </span>
        )}
        {chatId && (
          <div className="relative">
            <span className={`text-xs font-medium text-gray-700 dark:text-gray-300 transition-opacity duration-300 ${isAnimating ? 'opacity-70' : 'opacity-100'}`}>
              {displayedTitle || (isAnimating ? '' : 'Loading...')}
              {isAnimating && (
                <span className="inline-block animate-pulse ml-1">|</span>
              )}
            </span>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          className="mr-1 p-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
          onClick={onNewChat}
          title="Start new chat"
        >
          <GoPlus className="w-5 h-5" />
        </button>
        <div className="relative" ref={historyButtonRef}>
          <button
            className="mr-1 p-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg transition-colors"
            onClick={handleHistoryClick}
            title="View chat history"
          >
            <GoHistory className="w-5 h-5" />
          </button>

          <History
            traceId={traceId}
            isVisible={showHistoryDropdown}
            onHistoryItemClick={handleHistoryItemClickInternal}
            onClose={handleCloseHistory}
          />
        </div>
      </div>
    </div>
  );
});

export default TopBar;
