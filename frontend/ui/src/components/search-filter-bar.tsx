'use client'

import { useState } from 'react'
import { Search, ChevronDown, Calendar } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { DateRangePicker } from '@/components/ui/date-time-picker'
import { cn } from '@/lib/utils'
import { DATE_FILTER_OPTIONS, formatDateRange, type DateFilterOption } from '@/lib/date-filter'

interface SearchFilterBarProps {
  // Search
  searchValue: string
  onSearchChange: (value: string) => void
  searchPlaceholder?: string
  // Date filter
  dateFilter: DateFilterOption
  customStartDate: Date | null
  customEndDate: Date | null
  onDateFilterChange: (option: DateFilterOption) => void
  onCustomRangeChange: (startDate: Date, endDate: Date) => void
  // Optional additional content (e.g., filter badges)
  children?: React.ReactNode
}

export function SearchFilterBar({
  searchValue,
  onSearchChange,
  searchPlaceholder = 'Search...',
  dateFilter,
  customStartDate,
  customEndDate,
  onDateFilterChange,
  onCustomRangeChange,
  children,
}: SearchFilterBarProps) {
  const [dateFilterOpen, setDateFilterOpen] = useState(false)
  const [showCustomPicker, setShowCustomPicker] = useState(false)

  const getDateFilterLabel = () => {
    if (dateFilter.isCustom && customStartDate && customEndDate) {
      return formatDateRange(customStartDate, customEndDate)
    }
    return dateFilter.label
  }

  const handleCustomDateApply = (startDate: Date | null, endDate: Date | null) => {
    if (startDate && endDate) {
      const customOption = DATE_FILTER_OPTIONS.find(o => o.isCustom)!
      onDateFilterChange(customOption)
      onCustomRangeChange(startDate, endDate)
    }
    setDateFilterOpen(false)
    setShowCustomPicker(false)
  }

  return (
    <div className="border-b border-border bg-background px-3 py-1.5">
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder}
            value={searchValue}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-8 h-8 text-[13px]"
          />
        </div>
        {children}
        <div className="flex-1" />
        <Popover open={dateFilterOpen} onOpenChange={(open) => {
          setDateFilterOpen(open)
          if (!open) setShowCustomPicker(false)
        }}>
          <PopoverTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 min-w-[140px] justify-between text-[13px] font-normal gap-2">
              <span>{getDateFilterLabel()}</span>
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className={cn("p-0", showCustomPicker ? "w-auto" : "w-auto min-w-[130px]")}>
            {!showCustomPicker ? (
              <div className="py-1">
                {DATE_FILTER_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    className={cn(
                      'w-full px-2.5 py-1 text-left text-[13px] transition-colors flex items-center gap-1.5',
                      dateFilter.id === option.id && !option.isCustom
                        ? 'bg-muted/70'
                        : 'hover:bg-muted/50'
                    )}
                    onClick={() => {
                      if (option.isCustom) {
                        setShowCustomPicker(true)
                      } else {
                        onDateFilterChange(option)
                        setDateFilterOpen(false)
                      }
                    }}
                  >
                    {option.isCustom && <Calendar className="h-3 w-3 text-muted-foreground" />}
                    <span>{option.label}</span>
                  </button>
                ))}
              </div>
            ) : (
              <DateRangePicker
                startDate={customStartDate}
                endDate={customEndDate}
                onApply={handleCustomDateApply}
              />
            )}
          </PopoverContent>
        </Popover>
      </div>
    </div>
  )
}
