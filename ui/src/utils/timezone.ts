/**
 * Simple timezone utilities - assumes backend always sends UTC timestamps
 */

// Get user's timezone offset in minutes (positive means behind UTC, negative means ahead)
export const getTimezoneOffsetMinutes = (): number => {
  return new Date().getTimezoneOffset();
};

// Get user's timezone offset in milliseconds
export const getTimezoneOffsetMs = (): number => {
  return getTimezoneOffsetMinutes() * 60 * 1000;
};

// Convert UTC timestamp to local timestamp by adjusting for timezone offset
export const convertUTCToLocal = (utcTimestamp: number | string | Date): Date => {
  let utcMs: number;

  if (utcTimestamp instanceof Date) {
    // If it's a Date, get the UTC milliseconds
    utcMs = utcTimestamp.getTime();
  } else if (typeof utcTimestamp === 'string') {
    // Parse string timestamp
    const parsed = new Date(utcTimestamp);
    utcMs = parsed.getTime();
  } else {
    // Handle numeric timestamp - assume milliseconds, convert if seconds
    utcMs = utcTimestamp < 1e12 ? utcTimestamp * 1000 : utcTimestamp;
  }

  // JavaScript's getTimezoneOffset() returns positive for timezones behind UTC
  // So we SUBTRACT the offset to get local time
  const offsetMs = getTimezoneOffsetMs();
  const localMs = utcMs - offsetMs;

  return new Date(localMs);
};

// Format a UTC timestamp as local time string
export const formatUTCAsLocal = (utcTimestamp: number | string | Date): string => {
  try {
    const localDate = convertUTCToLocal(utcTimestamp);

    const month = localDate.getMonth() + 1;
    const day = localDate.getDate();
    const year = localDate.getFullYear();
    const hours = localDate.getHours();
    const minutes = localDate.getMinutes();
    const seconds = localDate.getSeconds();
    const milliseconds = localDate.getMilliseconds();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;

    const result = `${month}/${day}/${year}, ${displayHours}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}.${milliseconds.toString().padStart(3, '0')} ${ampm}`;

    return result;
  } catch (error) {
    console.error('Error formatting UTC as local:', error);
    return 'Invalid date';
  }
};

// Get timezone info for debugging
export const getTimezoneInfo = () => {
  const now = new Date();
  return {
    timezoneName: Intl.DateTimeFormat().resolvedOptions().timeZone,
    offsetMinutes: now.getTimezoneOffset(),
    offsetHours: now.getTimezoneOffset() / 60,
    isDST: now.getTimezoneOffset() < (new Date(now.getFullYear(), 0, 1)).getTimezoneOffset()
  };
};
