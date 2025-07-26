'use client';

import React, { useState, useRef, useEffect } from 'react';
import { IoMdClose} from "react-icons/io";
import { IoIosSearch } from "react-icons/io";
import { TbCategory } from "react-icons/tb";
import { LuSquareEqual } from "react-icons/lu";

export interface SearchCriterion {
  id: string;
  category: string;
  operation: string;
  value: string;
  logicalOperator?: 'AND' | 'OR';
}

interface SearchBarProps {
  onSearch: (criteria: SearchCriterion[]) => void;
  onClear: () => void;
}

const CATEGORIES = [
  { label: 'service', value: 'service_name' },
  { label: 'env', value: 'service_environment' },
  { label: 'duration', value: 'duration' },
  { label: 'percentile', value: 'percentile' },
];

const OPERATIONS = [
  { label: '=', value: '=' },
  { label: 'contains', value: 'contains' },
];

const LOGICAL_OPERATORS = [
  { label: 'AND', value: 'AND' },
  { label: 'OR', value: 'OR' }
];

const SearchBar: React.FC<SearchBarProps> = ({ onSearch, onClear }) => {
  const [criteria, setCriteria] = useState<SearchCriterion[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [showCategoryDropdown, setShowCategoryDropdown] = useState(false);
  const [showOperationDropdown, setShowOperationDropdown] = useState(false);
  const [showLogicalDropdown, setShowLogicalDropdown] = useState(false);
  const [currentCriterion, setCurrentCriterion] = useState<Partial<SearchCriterion>>({});
  const [inputValue, setInputValue] = useState('');
  const [activeDropdown, setActiveDropdown] = useState<string | null>(null);

  const searchBarRef = useRef<HTMLDivElement>(null);
  const categoryDropdownRef = useRef<HTMLDivElement>(null);
  const operationDropdownRef = useRef<HTMLDivElement>(null);
  const logicalDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        searchBarRef.current &&
        !searchBarRef.current.contains(event.target as Node) &&
        !categoryDropdownRef.current?.contains(event.target as Node) &&
        !operationDropdownRef.current?.contains(event.target as Node) &&
        !logicalDropdownRef.current?.contains(event.target as Node)
      ) {
        setIsExpanded(false);
        setActiveDropdown(null);
        setShowCategoryDropdown(false);
        setShowOperationDropdown(false);
        setShowLogicalDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleAddCriterion = () => {
    if (currentCriterion.category && currentCriterion.operation && inputValue.trim()) {
      const newCriterion: SearchCriterion = {
        id: Date.now().toString(),
        category: currentCriterion.category,
        operation: currentCriterion.operation,
        value: inputValue.trim(),
        logicalOperator: criteria.length > 0 ? (currentCriterion.logicalOperator || 'AND') : undefined
      };

      const newCriteria = [...criteria, newCriterion];
      setCriteria(newCriteria);
      setCurrentCriterion({});
      setInputValue('');
      onSearch(newCriteria);
    }
  };

  const handleRemoveCriterion = (id: string) => {
    const newCriteria = criteria.filter(c => c.id !== id);
    setCriteria(newCriteria);
    onSearch(newCriteria);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleAddCriterion();
    }
  };

  const getCategoryLabel = (value: string) => {
    return CATEGORIES.find(cat => cat.value === value)?.label || value;
  };

  const getOperationLabel = (value: string) => {
    return OPERATIONS.find(op => op.value === value)?.label || value;
  };

  return (
    <div ref={searchBarRef} className="relative flex items-start gap-2 justify-start">
      <div
        className={`flex flex-col gap-2 px-3 py-1 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-800 ${
          isExpanded ? 'ring-2 ring-green-500' : 'hover:border-gray-400 dark:hover:border-gray-500'
        } transition-all duration-200 min-h-[2rem] max-h-[10rem] ${criteria.length === 0 ? 'justify-center' : ''} w-auto max-w-md`}
        onClick={() => setIsExpanded(true)}
      >
        {/* Search criteria blocks */}
        {criteria.length > 0 && (
          <div className="flex flex-wrap gap-2 pb-1 mb-1 border-b border-gray-200 dark:border-gray-600 max-h-[8rem] overflow-y-auto">
            {criteria.map((criterion, index) => (
              <div key={criterion.id} className="flex items-center space-x-1">
                {index > 0 && (
                  <span className="px-2 py-1 bg-blue-100 dark:bg-blue-900/20 text-blue-800 dark:text-blue-300 rounded-md text-xs font-medium">
                    {criterion.logicalOperator}
                  </span>
                )}
                <div className="flex items-center space-x-1 bg-gray-100 dark:bg-gray-700 rounded-lg px-3 py-1">
                  <span className="text-xs font-medium text-gray-700 dark:text-gray-300">
                    {getCategoryLabel(criterion.category)}
                  </span>
                  <span className="text-xs text-gray-500 dark:text-gray-400">
                    {getOperationLabel(criterion.operation)}
                  </span>
                  <span className="text-xs font-medium text-gray-900 dark:text-gray-100">
                    {criterion.value}
                  </span>
                  <button
                    onClick={() => handleRemoveCriterion(criterion.id)}
                    className="ml-2 text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400"
                  >
                    <IoMdClose className="w-3 h-3" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Main search input row */}
        <div className="flex flex-wrap items-center justify-start gap-2 min-h-[2rem]">
          <IoIosSearch className="w-4 h-4 text-gray-500 flex-shrink-0" />

          {/* Category selector */}
          <div className="relative flex-shrink-0">
            <button
              className={`px-2 py-1 text-xs rounded-md border ${
                currentCriterion.category
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-600 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-800/30'
                  : 'bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 text-xs'
              } whitespace-nowrap`}
              onClick={(e) => {
                e.stopPropagation();
                setActiveDropdown(activeDropdown === 'category' ? null : 'category');
                setShowCategoryDropdown(!showCategoryDropdown);
                setShowOperationDropdown(false);
                setShowLogicalDropdown(false);
              }}
            >
              <span className="hidden md:inline">
                {currentCriterion.category ? getCategoryLabel(currentCriterion.category) : <TbCategory className="w-4 h-4" />}
              </span>
              <span className="hidden sm:inline md:hidden">
                {currentCriterion.category ? getCategoryLabel(currentCriterion.category).substring(0, 8) : <TbCategory className="w-4 h-4" />}
              </span>
              <span className="sm:hidden">
                {currentCriterion.category ? getCategoryLabel(currentCriterion.category).substring(0, 3) : <TbCategory className="w-4 h-4" />}
              </span>
            </button>

            {showCategoryDropdown && (
              <div ref={categoryDropdownRef} className="text-xs absolute top-full left-0 mt-1 w-48 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-lg z-50">
                {CATEGORIES.map((category) => (
                  <button
                    key={category.value}
                    onClick={() => {
                      setCurrentCriterion({ ...currentCriterion, category: category.value });
                      setShowCategoryDropdown(false);
                      setActiveDropdown(null);
                    }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 first:rounded-t-md last:rounded-b-md"
                  >
                    {category.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Operation selector */}
          <div className="relative flex-shrink-0">
            <button
              className={`px-2 py-1 text-sm rounded-md border ${
                currentCriterion.operation
                  ? 'bg-green-50 dark:bg-green-900/20 border-green-300 dark:border-green-600 text-green-700 dark:text-green-300 hover:bg-green-100 dark:hover:bg-green-800/30'
                  : 'bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-400 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 text-xs'
              } whitespace-nowrap`}
              onClick={(e) => {
                e.stopPropagation();
                setActiveDropdown(activeDropdown === 'operation' ? null : 'operation');
                setShowOperationDropdown(!showOperationDropdown);
                setShowCategoryDropdown(false);
                setShowLogicalDropdown(false);
              }}
            >
              <span className="hidden md:inline">
                {currentCriterion.operation ? getOperationLabel(currentCriterion.operation) : <LuSquareEqual className="w-4 h-4" />}
              </span>
              <span className="hidden sm:inline md:hidden">
                {currentCriterion.operation ? getOperationLabel(currentCriterion.operation) : <LuSquareEqual className="w-4 h-4" />}
              </span>
              <span className="sm:hidden">
                {currentCriterion.operation ? getOperationLabel(currentCriterion.operation) : <LuSquareEqual className="w-4 h-4" />}
              </span>
            </button>

            {showOperationDropdown && (
              <div ref={operationDropdownRef} className="absolute top-full left-0 mt-1 w-32 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-md shadow-md z-50">
                {OPERATIONS.map((operation) => (
                  <button
                    key={operation.value}
                    onClick={() => {
                      setCurrentCriterion({ ...currentCriterion, operation: operation.value });
                      setShowOperationDropdown(false);
                      setActiveDropdown(null);
                    }}
                    className="w-full text-left px-3 py-2 text-xs hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 first:rounded-t-md last:rounded-b-md"
                  >
                    {operation.label}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Logical operator selector (only show if there are existing criteria) */}
          {criteria.length > 0 && (
            <div className="relative flex-shrink-0">
              <button
                className={`px-2 py-1 text-sm rounded-md border ${
                  currentCriterion.logicalOperator
                    ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-800/30'
                    : 'bg-gray-50 dark:bg-gray-700 border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-600'
                } whitespace-nowrap`}
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveDropdown(activeDropdown === 'logical' ? null : 'logical');
                  setShowLogicalDropdown(!showLogicalDropdown);
                  setShowCategoryDropdown(false);
                  setShowOperationDropdown(false);
                }}
              >
                {currentCriterion.logicalOperator || 'AND'}
              </button>

              {showLogicalDropdown && (
                <div ref={logicalDropdownRef} className="absolute top-full left-0 mt-1 w-20 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg shadow-lg z-50">
                  {LOGICAL_OPERATORS.map((operator) => (
                    <button
                      key={operator.value}
                      onClick={() => {
                        setCurrentCriterion({ ...currentCriterion, logicalOperator: operator.value as 'AND' | 'OR' });
                        setShowLogicalDropdown(false);
                        setActiveDropdown(null);
                      }}
                      className="w-full text-left px-3 py-2 text-sm hover:bg-gray-50 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 first:rounded-t-lg last:rounded-b-lg"
                    >
                      {operator.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Value input */}
          <input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder=""
            className="w-45 min-w-[80px] px-2 py-1 text-sm border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-transparent text-xs"
          />

          {/* cross button */}
          <button
            onClick={() => {
              // Clear all completed criteria
              setCriteria([]);
              // Clear current criterion being built
              setCurrentCriterion({});
              // Clear input value
              setInputValue('');
              // Close all dropdowns
              setShowCategoryDropdown(false);
              setShowOperationDropdown(false);
              setShowLogicalDropdown(false);
              setActiveDropdown(null);
              // Call parent clear function
              onClear();
            }}
            className="w-6 h-6 mt-1 text-gray-400 hover:text-red-500 dark:text-gray-500 dark:hover:text-red-400 flex items-center justify-center rounded-full hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors flex-shrink-0"
          >
            <IoMdClose className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

export default SearchBar;
