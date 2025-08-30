"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { IoMdClose } from "react-icons/io";
import { TbCategory } from "react-icons/tb";
import { LuSquareEqual } from "react-icons/lu";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export interface SearchCriterion {
  id: string;
  category: string;
  operation: string;
  value: string;
  logicalOperator?: "AND" | "OR";
}

interface SearchBarProps {
  onSearch: (criteria: SearchCriterion[]) => void;
  onClear: () => void;
  onLogSearchValueChange?: (value: string) => void;
  onMetadataSearchTermsChange?: (
    terms: { category: string; value: string }[],
  ) => void;
}

const CATEGORIES = [
  { label: "service", value: "service_name" },
  { label: "env", value: "service_environment" },
  { label: "metadata", value: "metadata" },
  { label: "log", value: "log" },
];

const OPERATIONS = [
  { label: "=", value: "=" },
  { label: "contains", value: "contains" },
];

const SearchBar: React.FC<SearchBarProps> = ({
  onSearch,
  onClear,
  onLogSearchValueChange,
  onMetadataSearchTermsChange,
}) => {
  const [criteria, setCriteria] = useState<SearchCriterion[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [currentCriterion, setCurrentCriterion] = useState<
    Partial<SearchCriterion>
  >({ category: "log", operation: "contains" });
  const [inputValue, setInputValue] = useState("");
  const [metadataCategoryValue, setMetadataCategoryValue] = useState("");
  const [metadataValue, setMetadataValue] = useState("");
  const [logSearchValue, setLogSearchValue] = useState("");

  // Memoize extracted search terms to prevent unnecessary re-renders
  const logSearchTerm = useMemo(() => {
    const logSearchTerms = criteria
      .filter((criterion) => criterion.category === "log")
      .map((criterion) => criterion.value);
    return logSearchTerms.length > 0 ? logSearchTerms[0] : "";
  }, [criteria]);

  const metadataSearchTerms = useMemo(() => {
    return criteria
      .filter(
        (criterion) =>
          criterion.category !== "log" &&
          criterion.category !== "service_name" &&
          criterion.category !== "service_environment",
      )
      .map((criterion) => ({
        category: criterion.category,
        value: criterion.value,
      }));
  }, [criteria]);

  // Use refs to track previous values and avoid unnecessary calls
  const prevLogSearchTerm = useRef<string>("");
  const prevMetadataSearchTerms = useRef<{ category: string; value: string }[]>(
    [],
  );

  // Notify parent with search terms only when they actually change
  useEffect(() => {
    if (prevLogSearchTerm.current !== logSearchTerm) {
      prevLogSearchTerm.current = logSearchTerm;
      onLogSearchValueChange?.(logSearchTerm);
    }
  }, [logSearchTerm, onLogSearchValueChange]);

  useEffect(() => {
    // Compare metadata search terms by JSON string to detect changes
    const currentTermsStr = JSON.stringify(metadataSearchTerms);
    const prevTermsStr = JSON.stringify(prevMetadataSearchTerms.current);

    if (prevTermsStr !== currentTermsStr) {
      prevMetadataSearchTerms.current = metadataSearchTerms;
      onMetadataSearchTermsChange?.(metadataSearchTerms);
    }
  }, [metadataSearchTerms, onMetadataSearchTermsChange]);

  const handleAddCriterion = () => {
    let categoryValue = currentCriterion.category;
    let searchValue = inputValue.trim();

    if (currentCriterion.category === "metadata") {
      categoryValue = metadataCategoryValue.trim();
      searchValue = metadataValue.trim();
    } else if (currentCriterion.category === "log") {
      searchValue = logSearchValue.trim();
    }

    if (categoryValue && currentCriterion.operation && searchValue) {
      const newCriterion: SearchCriterion = {
        id: Date.now().toString(),
        category: categoryValue,
        operation: currentCriterion.operation,
        value: searchValue,
        logicalOperator: criteria.length > 0 ? "AND" : undefined,
      };

      const newCriteria = [...criteria, newCriterion];
      setCriteria(newCriteria);
      setCurrentCriterion({});
      setInputValue("");
      setMetadataCategoryValue("");
      setMetadataValue("");
      // Clear logSearchValue when adding a criterion
      setLogSearchValue("");
      onSearch(newCriteria);
    }
  };

  const handleRemoveCriterion = (id: string) => {
    const newCriteria = criteria.filter((c) => c.id !== id);
    setCriteria(newCriteria);
    // If no criteria left, default back to log category
    if (newCriteria.length === 0) {
      setCurrentCriterion({ category: "log", operation: "contains" });
    }
    onSearch(newCriteria);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleAddCriterion();
    }
  };

  const getCategoryLabel = (value: string) => {
    const category = CATEGORIES.find((cat) => cat.value === value);
    return category ? category.label : value;
  };

  const getOperationLabel = (value: string) => {
    return OPERATIONS.find((op) => op.value === value)?.label || value;
  };

  return (
    <div className="relative flex items-start gap-2 justify-start">
      <div
        className={`flex flex-col gap-2 px-2 py-1 border rounded-md transition-all duration-200 min-h-[2rem] max-h-[10rem] ${criteria.length === 0 ? "justify-center" : ""} w-auto max-w-md`}
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
                  {currentCriterion.category ? (
                    getCategoryLabel(currentCriterion.category)
                  ) : (
                    <TbCategory className="w-4 h-4" />
                  )}
                </span>
                <span className="hidden sm:inline md:hidden">
                  {currentCriterion.category ? (
                    getCategoryLabel(currentCriterion.category).substring(0, 8)
                  ) : (
                    <TbCategory className="w-4 h-4" />
                  )}
                </span>
                <span className="sm:hidden">
                  {currentCriterion.category ? (
                    getCategoryLabel(currentCriterion.category).substring(0, 3)
                  ) : (
                    <TbCategory className="w-4 h-4" />
                  )}
                </span>
                <ChevronDownIcon className="ml-1 size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-48">
              <DropdownMenuRadioGroup
                value={currentCriterion.category || ""}
                onValueChange={(value) => {
                  // Reset operation when changing category
                  const newOperation = value === "log" ? "contains" : "=";
                  setCurrentCriterion({
                    ...currentCriterion,
                    category: value,
                    operation: newOperation,
                  });
                  if (value !== "metadata") {
                    setMetadataCategoryValue("");
                    setMetadataValue("");
                  }
                  if (value !== "log") {
                    setLogSearchValue("");
                  }
                }}
              >
                {CATEGORIES.map((category) => {
                  // Check if this category is already selected
                  const isAlreadySelected = criteria.some((c) => {
                    // For metadata, check if any metadata criterion exists
                    if (category.value === "metadata") {
                      return (
                        c.category !== "log" &&
                        c.category !== "service_name" &&
                        c.category !== "service_environment"
                      );
                    }
                    // For all other categories (log, service_name, service_environment), check exact match
                    return c.category === category.value;
                  });

                  return (
                    <DropdownMenuRadioItem
                      key={category.value}
                      value={category.value}
                      className={`text-xs ${isAlreadySelected ? "opacity-50 cursor-not-allowed" : ""}`}
                      disabled={isAlreadySelected}
                    >
                      {category.label}
                    </DropdownMenuRadioItem>
                  );
                })}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Metadata category input (only show when metadata is selected) */}
          {currentCriterion.category === "metadata" && (
            <Input
              type="text"
              value={metadataCategoryValue}
              onChange={(e) => setMetadataCategoryValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="category"
              className="w-26 min-w-[80px] h-6.5"
              style={{ fontSize: "12px" }}
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
                  {currentCriterion.operation ? (
                    getOperationLabel(currentCriterion.operation)
                  ) : currentCriterion.category === "log" ? (
                    "contains"
                  ) : (
                    <LuSquareEqual className="w-4 h-4" />
                  )}
                </span>
                <span className="hidden sm:inline md:hidden">
                  {currentCriterion.operation ? (
                    getOperationLabel(currentCriterion.operation)
                  ) : currentCriterion.category === "log" ? (
                    "contains"
                  ) : (
                    <LuSquareEqual className="w-4 h-4" />
                  )}
                </span>
                <span className="sm:hidden">
                  {currentCriterion.operation ? (
                    getOperationLabel(currentCriterion.operation)
                  ) : currentCriterion.category === "log" ? (
                    "contains"
                  ) : (
                    <LuSquareEqual className="w-4 h-4" />
                  )}
                </span>
                <ChevronDownIcon className="ml-1 size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent className="w-32">
              <DropdownMenuRadioGroup
                value={
                  currentCriterion.operation ||
                  (currentCriterion.category === "log" ? "contains" : "")
                }
                onValueChange={(value) => {
                  setCurrentCriterion({
                    ...currentCriterion,
                    operation: value,
                  });
                }}
              >
                {OPERATIONS.filter((operation) => {
                  // For log category, only show 'contains' operation
                  if (currentCriterion.category === "log") {
                    return operation.value === "contains";
                  }
                  // For other categories, show '=' operation
                  return operation.value === "=";
                }).map((operation) => (
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

          {/* Metadata value input (only show when metadata is selected) */}
          {currentCriterion.category === "metadata" && (
            <Input
              type="text"
              value={metadataValue}
              onChange={(e) => setMetadataValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder="value"
              className="w-26 min-w-[80px] h-6.5"
              style={{ fontSize: "12px" }}
            />
          )}

          {/* Log search input (only show when log is selected) */}
          {currentCriterion.category === "log" && (
            <Input
              type="text"
              value={logSearchValue}
              onChange={(e) => setLogSearchValue(e.target.value)}
              onKeyPress={handleKeyPress}
              placeholder=""
              className="w-32 min-w-[120px] h-6.5"
              style={{ fontSize: "12px" }}
            />
          )}

          {/* Value input (hide when metadata or log category is selected) */}
          {currentCriterion.category !== "metadata" &&
            currentCriterion.category !== "log" && (
              <Input
                type="text"
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder=""
                className="w-28 min-w-[80px] h-6.5"
                style={{ fontSize: "12px" }}
              />
            )}

          {/* cross button */}
          <Button
            variant="outline"
            size="icon"
            onClick={() => {
              // Clear all completed criteria
              setCriteria([]);
              // Clear current criterion being built and reset to default
              setCurrentCriterion({ category: "log", operation: "contains" });
              // Clear input value
              setInputValue("");
              // Clear metadata category value
              setMetadataCategoryValue("");
              // Clear metadata value
              setMetadataValue("");
              // Clear log search value
              setLogSearchValue("");
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
