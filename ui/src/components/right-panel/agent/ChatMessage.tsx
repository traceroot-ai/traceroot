import React, { useState } from 'react';
import { RiRobot2Line } from "react-icons/ri";
import { GoCopy } from "react-icons/go";
import { FaGithub } from "react-icons/fa";
import { useUser } from '../../../hooks/useUser';
import { Reference } from '../../../models/chat';

interface Message {
  id: string;
  content: string;
  role: 'user' | 'assistant' | 'github';
  timestamp: Date | string; // Allow both Date and string for formatted timestamps
  references?: Reference[];
}

interface ChatMessageProps {
  messages: Message[];
  isLoading: boolean;
  userAvatarUrl?: string;
  messagesEndRef: React.RefObject<HTMLDivElement | null>;
}

// Helper function to format timestamp like in LogDetail
const formatTimestamp = (timestamp: Date | string) => {
  const date = typeof timestamp === 'string' ? new Date(timestamp) : timestamp;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const y = date.getFullYear();
  const m = months[date.getMonth()];
  const d = date.getDate();
  const h = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');

  // Add ordinal suffix to day
  const getOrdinalSuffix = (day: number) => {
    if (day >= 11 && day <= 13) return 'th';
    switch (day % 10) {
      case 1: return 'st';
      case 2: return 'nd';
      case 3: return 'rd';
      default: return 'th';
    }
  };

  return `${y} ${m} ${d}${getOrdinalSuffix(d)} ${h}:${min}:${s}`;
};

// Helper function to get log level colors
const getLogLevelColor = (level: string) => {
  switch (level) {
    case 'CRITICAL':
      return 'font-medium text-[#7f1d1d]';
    case 'ERROR':
      return 'font-medium text-[#dc2626]';
    case 'WARNING':
      return 'font-medium text-[#fb923c]';
    case 'INFO':
      return 'font-medium text-[#64748b]';
    case 'DEBUG':
      return 'font-medium text-[#a855f7]';
    default:
      return 'font-medium text-[#64748b]';
  }
};

// Simple markdown renderer for basic formatting
const renderMarkdown = (text: string, messageId: string, references?: Reference[], hoveredRef?: {messageId: string, refNum: number} | null, onReferenceHover?: (messageId: string, refNum: number | null) => void): React.ReactNode => {
  let currentIndex = 0;

  console.log('🔍 renderMarkdown called with text:', text);

  // Patterns for markdown elements (order matters - code blocks should be processed first)
  const patterns = [
    // PR created pattern - MUST be first to catch it before other patterns
    {
      regex: /PR created:\s*https:\/\/github\.com\/([^\/\s]+)\/([^\/\s]+)\/pull\/(\d+)/g,
      component: (match: string, ...args: string[]) => {
        const owner = args[0];
        const repo = args[1];
        const pullNumber = args[2];
        const fullUrl = `https://github.com/${owner}/${repo}/pull/${pullNumber}`;

        console.log('🎯 PR PATTERN MATCHED!!! - match:', match, 'owner:', owner, 'repo:', repo, 'pullNumber:', pullNumber);

        return (
          <span key={currentIndex++}>
            PR created: <a
              href={fullUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-black dark:text-white hover:text-gray-600 dark:hover:text-gray-300 underline font-medium transition-colors"
              title={`${owner}/${repo} Pull Request #${pullNumber}`}
            >
              PR #{pullNumber}
            </a>
          </span>
        );
      }
    },
    {
      regex: /```(\w+)?\n?([\s\S]*?)```/g,
      component: (match: string, ...args: string[]) => {
        // For code blocks: args[0] might be language, args[1] is content
        // If no language specified, args[0] is content
        const content = args.length > 1 ? args[1] : args[0];
        const trimmedContent = content.trim();

        const handleCopy = async () => {
          try {
            await navigator.clipboard.writeText(trimmedContent);
          } catch (err) {
            console.error('Failed to copy text: ', err);
          }
        };

        return (
          <pre key={currentIndex++} className="bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md p-3 my-2 overflow-x-auto relative group">
            <button
              onClick={handleCopy}
              className="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity duration-200 hover:bg-gray-200 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-400"
              title="Copy code"
            >
              <GoCopy className="w-4 h-4" />
            </button>
            <code className="text-xs font-mono text-gray-800 dark:text-gray-200 whitespace-pre">{trimmedContent}</code>
          </pre>
        );
      }
    },
    // GitHub pull request URL pattern - process before issues to avoid conflicts
    {
      regex: /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/g,
      component: (match: string, ...args: string[]) => {
        const [owner, repo, pullNumber] = args;
        const fullUrl = match;

        return (
          <a
            key={currentIndex++}
            href={fullUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white hover:text-gray-600 dark:hover:text-gray-300 underline font-medium transition-colors"
            title={`${owner}/${repo} Pull Request #${pullNumber}`}
          >
            PR #{pullNumber}
          </a>
        );
      }
    },
    // GitHub issue URL pattern - should be processed early to avoid conflicts with other link patterns
    {
      regex: /https:\/\/github\.com\/([^\/]+)\/([^\/]+)\/issues\/(\d+)/g,
      component: (match: string, ...args: string[]) => {
        const [owner, repo, issueNumber] = args;
        const fullUrl = match;

        return (
          <a
            key={currentIndex++}
            href={fullUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white hover:text-gray-600 dark:hover:text-gray-300 underline font-medium transition-colors"
            title={`${owner}/${repo} Issue #${issueNumber}`}
          >
            #{issueNumber}
          </a>
        );
      }
    },
    // Standard markdown link pattern - [text](url)
    {
      regex: /\[([^\]]+)\]\(([^)]+)\)/g,
      component: (match: string, ...args: string[]) => {
        const [linkText, url] = args;

        return (
          <a
            key={currentIndex++}
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-black dark:text-white hover:text-gray-600 dark:hover:text-gray-300 underline font-medium transition-colors"
            title={linkText}
          >
            {linkText}
          </a>
        );
      }
    },
    // Reference numbers pattern - must come before log level patterns
    { regex: /\[(\d+)\]/g, component: (match: string, ...args: string[]) => {
        const refNumber = parseInt(args[0]);
        const reference = references?.find(ref => ref.number === refNumber);

        // Debug logging
        console.log('Reference pattern matched:', match, 'refNumber:', refNumber, 'reference found:', !!reference, 'hoveredRef:', hoveredRef);
        console.log('Available references:', references);

        return (
          <span
            key={currentIndex++}
            className="relative inline-block cursor-help text-blue-600 dark:text-blue-400 font-medium underline hover:text-blue-800 dark:hover:text-blue-300 transition-colors"
            onMouseEnter={() => {
              console.log('Mouse enter on reference:', refNumber);
              onReferenceHover?.(messageId, refNumber);
            }}
            onMouseLeave={() => {
              console.log('Mouse leave on reference:', refNumber);
              onReferenceHover?.(messageId, null);
            }}
          >
            {match}
            {hoveredRef?.messageId === messageId && hoveredRef?.refNum === refNumber && reference && (
              <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 z-[9999] pointer-events-none">
                <div className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg p-3 min-w-[200px] max-w-[400px] text-xs">
                  <div className="text-gray-900 dark:text-gray-100">
                    {reference.span_id && (
                      <div className="mb-1">
                        <span className="font-semibold">Span ID:</span> {reference.span_id}
                      </div>
                    )}
                    {reference.span_function_name && (
                      <div className="mb-1">
                        <span className="font-semibold">Function:</span> {reference.span_function_name}
                      </div>
                    )}
                    {reference.line_number && (
                      <div className="mb-1">
                        <span className="font-semibold">Line:</span> {reference.line_number}
                      </div>
                    )}
                    {reference.log_message && (
                      <div className="mb-1">
                        <span className="font-semibold">Log:</span>
                        <div className="mt-1 p-2 bg-gray-100 dark:bg-gray-700 rounded text-xs font-mono">
                          {reference.log_message}
                        </div>
                      </div>
                    )}
                  </div>
                  {/* Tooltip arrow */}
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-gray-300 dark:border-t-gray-600"></div>
                </div>
              </div>
            )}
            {/* Debug: Always show if no reference found */}
            {hoveredRef?.messageId === messageId && hoveredRef?.refNum === refNumber && !reference && (
              <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 z-[9999] pointer-events-none">
                <div className="bg-red-100 dark:bg-red-900 border border-red-300 dark:border-red-600 rounded-lg shadow-lg p-3 min-w-[200px] max-w-[400px] text-xs">
                  <div className="text-red-900 dark:text-red-100">
                    No reference data found for [{refNumber}]
                  </div>
                  <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-l-transparent border-r-transparent border-t-red-300 dark:border-t-red-600"></div>
                </div>
              </div>
            )}
          </span>
        );
      }
    },
    // Log level patterns - must come before headers to avoid conflicts
    { regex: /\b(CRITICAL|ERROR|WARNING|INFO|DEBUG)\b/g, component: (match: string, ...args: string[]) => <span key={currentIndex++} className={getLogLevelColor(args[0])}>{args[0]}</span> },
    // Header patterns
    { regex: /###\s+([^\n]+)/g, component: (match: string, ...args: string[]) => <h3 key={currentIndex++} className="text-lg font-bold text-gray-900 dark:text-gray-100 my-1">{renderMarkdown(args[0], messageId, references, hoveredRef, onReferenceHover)}</h3> },
    { regex: /##\s+([^\n]+)/g, component: (match: string, ...args: string[]) => <h2 key={currentIndex++} className="text-xl font-bold text-gray-900 dark:text-gray-100 my-1">{renderMarkdown(args[0], messageId, references, hoveredRef, onReferenceHover)}</h2> },
    { regex: /#\s+([^\n]+)/g, component: (match: string, ...args: string[]) => <h1 key={currentIndex++} className="text-2xl font-bold text-gray-900 dark:text-gray-100 my-1">{renderMarkdown(args[0], messageId, references, hoveredRef, onReferenceHover)}</h1> },
    { regex: /\*\*(.*?)\*\*/g, component: (match: string, ...args: string[]) => <strong key={currentIndex++}>{renderMarkdown(args[0], messageId, references, hoveredRef, onReferenceHover)}</strong> },
    { regex: /\*(.*?)\*/g, component: (match: string, ...args: string[]) => <em key={currentIndex++}>{renderMarkdown(args[0], messageId, references, hoveredRef, onReferenceHover)}</em> },
    { regex: /`(.*?)`/g, component: (match: string, ...args: string[]) => <code key={currentIndex++} className="bg-gray-100 dark:bg-gray-600 px-1 py-0.5 rounded text-xs font-mono">{args[0]}</code> },
  ];

  let remainingText = text;
  const elements: React.ReactNode[] = [];

  while (remainingText.length > 0) {
    let earliestMatch = null;
    let earliestIndex = remainingText.length;
    let matchingPattern = null;

    // Find the earliest pattern match
    for (const pattern of patterns) {
      const match = pattern.regex.exec(remainingText);
      if (match) {
        console.log('Pattern match found:', match[0], 'at index:', match.index, 'regex source:', pattern.regex.source);
      }
      if (match && match.index < earliestIndex) {
        earliestMatch = match;
        earliestIndex = match.index;
        matchingPattern = pattern;
      }
    }

    if (earliestMatch && matchingPattern) {
      // Add text before the match
      if (earliestIndex > 0) {
        elements.push(remainingText.substring(0, earliestIndex));
      }

      // Add the formatted element
      elements.push(matchingPattern.component(earliestMatch[0], ...earliestMatch.slice(1)));

      // Update remaining text
      remainingText = remainingText.substring(earliestIndex + earliestMatch[0].length);

      // Reset regex lastIndex for next iteration
      patterns.forEach(p => p.regex.lastIndex = 0);
    } else {
      // No more matches, add remaining text
      elements.push(remainingText);
      break;
    }
  }

  return elements.length > 0 ? elements : text;
};

export default function ChatMessage({ messages, isLoading, userAvatarUrl, messagesEndRef }: ChatMessageProps) {
  const { avatarLetter } = useUser();
  const [hoveredRef, setHoveredRef] = useState<{messageId: string, refNum: number} | null>(null);

  const handleReferenceHover = (messageId: string, refNum: number | null) => {
    if (refNum === null) {
      setHoveredRef(null);
    } else {
      setHoveredRef({messageId, refNum});
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-4 flex flex-col-reverse bg-zinc-50 dark:bg-zinc-900 mt-4 ml-4 mr-4 mb-2 rounded-lg">
      <div ref={messagesEndRef} />
      {/* Loading indicator */}
      {isLoading && (
        <div className="flex justify-start mb-4 items-start gap-2">
          <div className="w-8 h-8 rounded-full bg-zinc-700 dark:bg-zinc-200 flex items-center justify-center flex-shrink-0 animate-pulse">
            <RiRobot2Line className="w-5 h-5 text-white dark:text-zinc-700" />
          </div>
          <div className="bg-zinc-50 dark:bg-zinc-900 rounded-lg px-4 py-2 min-w-[80px] flex justify-center items-center">
            <div className="typing-indicator">
              <span></span>
              <span></span>
              <span></span>
            </div>
            <style jsx>{`
              .typing-indicator {
                display: flex;
                align-items: center;
                gap: 4px;
                padding: 4px 0;
              }
              .typing-indicator span {
                height: 8px;
                width: 8px;
                background: #6B7280;
                border-radius: 50%;
                display: inline-block;
                animation: typing 1.4s infinite ease-in-out both;
              }
              .typing-indicator span:nth-child(1) {
                animation-delay: 0s;
              }
              .typing-indicator span:nth-child(2) {
                animation-delay: 0.2s;
              }
              .typing-indicator span:nth-child(3) {
                animation-delay: 0.4s;
              }
              @keyframes typing {
                0% {
                  transform: scale(0.6);
                  opacity: 0.6;
                }
                50% {
                  transform: scale(1);
                  opacity: 1;
                }
                100% {
                  transform: scale(0.6);
                  opacity: 0.6;
                }
              }
              .dark .typing-indicator span {
                background: #64748b;
              }
            `}</style>
          </div>
        </div>
      )}
      {messages.map((message) => (
        <div
          key={message.id}
          className={`flex ${
            message.role === 'user' ? 'justify-end' : 'justify-start'
          } mb-4 items-start gap-2`}
        >
          {/* Avatar for assistant and github */}
          {(message.role === 'assistant' || message.role === 'github') && (
            <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-zinc-600 dark:bg-zinc-200 border border-zinc-600 dark:border-zinc-200`}>
              {message.role === 'github' ? (
                <FaGithub className="w-5 h-5 text-white dark:text-zinc-600" />
              ) : (
                <RiRobot2Line className="w-5 h-5 text-white dark:text-zinc-600" />
              )}
            </div>
          )}

          {/* Message content */}
          <div
            className={`max-w-[70%] max-w-[600px] rounded-lg px-4 py-2 break-words ${
              message.role === 'user'
                ? 'bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 border border-zinc-300 dark:border-zinc-700'
                : message.role === 'github'
                ? 'bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 border border-zinc-300 dark:border-zinc-700'
                : 'bg-white dark:bg-zinc-900 text-zinc-800 dark:text-zinc-200 border border-zinc-300 dark:border-zinc-700'
            }`}
          >
            <div className="whitespace-pre-wrap break-words text-sm">{renderMarkdown(message.content, message.id, message.references, hoveredRef, handleReferenceHover)}</div>
            <p className="text-xs mt-1 opacity-70">
              {formatTimestamp(message.timestamp)}
            </p>
          </div>

          {/* Avatar for user */}
          {message.role === 'user' && (
            <div className="w-8 h-8 rounded-full overflow-hidden flex-shrink-0">
              {userAvatarUrl ? (
                <img
                  src={userAvatarUrl}
                  alt="User avatar"
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full bg-sidebar-accent/50 flex items-center justify-center bg-zinc-200 dark:bg-zinc-800">
                  <span className="text-sidebar-accent-foreground font-semibold text-sm">
                    {avatarLetter || 'U'}
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
