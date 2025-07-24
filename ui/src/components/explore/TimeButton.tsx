import React, { useRef, useEffect } from 'react';

export type TimeRange = {
  label: string;
  minutes: number;
};

export const TIME_RANGES: TimeRange[] = [
  { label: 'Last 10 minutes', minutes: 10 },
  { label: 'Last 30 minutes', minutes: 30 },
  { label: 'Last 3 hours', minutes: 3 * 60 },
  { label: 'Last 6 hours', minutes: 6 * 60 },
  { label: 'Last 12 hours', minutes: 12 * 60 },
  { label: 'Last 24 hours', minutes: 24 * 60 },
  { label: 'Last 3 days', minutes: 3 * 24 * 60 },
  { label: 'Last 7 days', minutes: 7 * 24 * 60 },
  { label: 'Last 14 days', minutes: 14 * 24 * 60 },
  { label: 'Last 30 days', minutes: 30 * 24 * 60 },
];

interface TimeButtonProps {
  selectedTimeRange: TimeRange;
  onTimeRangeSelect: (range: TimeRange) => void;
}

export const TimeButton: React.FC<TimeButtonProps> = ({ selectedTimeRange, onTimeRangeSelect }) => {
  const [isDropdownOpen, setIsDropdownOpen] = React.useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleTimeRangeSelect = (range: TimeRange) => {
    if (range.label !== selectedTimeRange.label) {
      onTimeRangeSelect(range);
      setIsDropdownOpen(false);
    } else {
      setIsDropdownOpen(false);
    }
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsDropdownOpen(!isDropdownOpen)}
        className="px-4 py-2 text-xs font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-green-500 min-h-[2.5rem] flex items-center"
      >
        <span className="hidden lg:inline">
          {selectedTimeRange.label}
        </span>
        <span className="hidden md:inline lg:hidden">
          {selectedTimeRange.label.replace('Last ', '')}
        </span>
        <span className="md:hidden">
          {selectedTimeRange.label.replace('Last ', '').replace(' minutes', 'm').replace(' hours', 'h').replace(' days', 'd')}
        </span>
        <span className="ml-2">▼</span>
      </button>

      {isDropdownOpen && (
        <div className="absolute right-0 mt-2 w-48 rounded-md shadow-md bg-white dark:bg-gray-800 ring-1 ring-gray-300 ring-opacity-5 z-10">
          <div className="py-1" role="menu" aria-orientation="vertical">
            {TIME_RANGES.map((range) => (
              <button
                key={range.label}
                onClick={() => handleTimeRangeSelect(range)}
                className={`block w-full text-left px-4 py-2 text-xs rounded-md my-0.5 ${
                  selectedTimeRange.label === range.label
                    ? 'bg-green-50 dark:bg-green-900/10 text-green-700 dark:text-green-300'
                    : 'text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700'
                }`}
                role="menuitem"
              >
                {range.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

export default TimeButton;
