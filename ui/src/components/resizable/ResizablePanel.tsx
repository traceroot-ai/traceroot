'use client';

import React, { useState, useRef, useEffect } from 'react';

interface ResizablePanelProps {
  leftPanel: React.ReactNode;
  rightPanel: React.ReactNode;
  minLeftWidth?: number;
  maxLeftWidth?: number;
  defaultLeftWidth?: number;
}

export default function ResizablePanel({
  leftPanel,
  rightPanel,
  minLeftWidth = 30,
  maxLeftWidth = 60,
  defaultLeftWidth = 45,
}: ResizablePanelProps) {
  const [leftWidth, setLeftWidth] = useState(defaultLeftWidth);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isDragging || !containerRef.current) return;

      const containerRect = containerRef.current.getBoundingClientRect();
      const newLeftWidth = ((e.clientX - containerRect.left) / containerRect.width) * 100;

      // Constrain the width between min and max values
      const constrainedWidth = Math.min(Math.max(newLeftWidth, minLeftWidth), maxLeftWidth);
      setLeftWidth(constrainedWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging, minLeftWidth, maxLeftWidth]);

  return (
    <div ref={containerRef} className="flex h-screen relative">
      <div style={{ width: `${leftWidth}%` }} className="h-full">
        {leftPanel}
      </div>

      {/* Draggable separator */}
      <div
        className={`w-1 h-full cursor-col-resize hover:bg-green-500 active:bg-green-600 transition-colors ${
          isDragging ? 'bg-green-600' : 'bg-gray-200 dark:bg-gray-700'
        }`}
        onMouseDown={handleMouseDown}
      />

      <div style={{ width: `${100 - leftWidth - 0.25}%` }} className="h-full">
        {rightPanel}
      </div>
    </div>
  );
}
