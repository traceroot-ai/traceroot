import React, { useEffect, useState } from 'react';
import { ChatMetadataHistory } from '@/models/chat';
import { useUser } from '@/hooks/useUser';

interface HistoryItem {
  chat_id: string;
  chat_title: string;
  timestamp: number;
}

interface HistoryProps {
  traceId?: string;
  isVisible: boolean;
  onHistoryItemClick: (chatId: string) => void;
  onClose: () => void;
}

export default function History({ traceId, isVisible, onHistoryItemClick, onClose }: HistoryProps) {
  const { getAuthState } = useUser();
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    const fetchChatHistory = async () => {
      if (!isVisible || !traceId) return;

      setIsLoading(true);
      try {
        const response = await fetch(`/api/get_chat_metadata_history?trace_id=${encodeURIComponent(traceId)}`, {
          headers: {
            'Authorization': `Bearer ${getAuthState()}`,
          },
        });
        if (response.ok) {
          const data: ChatMetadataHistory = await response.json();
          const formattedItems: HistoryItem[] = data.history.map(item => ({
            chat_id: item.chat_id,
            chat_title: item.chat_title,
            timestamp: item.timestamp,
          })).sort((a, b) => b.timestamp - a.timestamp);
          setHistoryItems(formattedItems);
        } else {
          console.error('Failed to fetch chat history:', response.statusText);
          setHistoryItems([]);
        }
      } catch (error) {
        console.error('Error fetching chat history:', error);
        setHistoryItems([]);
      } finally {
        setIsLoading(false);
      }
    };

    fetchChatHistory();
  }, [isVisible, traceId]);

  if (!isVisible) return null;

  return (
    <>
      {/* Backdrop to close dropdown when clicking outside */}
      <div
        className="fixed inset-0 z-10"
        onClick={onClose}
      />

      {/* History dropdown */}
      <div className="absolute top-full right-0 mt-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg py-2 min-w-[300px] max-w-[400px] z-20 max-h-[300px] overflow-y-auto">
        {isLoading ? (
          <div className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
            Loading chat history...
          </div>
        ) : historyItems.length === 0 ? (
          <div className="px-4 py-3 text-xs text-gray-500 dark:text-gray-400">
            No chat history available
          </div>
        ) : (
          <div className="space-y-1">
            {historyItems.map((item) => (
              <button
                key={item.chat_id}
                onClick={() => {
                  onHistoryItemClick(item.chat_id);
                  onClose();
                }}
                className="w-full text-left px-4 py-3 text-xs hover:bg-green-50 dark:hover:bg-green-900/20 hover:text-green-600 dark:hover:text-green-400 transition-colors duration-200 border-b border-gray-100 dark:border-gray-700 last:border-b-0"
              >
                <div className="truncate text-xs font-medium text-gray-900 dark:text-gray-100">
                  {item.chat_title}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

export type { HistoryItem };
