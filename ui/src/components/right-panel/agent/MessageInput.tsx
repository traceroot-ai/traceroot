import React, { useState, useRef, useEffect } from 'react';
import { FaArrowUp } from "react-icons/fa";
import { CiChat2 } from "react-icons/ci";
import { GiBrain } from "react-icons/gi";
import { RiRobot2Line } from "react-icons/ri";
import { CHAT_MODEL_DISPLAY_NAMES, CHAT_MODELS, type ChatModel } from '../../../constants/model';

type Mode = 'agent' | 'chat';

interface MessageInputProps {
  inputMessage: string;
  setInputMessage: (message: string) => void;
  isLoading: boolean;
  onSendMessage: (e: React.FormEvent) => void;
  selectedModel: ChatModel;
  setSelectedModel: (model: ChatModel) => void;
  selectedMode: Mode;
  setSelectedMode: (mode: Mode) => void;
  traceId?: string;
  spanIds?: string[];
}

export default function MessageInput({
  inputMessage,
  setInputMessage,
  isLoading,
  onSendMessage,
  selectedModel,
  setSelectedModel,
  selectedMode,
  setSelectedMode,
  traceId,
  spanIds = []
}: MessageInputProps) {
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showModeDropdown, setShowModeDropdown] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState('auto');

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);
  const modeDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isLoading && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isLoading]);

  const adjustTextareaHeight = () => {
    const textarea = inputRef.current;
    if (!textarea) return;

    // Reset height to auto to get the correct scrollHeight
    textarea.style.height = 'auto';

    // Get the computed line height
    const lineHeight = parseInt(window.getComputedStyle(textarea).lineHeight);
    const minHeight = lineHeight; // One line height
    const maxHeight = lineHeight * 5; // Maximum 5 lines

    // Set the height based on content, but clamp between min and max
    const newHeight = Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight);
    textarea.style.height = `${newHeight}px`;
  };

  useEffect(() => {
    adjustTextareaHeight();
  }, [inputMessage]);

  // Handle clicking outside the dropdowns
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (modelDropdownRef.current && !modelDropdownRef.current.contains(event.target as Node)) {
        setShowModelDropdown(false);
      }
      if (modeDropdownRef.current && !modeDropdownRef.current.contains(event.target as Node)) {
        setShowModeDropdown(false);
      }
    };

    if (showModelDropdown || showModeDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showModelDropdown, showModeDropdown]);

  const handleModelSelect = (model: ChatModel) => {
    setSelectedModel(model);
    setShowModelDropdown(false);
  };

  const toggleModelDropdown = () => {
    setShowModelDropdown(!showModelDropdown);
  };

  const handleModeSelect = (mode: Mode) => {
    setSelectedMode(mode);
    setShowModeDropdown(false);
  };

  const toggleModeDropdown = () => {
    setShowModeDropdown(!showModeDropdown);
  };

  const getModeIcon = (mode: Mode) => {
    return mode === 'agent' ? RiRobot2Line : CiChat2;
  };

  const getModeDisplayName = (mode: Mode) => {
    return mode === 'agent' ? 'Agent' : 'Chat';
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
      <form onSubmit={onSendMessage} className="p-3">
        <div className="mb-1 text-xs text-gray-500 dark:text-gray-400 pb-1 px-1 flex gap-2 items-center">
          {traceId && (
            <span className="rounded-md bg-gray-100 dark:bg-gray-700 px-3 py-1 font-mono text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600">
              Trace: {traceId}
            </span>
          )}
          {spanIds && spanIds.length > 0 && (
            <span className="rounded-md bg-gray-100 dark:bg-gray-700 px-3 py-1 font-mono text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600">
              Spans selected: {spanIds.length}
            </span>
          )}
          {!traceId && (!spanIds || spanIds.length === 0) && (
            <span>No trace or spans selected</span>
          )}
        </div>
        <div className="flex flex-col gap-2">
          <div className="relative w-full">
            <textarea
              ref={inputRef}
              value={inputMessage}
              onChange={(e) => {
                setInputMessage(e.target.value);
                adjustTextareaHeight();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  if (!isLoading && inputMessage.trim()) {
                    // Manually trigger form submit
                    onSendMessage(e as any);
                  }
                }
              }}
              placeholder={isLoading ? "Agent is thinking..." : "Type your message..."}
              className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-4 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all duration-200 resize-none leading-relaxed overflow-y-auto text-sm"
              style={{ height: textareaHeight }}
              disabled={isLoading}
              rows={1}
            />
            {isLoading && (
              <div className="absolute right-3 top-1/2 -translate-y-1/2">
                <div className="w-4 h-4 border-2 border-green-500 border-t-transparent rounded-full animate-spin"></div>
              </div>
            )}
          </div>
          <div className="flex justify-between items-center">
            <div className="flex items-center gap-3">
              {/* Mode selector */}
              <div className="relative" ref={modeDropdownRef}>
                <button
                  type="button"
                  onClick={toggleModeDropdown}
                  className="flex items-center gap-2 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors p-2 rounded-md bg-gray-200"
                >
                  {React.createElement(getModeIcon(selectedMode), { className: "w-4 h-4" })}
                  <span className="text-xs">
                    {getModeDisplayName(selectedMode)}
                  </span>
                </button>

                {/* Mode selection dropdown */}
                {showModeDropdown && (
                  <div className="absolute bottom-full left-0 mb-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-md shadow-md py-1 min-w-[100px] z-10">
                    <button
                      type="button"
                      onClick={() => handleModeSelect('agent')}
                      className={`text-xs w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-1 ${
                        selectedMode === 'agent'
                          ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'
                          : 'text-gray-700 dark:text-gray-300'
                      }`}
                    >
                      <RiRobot2Line className="w-4 h-4" />
                      Agent
                    </button>
                    <button
                      type="button"
                      onClick={() => handleModeSelect('chat')}
                      className={`text-xs w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex items-center gap-1 ${
                        selectedMode === 'chat'
                          ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'
                          : 'text-gray-700 dark:text-gray-300'
                      }`}
                    >
                      <CiChat2 className="w-4 h-4" />
                      Chat
                    </button>
                  </div>
                )}
              </div>

              {/* Brain icon and model display */}
              <div className="relative" ref={modelDropdownRef}>
                <button
                  type="button"
                  onClick={toggleModelDropdown}
                  className="flex items-center gap-1 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition-colors p-2 rounded-md bg-gray-200"
                >
                  <GiBrain className="w-4 h-4" />
                  <span className="text-xs">
                    {CHAT_MODEL_DISPLAY_NAMES[selectedModel]}
                  </span>
                </button>

                {/* Model selection dropdown */}
                {showModelDropdown && (
                  <div className="absolute bottom-full left-0 mb-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg py-1 min-w-[140px] z-10 ">
                    {Object.entries(CHAT_MODELS).map(([key, value]) => (
                      <button
                        key={value}
                        type="button"
                        onClick={() => handleModelSelect(value)}
                        className={`text-xs w-full text-left px-3 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors ${
                          selectedModel === value
                            ? 'bg-green-50 dark:bg-green-900/20 text-green-600 dark:text-green-400'
                            : 'text-gray-700 dark:text-gray-300'
                        }`}
                      >
                        {CHAT_MODEL_DISPLAY_NAMES[value]}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            <button
              type="submit"
              className="bg-green-500 hover:bg-green-600 text-white w-8 h-8 rounded-lg transition-all duration-200 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-green-500 flex items-center justify-center"
              disabled={!inputMessage.trim() || isLoading}
            >
              {isLoading ? (
                <div className="w-3 h-3 border-2 border-white border-t-transparent rounded-xl animate-spin"></div>
              ) : (
                <>
                  <FaArrowUp className="w-4 h-4" />
                </>
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
