"use client";

import React from "react";
import { LogEntry } from "@/models/log";

interface CodeContextProps {
  entry: LogEntry;
  showCode: boolean;
}

export default function CodeContext({ entry, showCode }: CodeContextProps) {
  // Only render if showCode is true and there's code context available
  if (!showCode || (!entry.line && !entry.lines_above && !entry.lines_below)) {
    return null;
  }

  // Find first non-empty line in lines_above
  let first_non_empty_line = -1;
  if (entry.lines_above) {
    for (let i = 0; i < entry.lines_above.length; i++) {
      const line = entry.lines_above[i];
      // Check if line is not empty, not newline, and not all whitespace/tabs
      if (line !== "" && line !== "\n" && line.trim() !== "") {
        first_non_empty_line = i;
        break;
      }
    }
  }

  // Find last non-empty line in lines_below
  let last_non_empty_line = -1;
  if (entry.lines_below) {
    for (let i = entry.lines_below.length - 1; i >= 0; i--) {
      const line = entry.lines_below[i];
      // Check if line is not empty, not newline, and not all whitespace/tabs
      if (line !== "" && line !== "\n" && line.trim() !== "") {
        last_non_empty_line = i;
        break;
      }
    }
  }

  return (
    <div className="mt-3 p-3 bg-white dark:bg-gray-900 rounded">
      <div className="font-mono text-xs space-y-1">
        {/* Lines above */}
        {entry.lines_above &&
          first_non_empty_line !== -1 &&
          entry.lines_above.slice(first_non_empty_line).map((line, idx) => (
            <div
              key={`above-${idx}`}
              className="text-gray-500 dark:text-gray-500"
            >
              <span className="text-gray-400 dark:text-gray-600 mr-2">
                {entry.line_number -
                  entry.lines_above!.length +
                  first_non_empty_line +
                  idx}
                :
              </span>
              <span className="whitespace-pre">{line}</span>
            </div>
          ))}
        {/* Current line */}
        {entry.line && (
          <div className="text-gray-900 dark:text-gray-100 bg-yellow-100 dark:bg-yellow-900/30 rounded py-0.5">
            <span className="text-gray-600 dark:text-gray-400 mr-2 font-bold">
              {entry.line_number}:
            </span>
            <span className="whitespace-pre">{entry.line}</span>
          </div>
        )}
        {/* Lines below */}
        {entry.lines_below &&
          last_non_empty_line !== -1 &&
          entry.lines_below
            .slice(0, last_non_empty_line + 1)
            .map((line, idx) => (
              <div
                key={`below-${idx}`}
                className="text-gray-500 dark:text-gray-500"
              >
                <span className="text-gray-400 dark:text-gray-600 mr-2">
                  {entry.line_number + idx + 1}:
                </span>
                <span className="whitespace-pre">{line}</span>
              </div>
            ))}
      </div>
    </div>
  );
}
