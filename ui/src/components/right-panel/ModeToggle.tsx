'use client';

import React from 'react';
import { RiRobot2Line } from "react-icons/ri";
import { GoFileCode, GoTelescope } from "react-icons/go";

export type ViewType = 'log' | 'agent' | 'trace';

interface ModeToggleProps {
  viewType: ViewType;
  onViewTypeChange: (type: ViewType) => void;
}

export default function ModeToggle({ viewType, onViewTypeChange }: ModeToggleProps) {
  return (
    <div className="flex justify-end p-4">
      <div className="inline-flex rounded-md bg-gray-10 dark:bg-gray-300 ring-1 ring-gray-200 dark:ring-gray-600">
        <button
          onClick={() => onViewTypeChange('log')}
          className={`px-4 py-2 text-sm rounded-md my-0.5 ${
            viewType === 'log'
              ? 'bg-green-50 dark:bg-green-900/10 text-green-700 dark:text-green-300'
              : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
        >
          <GoFileCode size={18} />
        </button>
        <button
          onClick={() => onViewTypeChange('agent')}
          className={`px-4 py-2 text-sm rounded-md my-0.5 ${
            viewType === 'agent'
              ? 'bg-green-50 dark:bg-green-900/10 text-green-700 dark:text-green-300'
              : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
        >
          <RiRobot2Line size={18} />
        </button>
        <button
          onClick={() => onViewTypeChange('trace')}
          className={`px-4 py-2 text-sm rounded-md my-0.5 ${
            viewType === 'trace'
              ? 'bg-green-50 dark:bg-green-900/10 text-green-700 dark:text-green-300'
              : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
          }`}
        >
          <GoTelescope size={18} />
        </button>
      </div>
    </div>
  );
}
