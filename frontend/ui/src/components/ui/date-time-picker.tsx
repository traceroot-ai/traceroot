"use client";

import { useState, useCallback } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface DateRangePickerProps {
  startDate?: Date | null;
  endDate?: Date | null;
  onApply: (startDate: Date | null, endDate: Date | null) => void;
  className?: string;
  // Earliest selectable instant (the plan's retention cutoff). When set, an
  // applied range is clamped into [minDate, now] so the custom picker can't
  // reach past retention — matching the locked presets and the server clamp.
  minDate?: Date | null;
}

interface TimeInputProps {
  label: string;
  date: Date | null;
  onChange: (date: Date | null) => void;
}

function to12Hour(hour24: number): { hour: number; period: "AM" | "PM" } {
  if (hour24 === 0) return { hour: 12, period: "AM" };
  if (hour24 === 12) return { hour: 12, period: "PM" };
  if (hour24 > 12) return { hour: hour24 - 12, period: "PM" };
  return { hour: hour24, period: "AM" };
}

function to24Hour(hour12: number, period: "AM" | "PM"): number {
  if (period === "AM") return hour12 === 12 ? 0 : hour12;
  return hour12 === 12 ? 12 : hour12 + 12;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function getDaysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function createValidUTCDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date | null {
  const date = new Date(Date.UTC(0, 0, 1, hour, minute, 0));
  date.setUTCFullYear(year);
  date.setUTCMonth(month - 1);
  date.setUTCDate(day);
  if (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  ) {
    return date;
  }
  return null;
}

function clampDayToMonth(year: string, month: string, day: string): string {
  const yNum = parseInt(year),
    mNum = parseInt(month),
    dNum = parseInt(day);
  if (
    year.length !== 4 ||
    !month ||
    !day ||
    isNaN(yNum) ||
    isNaN(mNum) ||
    isNaN(dNum) ||
    mNum < 1 ||
    mNum > 12
  ) {
    return day;
  }
  const maxDay = getDaysInMonth(yNum, mNum);
  return dNum > maxDay ? String(maxDay).padStart(2, "0") : day;
}

function TimeInput({ label, date, onChange }: TimeInputProps) {
  // Use UTC methods to extract time components
  const init12 = date ? to12Hour(date.getUTCHours()) : { hour: 12, period: "AM" as const };

  const [year, setYear] = useState(() => (date ? String(date.getUTCFullYear()) : ""));
  const [month, setMonth] = useState(() =>
    date ? String(date.getUTCMonth() + 1).padStart(2, "0") : "",
  );
  const [day, setDay] = useState(() => (date ? String(date.getUTCDate()).padStart(2, "0") : ""));
  const [hour, setHour] = useState(() => (date ? String(init12.hour).padStart(2, "0") : ""));
  const [minute, setMinute] = useState(() =>
    date ? String(date.getUTCMinutes()).padStart(2, "0") : "",
  );
  const [period, setPeriod] = useState<"AM" | "PM">(() => init12.period);
  const [invalidDate, setInvalidDate] = useState(false);

  const updateDate = useCallback(
    (y: string, m: string, d: string, h: string, min: string, p: "AM" | "PM") => {
      const yNum = parseInt(y),
        mNum = parseInt(m),
        dNum = parseInt(d);
      const hNum = parseInt(h),
        minNum = parseInt(min);

      if (y.length === 4 && m && d && h && min && !isNaN(yNum) && !isNaN(mNum) && !isNaN(dNum)) {
        const hour24 = to24Hour(clamp(hNum, 1, 12), p);
        const newDate = createValidUTCDate(yNum, mNum, dNum, hour24, clamp(minNum, 0, 59));
        if (newDate) {
          setInvalidDate(false);
          onChange(newDate);
          return;
        }
        setInvalidDate(true);
      } else {
        setInvalidDate(false);
      }
      onChange(null);
    },
    [onChange],
  );

  const numericValue = (value: string, max: number) => value.replace(/\D/g, "").slice(0, max);

  const handleNum = (setter: (v: string) => void, value: string, max: number) => {
    const cleaned = numericValue(value, max);
    setter(cleaned);
    return cleaned;
  };

  // Auto-correct handlers
  const correctYear = () => {
    if (!year) return;
    const y = parseInt(year);
    if (isNaN(y)) return;
    const corrected = clamp(y, 1900, 2100);
    const str = String(corrected);
    const clampedDay = clampDayToMonth(str, month, day);
    setYear(str);
    if (clampedDay !== day) setDay(clampedDay);
    updateDate(str, month, clampedDay, hour, minute, period);
  };

  const correctMonth = () => {
    if (!month) return;
    const m = parseInt(month);
    if (isNaN(m)) return;
    const str = String(m).padStart(2, "0");
    const clampedDay = clampDayToMonth(year, str, day);
    setMonth(str);
    if (clampedDay !== day) setDay(clampedDay);
    updateDate(year, str, clampedDay, hour, minute, period);
  };

  const correctDay = () => {
    if (!day) return;
    const d = parseInt(day);
    if (isNaN(d)) return;
    const str = String(d).padStart(2, "0");
    setDay(str);
    updateDate(year, month, str, hour, minute, period);
  };

  const correctHour = () => {
    if (!hour) return;
    const h = parseInt(hour);
    if (isNaN(h)) return;
    let corrected = h;
    if (h === 0) corrected = 12;
    else if (h > 12) corrected = 12;
    const str = String(corrected).padStart(2, "0");
    setHour(str);
    updateDate(year, month, day, str, minute, period);
  };

  const correctMinute = () => {
    if (!minute) return;
    const m = parseInt(minute);
    if (isNaN(m)) return;
    const corrected = clamp(m, 0, 59);
    const str = String(corrected).padStart(2, "0");
    setMinute(str);
    updateDate(year, month, day, hour, str, period);
  };

  const inputBase =
    "h-8 text-center text-[13px] border border-border rounded-[2px] bg-background focus:outline-none focus:ring-1 focus:ring-ring";

  return (
    <div className="mb-4">
      <label className="mb-1.5 block text-[12px] font-medium text-muted-foreground">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={year}
          onChange={(e) => {
            const nextYear = handleNum(setYear, e.target.value, 4);
            const clampedDay = clampDayToMonth(nextYear, month, day);
            if (clampedDay !== day) setDay(clampedDay);
            updateDate(nextYear, month, clampedDay, hour, minute, period);
          }}
          onBlur={correctYear}
          placeholder="yyyy"
          className={cn(inputBase, "w-[46px]", !year && "text-muted-foreground")}
        />
        <span className="text-[13px] text-muted-foreground">/</span>
        <input
          type="text"
          value={month}
          onChange={(e) => {
            const nextMonth = handleNum(setMonth, e.target.value, 2);
            const clampedDay = clampDayToMonth(year, nextMonth, day);
            if (clampedDay !== day) setDay(clampedDay);
            updateDate(year, nextMonth, clampedDay, hour, minute, period);
          }}
          onBlur={correctMonth}
          placeholder="mm"
          className={cn(inputBase, "w-[32px]", !month && "text-muted-foreground")}
        />
        <span className="text-[13px] text-muted-foreground">/</span>
        <input
          type="text"
          value={day}
          onChange={(e) => {
            const nextDay = handleNum(setDay, e.target.value, 2);
            updateDate(year, month, nextDay, hour, minute, period);
          }}
          onBlur={correctDay}
          placeholder="dd"
          className={cn(inputBase, "w-[32px]", !day && "text-muted-foreground")}
        />
        <span className="mx-1 text-[13px] text-muted-foreground">,</span>
        <input
          type="text"
          value={hour}
          onChange={(e) => {
            const nextHour = handleNum(setHour, e.target.value, 2);
            updateDate(year, month, day, nextHour, minute, period);
          }}
          onBlur={correctHour}
          placeholder="12"
          className={cn(inputBase, "w-[32px]", !hour && "text-muted-foreground")}
        />
        <span className="text-[13px] text-muted-foreground">:</span>
        <input
          type="text"
          value={minute}
          onChange={(e) => {
            const nextMinute = handleNum(setMinute, e.target.value, 2);
            updateDate(year, month, day, hour, nextMinute, period);
          }}
          onBlur={correctMinute}
          placeholder="00"
          className={cn(inputBase, "w-[32px]", !minute && "text-muted-foreground")}
        />
        <button
          type="button"
          onClick={() => {
            const newP = period === "AM" ? "PM" : "AM";
            setPeriod(newP);
            updateDate(year, month, day, hour, minute, newP);
          }}
          className="ml-1 flex h-8 items-center gap-0.5 rounded-[2px] border border-border bg-background px-2 text-[13px] hover:bg-muted"
        >
          {period}
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
        <span className="ml-1.5 text-[13px] text-muted-foreground">UTC</span>
      </div>
      {invalidDate && (
        <p role="alert" className="mt-1 text-[12px] text-destructive">
          Enter a valid date.
        </p>
      )}
    </div>
  );
}

function getDefaultStart(): Date {
  // Create UTC date for 1 day ago at midnight UTC
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1, 0, 0, 0));
}

function getDefaultEnd(): Date {
  // Current time in UTC (Date objects are always UTC internally)
  return new Date();
}

export function DateRangePicker({
  startDate,
  endDate,
  onApply,
  className,
  minDate,
}: DateRangePickerProps) {
  const [start, setStart] = useState<Date | null>(() => startDate || getDefaultStart());
  const [end, setEnd] = useState<Date | null>(() => endDate || getDefaultEnd());
  const rangeError =
    start && end && start.getTime() >= end.getTime() ? "Start date must be before end date." : null;
  const canApply = Boolean(start && end && !rangeError);

  const handleApply = useCallback(() => {
    if (!start || !end || start.getTime() >= end.getTime()) return;
    let s = start;
    let e = end;
    // Clamp into the retention window so the applied (and displayed) range never
    // claims data the server will silently drop. A start before the cutoff snaps
    // to it; a range that ends before the cutoff (fully out of window) collapses
    // to [cutoff, now] rather than an inverted range.
    if (minDate) {
      const floor = minDate.getTime();
      if (s && s.getTime() < floor) s = minDate;
      if (e && e.getTime() < floor) e = getDefaultEnd();
    }
    onApply(s, e);
  }, [start, end, minDate, onApply]);

  return (
    <div className={cn("p-4", className)}>
      <TimeInput label="Start time" date={start} onChange={setStart} />
      <TimeInput label="End time" date={end} onChange={setEnd} />
      <div className="-mx-4 -mb-4 mt-4 flex items-center justify-end gap-3 border-t border-border px-4 py-3">
        {rangeError && (
          <p role="alert" className="mr-auto text-[12px] text-destructive">
            {rangeError}
          </p>
        )}
        <Button onClick={handleApply} disabled={!canApply}>
          Apply
        </Button>
      </div>
    </div>
  );
}

export { DateRangePicker as DateTimePicker };
