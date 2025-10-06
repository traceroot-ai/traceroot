"use client";

import React, { useState, useEffect, useMemo, useRef } from "react";
import { IoMdClose } from "react-icons/io";
import { TbCategory } from "react-icons/tb";
import { LuSquareEqual } from "react-icons/lu";
import { ChevronDownIcon } from "lucide-react";
import { FaAws } from "react-icons/fa";
import { BsTencentQq } from "react-icons/bs";
import { SiJaeger } from "react-icons/si";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd } from "@/components/ui/shadcn-io/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useCloudProvider } from "@/hooks/useCloudProvider";
import { loadProviderSelection } from "@/utils/provider";

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
  disabled?: boolean;
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
  disabled = false,
}) => {
  const { selectedProvider } = useCloudProvider();
  const [traceProvider, setTraceProvider] = useState<string>("aws");
  const [logProvider, setLogProvider] = useState<string>("aws");
  const [criteria, setCriteria] = useState<SearchCriterion[]>([]);
  const [isExpanded, setIsExpanded] = useState(false);
  const [currentCriterion, setCurrentCriterion] = useState<
    Partial<SearchCriterion>
  >({ category: "log", operation: "contains" });
  const [inputValue, setInputValue] = useState("");
  const [metadataCategoryValue, setMetadataCategoryValue] = useState("");
  const [metadataValue, setMetadataValue] = useState("");
  const [logSearchValue, setLogSearchValue] = useState("");

  // Load trace and log providers from localStorage
  useEffect(() => {
    const loadProviders = () => {
      const trace = loadProviderSelection("trace") || "aws";
      const log = loadProviderSelection("log") || "aws";
      setTraceProvider(trace);
      setLogProvider(log);
    };

    loadProviders();

    // Listen for storage changes to update when providers are changed in settings
    const handleStorageChange = () => {
      loadProviders();
    };

    window.addEventListener("storage", handleStorageChange);
    window.addEventListener("userDataUpdated", handleStorageChange);

    return () => {
      window.removeEventListener("storage", handleStorageChange);
      window.removeEventListener("userDataUpdated", handleStorageChange);
    };
  }, []);

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
    if (disabled) return;

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
    if (disabled) return;

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

  const getProviderIconComponent = (provider: string, size: number = 20) => {
    switch (provider) {
      case "aws":
        return <FaAws size={size} className="text-foreground" />;
      case "tencent":
        return <BsTencentQq size={size} className="text-foreground" />;
      case "jaeger":
        return <SiJaeger size={size} className="text-foreground" />;
      default:
        return <FaAws size={size} className="text-foreground" />;
    }
  };

  const getProviderIcon = () => {
    // If both providers are the same, show single icon
    if (traceProvider === logProvider) {
      return getProviderIconComponent(traceProvider, 20);
    }

    // If different, show split diagonal design
    return (
      <div className="relative w-full h-full flex items-center justify-center overflow-hidden">
        {/* Top-left triangle - Trace Provider */}
        <div
          className="absolute inset-0 flex items-start justify-start pl-1 pt-1"
          style={{ clipPath: "polygon(0 0, 100% 0, 0 100%)" }}
        >
          {getProviderIconComponent(traceProvider, 14)}
        </div>
        {/* Bottom-right triangle - Log Provider */}
        <div
          className="absolute inset-0 flex items-end justify-end pr-1 pb-1"
          style={{ clipPath: "polygon(100% 0, 100% 100%, 0 100%)" }}
        >
          {getProviderIconComponent(logProvider, 14)}
        </div>
        {/* Diagonal line separator - from bottom-left to top-right */}
        <svg
          className="absolute inset-0 pointer-events-none"
          width="100%"
          height="100%"
          viewBox="0 0 40 40"
        >
          <line
            x1="2"
            y1="38"
            x2="38"
            y2="2"
            stroke="currentColor"
            strokeWidth="1"
            className="text-border"
          />
        </svg>
      </div>
    );
  };

  const getProviderName = (provider: string) => {
    switch (provider) {
      case "aws":
        return "AWS";
      case "tencent":
        return "Tencent Cloud";
      case "jaeger":
        return "Jaeger";
      default:
        return provider.toUpperCase();
    }
  };

  const getProviderTooltip = () => {
    if (traceProvider === logProvider) {
      return `Trace and Log from ${getProviderName(traceProvider)}`;
    }
    return `Trace from ${getProviderName(traceProvider)} and Log from ${getProviderName(logProvider)}`;
  };

  return (
    <div className="relative flex items-start gap-2 justify-start">
      {/* Provider Icon */}
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="h-[2.5rem] w-[2.5rem] border border-input rounded-md bg-background flex items-center justify-center shrink-0">
            {getProviderIcon()}
          </div>
        </TooltipTrigger>
        <TooltipContent>{getProviderTooltip()}</TooltipContent>
      </Tooltip>

      <div
        className={`flex flex-col gap-2 px-2 py-1 border rounded-md transition-all duration-200 min-h-[2rem] max-h-[10rem] ${criteria.length === 0 ? "justify-center" : ""} w-auto max-w-md ${disabled ? "opacity-50 pointer-events-none" : ""}`}
        onClick={() => !disabled && setIsExpanded(true)}
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
                <div className="flex items-center space-x-1 bg-gray-100 dark:bg-gray-700 rounded-md px-2 py-1">
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
                    className="ml-0.5 h-4 w-4 p-0 opacity-70 transition-opacity hover:opacity-100 flex-shrink-0"
                    disabled={disabled}
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
            <Tooltip>
              <TooltipTrigger asChild>
                <Input
                  type="text"
                  value={metadataValue}
                  onChange={(e) => setMetadataValue(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder="value"
                  className="w-26 min-w-[80px] h-6.5"
                  style={{ fontSize: "12px" }}
                />
              </TooltipTrigger>
              <TooltipContent>
                <div className="flex items-center gap-1">
                  <span>Press</span>
                  <Kbd>Enter</Kbd>
                  <span>to add</span>
                </div>
              </TooltipContent>
            </Tooltip>
          )}

          {/* Log search input (only show when log is selected) */}
          {currentCriterion.category === "log" && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Input
                  type="text"
                  value={logSearchValue}
                  onChange={(e) => setLogSearchValue(e.target.value)}
                  onKeyPress={handleKeyPress}
                  placeholder=""
                  className="w-32 min-w-[120px] h-6.5"
                  style={{ fontSize: "12px" }}
                />
              </TooltipTrigger>
              <TooltipContent>
                <div className="flex items-center gap-1">
                  <span>Press</span>
                  <Kbd>Enter</Kbd>
                  <span>to add</span>
                </div>
              </TooltipContent>
            </Tooltip>
          )}

          {/* Value input (hide when metadata or log category is selected) */}
          {currentCriterion.category !== "metadata" &&
            currentCriterion.category !== "log" && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Input
                    type="text"
                    value={inputValue}
                    onChange={(e) => setInputValue(e.target.value)}
                    onKeyPress={handleKeyPress}
                    placeholder=""
                    className="w-28 min-w-[80px] h-6.5"
                    style={{ fontSize: "12px" }}
                  />
                </TooltipTrigger>
                <TooltipContent>
                  <div className="flex items-center gap-1">
                    <span>Press</span>
                    <Kbd>Enter</Kbd>
                    <span>to add</span>
                  </div>
                </TooltipContent>
              </Tooltip>
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
