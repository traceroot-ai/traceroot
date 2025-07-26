import React from 'react';
import { IoMdRefresh } from "react-icons/io";

interface RefreshButtonProps {
  onRefresh: () => void;
}

const RefreshButton: React.FC<RefreshButtonProps> = ({ onRefresh }) => {
  return (
    <button
      onClick={onRefresh}
      className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-600 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 transition-colors min-h-[2.5rem] flex items-center"
    >
      <div className="flex items-center space-x-2">
        <IoMdRefresh className="w-4 h-4" />
      </div>
    </button>
  );
};

export default RefreshButton;
