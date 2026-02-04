'use client'

import { useState, useCallback } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface DateRangePickerProps {
  startDate?: Date | null
  endDate?: Date | null
  onApply: (startDate: Date | null, endDate: Date | null) => void
  className?: string
}

interface TimeInputProps {
  label: string
  date: Date | null
  onChange: (date: Date | null) => void
}

function to12Hour(hour24: number): { hour: number; period: 'AM' | 'PM' } {
  if (hour24 === 0) return { hour: 12, period: 'AM' }
  if (hour24 === 12) return { hour: 12, period: 'PM' }
  if (hour24 > 12) return { hour: hour24 - 12, period: 'PM' }
  return { hour: hour24, period: 'AM' }
}

function to24Hour(hour12: number, period: 'AM' | 'PM'): number {
  if (period === 'AM') return hour12 === 12 ? 0 : hour12
  return hour12 === 12 ? 12 : hour12 + 12
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function getDaysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function TimeInput({ label, date, onChange }: TimeInputProps) {
  // Use UTC methods to extract time components
  const init12 = date ? to12Hour(date.getUTCHours()) : { hour: 12, period: 'AM' as const }

  const [year, setYear] = useState(() => date ? String(date.getUTCFullYear()) : '')
  const [month, setMonth] = useState(() => date ? String(date.getUTCMonth() + 1).padStart(2, '0') : '')
  const [day, setDay] = useState(() => date ? String(date.getUTCDate()).padStart(2, '0') : '')
  const [hour, setHour] = useState(() => date ? String(init12.hour).padStart(2, '0') : '')
  const [minute, setMinute] = useState(() => date ? String(date.getUTCMinutes()).padStart(2, '0') : '')
  const [period, setPeriod] = useState<'AM' | 'PM'>(() => init12.period)

  const updateDate = useCallback((y: string, m: string, d: string, h: string, min: string, p: 'AM' | 'PM') => {
    const yNum = parseInt(y), mNum = parseInt(m), dNum = parseInt(d)
    const hNum = parseInt(h), minNum = parseInt(min)

    if (y && m && d && !isNaN(yNum) && !isNaN(mNum) && !isNaN(dNum)) {
      const hour24 = !isNaN(hNum) ? to24Hour(clamp(hNum, 1, 12), p) : 0
      // Create UTC date using Date.UTC()
      const utcMs = Date.UTC(yNum, mNum - 1, dNum, hour24, isNaN(minNum) ? 0 : minNum, 0)
      const newDate = new Date(utcMs)
      if (!isNaN(newDate.getTime())) {
        onChange(newDate)
        return
      }
    }
    onChange(null)
  }, [onChange])

  const handleNum = (setter: (v: string) => void, value: string, max: number) => {
    setter(value.replace(/\D/g, '').slice(0, max))
  }

  // Auto-correct handlers
  const correctYear = () => {
    if (!year) return
    const y = parseInt(year)
    if (isNaN(y)) return
    const corrected = clamp(y, 1900, 2100)
    const str = String(corrected)
    setYear(str)
    updateDate(str, month, day, hour, minute, period)
  }

  const correctMonth = () => {
    if (!month) return
    const m = parseInt(month)
    if (isNaN(m)) return
    const corrected = clamp(m, 1, 12)
    const str = String(corrected).padStart(2, '0')
    setMonth(str)
    updateDate(year, str, day, hour, minute, period)
  }

  const correctDay = () => {
    if (!day) return
    const d = parseInt(day)
    if (isNaN(d)) return
    const y = parseInt(year) || new Date().getUTCFullYear()
    const m = parseInt(month) || 1
    const maxDay = getDaysInMonth(y, m)
    const corrected = clamp(d, 1, maxDay)
    const str = String(corrected).padStart(2, '0')
    setDay(str)
    updateDate(year, month, str, hour, minute, period)
  }

  const correctHour = () => {
    if (!hour) return
    const h = parseInt(hour)
    if (isNaN(h)) return
    let corrected = h
    if (h === 0) corrected = 12
    else if (h > 12) corrected = 12
    const str = String(corrected).padStart(2, '0')
    setHour(str)
    updateDate(year, month, day, str, minute, period)
  }

  const correctMinute = () => {
    if (!minute) return
    const m = parseInt(minute)
    if (isNaN(m)) return
    const corrected = clamp(m, 0, 59)
    const str = String(corrected).padStart(2, '0')
    setMinute(str)
    updateDate(year, month, day, hour, str, period)
  }

  const inputBase = 'h-7 text-center text-[13px] border border-border rounded bg-background focus:outline-none focus:ring-1 focus:ring-ring'

  return (
    <div className="mb-3">
      <label className="block text-[13px] text-muted-foreground mb-1.5">{label}</label>
      <div className="flex items-center gap-1">
        <input
          type="text"
          value={year}
          onChange={(e) => { handleNum(setYear, e.target.value, 4); updateDate(e.target.value, month, day, hour, minute, period) }}
          onBlur={correctYear}
          placeholder="yyyy"
          className={cn(inputBase, 'w-[46px]', !year && 'text-muted-foreground')}
        />
        <span className="text-[13px] text-muted-foreground">/</span>
        <input
          type="text"
          value={month}
          onChange={(e) => { handleNum(setMonth, e.target.value, 2); updateDate(year, e.target.value, day, hour, minute, period) }}
          onBlur={correctMonth}
          placeholder="mm"
          className={cn(inputBase, 'w-[32px]', !month && 'text-muted-foreground')}
        />
        <span className="text-[13px] text-muted-foreground">/</span>
        <input
          type="text"
          value={day}
          onChange={(e) => { handleNum(setDay, e.target.value, 2); updateDate(year, month, e.target.value, hour, minute, period) }}
          onBlur={correctDay}
          placeholder="dd"
          className={cn(inputBase, 'w-[32px]', !day && 'text-muted-foreground')}
        />
        <span className="text-[13px] text-muted-foreground mx-1">,</span>
        <input
          type="text"
          value={hour}
          onChange={(e) => { handleNum(setHour, e.target.value, 2); updateDate(year, month, day, e.target.value, minute, period) }}
          onBlur={correctHour}
          placeholder="12"
          className={cn(inputBase, 'w-[32px]', !hour && 'text-muted-foreground')}
        />
        <span className="text-[13px] text-muted-foreground">:</span>
        <input
          type="text"
          value={minute}
          onChange={(e) => { handleNum(setMinute, e.target.value, 2); updateDate(year, month, day, hour, e.target.value, period) }}
          onBlur={correctMinute}
          placeholder="00"
          className={cn(inputBase, 'w-[32px]', !minute && 'text-muted-foreground')}
        />
        <button
          type="button"
          onClick={() => {
            const newP = period === 'AM' ? 'PM' : 'AM'
            setPeriod(newP)
            updateDate(year, month, day, hour, minute, newP)
          }}
          className="h-7 px-2 text-[13px] border border-border rounded bg-background hover:bg-muted flex items-center gap-0.5 ml-1"
        >
          {period}<ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
        <span className="text-[13px] text-muted-foreground ml-1.5">UTC</span>
      </div>
    </div>
  )
}

function getDefaultStart(): Date {
  // Create UTC date for 1 day ago at midnight UTC
  const now = new Date()
  return new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - 1,
    0, 0, 0
  ))
}

function getDefaultEnd(): Date {
  // Current time in UTC (Date objects are always UTC internally)
  return new Date()
}

export function DateRangePicker({ startDate, endDate, onApply, className }: DateRangePickerProps) {
  const [start, setStart] = useState<Date | null>(() => startDate || getDefaultStart())
  const [end, setEnd] = useState<Date | null>(() => endDate || getDefaultEnd())

  const handleApply = useCallback(() => {
    onApply(start, end)
  }, [start, end, onApply])

  return (
    <div className={cn('p-3', className)}>
      <TimeInput label="Start time" date={start} onChange={setStart} />
      <TimeInput label="End time" date={end} onChange={setEnd} />
      <div className="flex justify-center mt-3">
        <Button size="sm" className="h-8 px-6 text-[13px]" onClick={handleApply}>
          Apply
        </Button>
      </div>
    </div>
  )
}

export { DateRangePicker as DateTimePicker }
