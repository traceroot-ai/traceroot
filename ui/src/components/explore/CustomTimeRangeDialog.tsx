"use client";

import React, { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CalendarIcon, Globe } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

export type CustomTimeRange =
  | {
      type: "relative";
      minutes: number;
      label: string;
    }
  | {
      type: "absolute";
      startDate: Date;
      endDate: Date;
      label: string;
    };

export type TimezoneMode = "local" | "utc";

interface CustomTimeRangeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onApply: (timeRange: CustomTimeRange, timezone: TimezoneMode) => void;
  currentTimezone: TimezoneMode;
}

const QUICK_RELATIVE_OPTIONS = [
  { label: "5m", minutes: 5 },
  { label: "15m", minutes: 15 },
  { label: "30m", minutes: 30 },
  { label: "1h", minutes: 60 },
  { label: "3h", minutes: 3 * 60 },
  { label: "6h", minutes: 6 * 60 },
];

export const CustomTimeRangeDialog: React.FC<CustomTimeRangeDialogProps> = ({
  open,
  onOpenChange,
  onApply,
  currentTimezone,
}) => {
  const [mode, setMode] = useState<"absolute" | "relative">("absolute");
  const [timezone, setTimezone] = useState<TimezoneMode>(currentTimezone);

  // Absolute mode state
  const [startDate, setStartDate] = useState<Date | undefined>(
    new Date(Date.now() - 3 * 60 * 60 * 1000),
  );
  const [endDate, setEndDate] = useState<Date | undefined>(new Date());
  const [startTime, setStartTime] = useState<string>("00:00");
  const [endTime, setEndTime] = useState<string>("06:00");

  // Relative mode state
  const [relativeMinutes, setRelativeMinutes] = useState<number>(5);
  const [customDuration, setCustomDuration] = useState<string>("5");
  const [durationUnit, setDurationUnit] = useState<"minutes" | "hours">(
    "minutes",
  );

  const handleApply = () => {
    if (mode === "absolute") {
      if (!startDate || !endDate) return;

      // Combine date and time
      const [startHour, startMinute] = startTime.split(":").map(Number);
      const [endHour, endMinute] = endTime.split(":").map(Number);

      const finalStartDate = new Date(startDate);
      finalStartDate.setHours(startHour, startMinute, 0, 0);

      const finalEndDate = new Date(endDate);
      finalEndDate.setHours(endHour, endMinute, 0, 0);

      onApply(
        {
          type: "absolute",
          startDate: finalStartDate,
          endDate: finalEndDate,
          label: `${format(finalStartDate, "MMM d, HH:mm")} - ${format(finalEndDate, "MMM d, HH:mm")}`,
        },
        timezone,
      );
    } else {
      const minutes =
        durationUnit === "hours"
          ? parseInt(customDuration) * 60
          : parseInt(customDuration);

      onApply(
        {
          type: "relative",
          minutes,
          label: `Last ${customDuration}${durationUnit === "hours" ? "h" : "m"}`,
        },
        timezone,
      );
    }
    onOpenChange(false);
  };

  const handleQuickRelativeSelect = (minutes: number, label: string) => {
    setRelativeMinutes(minutes);
    const isHours = minutes >= 60;
    setDurationUnit(isHours ? "hours" : "minutes");
    setCustomDuration(isHours ? (minutes / 60).toString() : minutes.toString());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" showCloseButton={false}>
        <button
          onClick={() => onOpenChange(false)}
          className="absolute right-4 top-3 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="24"
            height="24"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-4 w-4"
          >
            <line x1="18" y1="6" x2="6" y2="18"></line>
            <line x1="6" y1="6" x2="18" y2="18"></line>
          </svg>
          <span className="sr-only">Close</span>
        </button>

        <DialogHeader>
          <DialogTitle>Custom Time Range</DialogTitle>
        </DialogHeader>

        {mode === "absolute" && (
          <div className="flex justify-end -mt-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setTimezone(timezone === "local" ? "utc" : "local")
                  }
                >
                  <Globe className="mr-2 size-4" />
                  {timezone === "local" ? "Local timezone" : "UTC"}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {timezone === "utc"
                  ? "Switch to local timezone"
                  : "Switch to UTC"}
              </TooltipContent>
            </Tooltip>
          </div>
        )}

        <Tabs value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
          <TabsList className="grid w-full grid-cols-2 bg-muted/50 rounded-lg p-1">
            <TabsTrigger
              value="absolute"
              className="data-[state=active]:bg-background data-[state=active]:border data-[state=active]:border-primary hover:bg-background/50 transition-colors"
            >
              Absolute
            </TabsTrigger>
            <TabsTrigger
              value="relative"
              className="data-[state=active]:bg-background data-[state=active]:border data-[state=active]:border-primary hover:bg-background/50 transition-colors"
            >
              Relative
            </TabsTrigger>
          </TabsList>

          <TabsContent value="absolute" className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              {/* Start Date/Time */}
              <div className="space-y-2">
                <Label>Start date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !startDate && "text-muted-foreground",
                      )}
                    >
                      <CalendarIcon className="mr-2 size-4" />
                      {startDate ? (
                        format(startDate, "yyyy/MM/dd")
                      ) : (
                        <span>Pick a date</span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={startDate}
                      onSelect={setStartDate}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                <div>
                  <Label>Start time</Label>
                  <Input
                    type="time"
                    value={startTime}
                    onChange={(e) => setStartTime(e.target.value)}
                    className="mt-1"
                  />
                </div>
              </div>

              {/* End Date/Time */}
              <div className="space-y-2">
                <Label>End date</Label>
                <Popover>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal",
                        !endDate && "text-muted-foreground",
                      )}
                    >
                      <CalendarIcon className="mr-2 size-4" />
                      {endDate ? (
                        format(endDate, "yyyy/MM/dd")
                      ) : (
                        <span>Pick a date</span>
                      )}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={endDate}
                      onSelect={setEndDate}
                      initialFocus
                    />
                  </PopoverContent>
                </Popover>
                <div>
                  <Label>End time</Label>
                  <Input
                    type="time"
                    value={endTime}
                    onChange={(e) => setEndTime(e.target.value)}
                    className="mt-1"
                  />
                </div>
              </div>
            </div>
          </TabsContent>

          <TabsContent value="relative" className="space-y-4">
            {/* Quick selection buttons */}
            <div className="space-y-2">
              <Label>Minutes</Label>
              <div className="grid grid-cols-6 gap-2">
                {QUICK_RELATIVE_OPTIONS.filter((opt) => opt.minutes < 60).map(
                  (option) => (
                    <Button
                      key={option.label}
                      variant={
                        relativeMinutes === option.minutes &&
                        durationUnit === "minutes"
                          ? "default"
                          : "outline"
                      }
                      onClick={() =>
                        handleQuickRelativeSelect(option.minutes, option.label)
                      }
                      className="text-sm"
                    >
                      {option.label.replace("m", "")}
                    </Button>
                  ),
                )}
              </div>
            </div>

            <div className="space-y-2">
              <Label>Hours</Label>
              <div className="grid grid-cols-6 gap-2">
                {QUICK_RELATIVE_OPTIONS.filter((opt) => opt.minutes >= 60).map(
                  (option) => (
                    <Button
                      key={option.label}
                      variant={
                        relativeMinutes === option.minutes &&
                        durationUnit === "hours"
                          ? "default"
                          : "outline"
                      }
                      onClick={() =>
                        handleQuickRelativeSelect(option.minutes, option.label)
                      }
                      className="text-sm"
                    >
                      {option.label.replace("h", "")}
                    </Button>
                  ),
                )}
              </div>
            </div>

            {/* Custom duration input */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Duration</Label>
                <Input
                  type="number"
                  min="1"
                  max="9999"
                  value={customDuration}
                  onChange={(e) => setCustomDuration(e.target.value)}
                  placeholder="5"
                />
                <p className="text-xs text-muted-foreground">Up to 4 digits.</p>
              </div>
              <div className="space-y-2">
                <Label>Unit of time</Label>
                <Select
                  value={durationUnit}
                  onValueChange={(v) =>
                    setDurationUnit(v as "minutes" | "hours")
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="minutes">Minutes</SelectItem>
                    <SelectItem value="hours">Hours</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleApply}>Apply</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
