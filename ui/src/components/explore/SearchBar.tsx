'use client';

import React, { useState } from 'react';
import { IoMdClose} from "react-icons/io";
import { TbCategory } from "react-icons/tb";
import { LuSquareEqual } from "react-icons/lu";
import { ChevronDownIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

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
  { label: 'log', value: 'log' },
];

const OPERATIONS = [
  { label: '=', value: '=' },
  // { label: 'contains', value: 'contains' },
];

const LOGICAL_OPERATORS = [
  { label: 'AND', value: 'AND' },
  // { label: 'OR', value: 'OR' }
];

const SearchBar: React.FC<SearchBarProps> = ({ onSearch, onClear }) => {
  const [criteria, setCriteria] = useState<SearchCriterion[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [currentCriterion, setCurrentCriterion] = useState<Partial<SearchCriterion>>({});
  const [inputValue, setInputValue] = useState('');
  const [logCategoryValue, setLogCategoryValue] = useState('');

  const handleAddCriterion = () => {
    const categoryValue = currentCriterion.category === 'log' ? logCategoryValue.trim() : currentCriterion.category;

    if (categoryValue && currentCriterion.operation && inputValue.trim()) {
      const newCriterion: SearchCriterion = {
        id: Date.now().toString(),
        category: categoryValue,
        operation: currentCriterion.operation,
        value: inputValue.trim(),
        logicalOperator: criteria.length > 0 ? (currentCriterion.logicalOperator || 'AND') : undefined
      };

      const newCriteria = [...criteria, newCriterion];
      setCriteria(newCriteria);
      setCurrentCriterion({});
      setInputValue('');
      setLogCategoryValue('');
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
    const category = CATEGORIES.find(cat => cat.value === value);
    return category ? category.label : value;
  };

  const getOperationLabel = (value: string) => {
    return OPERATIONS.find(op => op.value === value)?.label || value;
  };

  return (
    <div className="relative flex items-start gap-2 justify-start">
      <div
        className={`flex flex-col gap-2 px-2 py-1 border rounded-md transition-all duration-200 min-h-[2rem] max-h-[10rem] ${criteria.length === 0 ? 'justify-center' : ''} w-auto max-w-md`}
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
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => handleRemoveCriterion(criterion.id)}
                    className="ml-1 h-4 w-4 p-0 text-black dark:text-gray-300 hover:text-red-500 dark:hover:text-red-400"
                  >
                    <IoMdClose className="w-3 h-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Main search input row */}
        <div className="flex flex-wrap items-center justify-start gap-2 min-h-[2rem]">
          {/* Category selector */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="px-2 py-1 text-xs h-auto whitespace-nowrap font-medium"
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
                <ChevronDownIcon className="ml-1 size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-48">
              <DropdownMenuRadioGroup
                value={currentCriterion.category || ''}
                onValueChange={(value) => {
                  setCurrentCriterion({ ...currentCriterion, category: value });
                  if (value !== 'log') {
                    setLogCategoryValue('');
                  }
                }}
              >
                {CATEGORIES.map((category) => (
                  <DropdownMenuRadioItem
                    key={category.value}
                    value={category.value}
                    className="text-xs"
                  >
                    {category.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Log category input (only show when log is selected) */}
          {currentCriterion.category === 'log' && (
            <Input
              type="text"
              value={logCategoryValue}
              onChange={(e) => setLogCategoryValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder=""
              className="w-26 min-w-[80px] h-6.5 text-xs"
            />
          )}

          {/* Operation selector */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="px-1 py-1 text-xs h-auto whitespace-nowrap font-medium"
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
                <ChevronDownIcon className="ml-1 size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-32">
              <DropdownMenuRadioGroup
                value={currentCriterion.operation || ''}
                onValueChange={(value) => {
                  setCurrentCriterion({ ...currentCriterion, operation: value });
                }}
              >
                {OPERATIONS.map((operation) => (
                  <DropdownMenuRadioItem
                    key={operation.value}
                    value={operation.value}
                    className="text-xs"
                  >
                    {operation.label}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Logical operator selector (only show if there are existing criteria) */}
          {criteria.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="px-1 py-1 text-xs whitespace-nowrap font-medium h-7 min-h-[2.5rem]"
                >
                  {currentCriterion.logicalOperator || 'AND'}
                  <ChevronDownIcon className="ml-1 size-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-20">
                <DropdownMenuRadioGroup
                  value={currentCriterion.logicalOperator || 'AND'}
                  onValueChange={(value) => {
                    setCurrentCriterion({ ...currentCriterion, logicalOperator: value as 'AND' | 'OR' });
                  }}
                >
                  {LOGICAL_OPERATORS.map((operator) => (
                    <DropdownMenuRadioItem
                      key={operator.value}
                      value={operator.value}
                      className="text-xs"
                    >
                      {operator.label}
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Value input */}
          <Input
            type="text"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder=""
            className="w-28 min-w-[80px] h-6.5 text-xs"
          />

          {/* cross button */}
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              // Clear all completed criteria
              setCriteria([]);
              // Clear current criterion being built
              setCurrentCriterion({});
              // Clear input value
              setInputValue('');
              // Clear log category value
              setLogCategoryValue('');
              // Call parent clear function
              onClear();
            }}
            className="w-6 h-6 opacity-70 transition-opacity hover:opacity-100 flex-shrink-0"
          >
            <IoMdClose className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
};

export default SearchBar;
