"use client";

import * as React from "react";
import { Upload, FileText } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * CSV / JSON upload control for creating a dataset or importing rows.
 *
 * It accepts a file and reports the name, but nothing is parsed or stored.
 * `onFile` lets the caller show a confirmation.
 */
export function UploadControl({
  onFile,
  className,
}: {
  onFile?: (fileName: string) => void;
  className?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = React.useState<string | null>(null);
  const [dragging, setDragging] = React.useState(false);

  const accept = (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    onFile?.(file.name);
  };

  return (
    <div className={className}>
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          accept(e.dataTransfer.files?.[0]);
        }}
        className={cn(
          "flex w-full flex-col items-center justify-center gap-1.5 rounded border border-dashed px-4 py-6 text-center transition-colors",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          dragging ? "border-foreground bg-muted/50" : "border-border hover:bg-muted/30",
        )}
      >
        {fileName ? (
          <>
            <FileText className="h-5 w-5 text-muted-foreground" aria-hidden />
            <span className="text-[12px] font-medium">{fileName}</span>
            <span className="text-[11px] text-muted-foreground">
              Click to choose a different file
            </span>
          </>
        ) : (
          <>
            <Upload className="h-5 w-5 text-muted-foreground" aria-hidden />
            <span className="text-[12px]">Drop a CSV or JSON file, or click to browse</span>
            <span className="text-[11px] text-muted-foreground">
              Columns map to input, expected, and metadata
            </span>
          </>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept=".csv,.json,application/json,text/csv"
        className="hidden"
        onChange={(e) => accept(e.target.files?.[0])}
        aria-label="Upload CSV or JSON"
      />
    </div>
  );
}
