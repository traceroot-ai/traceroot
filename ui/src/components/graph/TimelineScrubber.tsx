'use client';

import React, { useState, useRef } from 'react';
import { TimelineEvent } from '@/types/graph';
import { Play, Pause, SkipBack, SkipForward, RotateCcw, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface TimelineScrubberProps {
  events: TimelineEvent[];
  timeRange: { start: number; end: number };
  currentTime: number;
  isPlaying: boolean;
  playbackSpeed: number;
  onTimeChange: (time: number) => void;
  onPlayToggle: () => void;
  onSpeedChange: (speed: number) => void;
  onReset: () => void;
  className?: string;
  compact?: boolean; // reduces padding / heights for embedding in constrained panels
}

export default function TimelineScrubber({
  events,
  timeRange,
  currentTime,
  isPlaying,
  playbackSpeed,
  onTimeChange,
  onPlayToggle,
  onSpeedChange,
  onReset,
  className = '',
  compact = false
}: TimelineScrubberProps) {
  const [hoveredEvent, setHoveredEvent] = useState<TimelineEvent | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  // Calculate position percentage for events and current time
  const getTimePosition = (timestamp: number) => {
    const duration = timeRange.end - timeRange.start;
    if (duration === 0) return 0;
    return ((timestamp - timeRange.start) / duration) * 100;
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const formatDuration = (duration: number) => {
    const minutes = Math.floor(duration / 60000);
    const seconds = Math.floor((duration % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const getEventColor = (event: TimelineEvent) => {
    switch (event.severity) {
      case 'critical': return 'bg-red-600';
      case 'high': return 'bg-red-500';
      case 'medium': return 'bg-yellow-500';
      case 'low': return 'bg-blue-500';
      default: return 'bg-gray-500';
    }
  };

  const getEventIcon = (event: TimelineEvent) => {
    switch (event.type) {
      case 'api_call': return '🔄';
      case 'error': return '❌';
      case 'performance_spike': return '📈';
      case 'deployment': return '🚀';
      case 'log_entry': return '📝';
      default: return '•';
    }
  };

  const handleTimelineClick = (event: React.MouseEvent) => {
    if (!timelineRef.current) return;
    
    const rect = timelineRef.current.getBoundingClientRect();
    const clickPosition = (event.clientX - rect.left) / rect.width;
    const newTime = timeRange.start + (timeRange.end - timeRange.start) * clickPosition;
    onTimeChange(newTime);
  };

  const speedOptions = [0.25, 0.5, 1, 2, 4];

  return (
    <div className={`bg-white border-t border-gray-200 h-full flex flex-col ${className}`}>
      {/* Clean Timeline Header */}
      <div className={`${compact ? 'px-3 py-2' : 'px-4 py-3'} border-b border-gray-100 flex-shrink-0`}> 
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <Clock className="w-4 h-4 text-gray-600" />
            <h3 className="text-sm font-medium text-gray-900">Timeline</h3>
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-1 rounded">
              {events.length} events
            </span>
          </div>
          
          <div className="flex items-center space-x-4 text-xs text-gray-500">
            <span>{formatTime(timeRange.start)}</span>
            <span>—</span>
            <span>{formatTime(timeRange.end)}</span>
          </div>
        </div>
      </div>

      {/* Modern Timeline Visualization */}
      <div className={`${compact ? 'p-3' : 'p-4'} flex-1 min-h-0 flex flex-col`}> 
        <div
          ref={timelineRef}
          className={`relative ${compact ? 'h-12' : 'h-16'} bg-gradient-to-r from-gray-50 to-gray-100 border border-gray-200 rounded-lg cursor-pointer mb-4 overflow-hidden hover:shadow-sm transition-shadow flex-shrink-0`}
          onClick={handleTimelineClick}
        >
          {/* Timeline background with subtle grid */}
          <div className="absolute inset-0">
            <div className="h-full bg-gradient-to-r from-transparent via-gray-100/50 to-transparent"></div>
            {/* Time markers */}
            {Array.from({ length: 6 }, (_, i) => (
              <div
                key={i}
                className="absolute top-0 h-full border-l border-gray-200/60"
                style={{ left: `${(i * 20)}%` }}
              >
                <span className="absolute -bottom-5 text-xs text-gray-400 transform -translate-x-1/2">
                  {formatTime(timeRange.start + (timeRange.end - timeRange.start) * (i / 5))}
                </span>
              </div>
            ))}
          </div>

          {/* Events with improved design */}
          {events.map((event, index) => {
            const position = getTimePosition(event.timestamp);
            return (
              <div
                key={index}
                className="absolute top-2 transform -translate-x-1/2 z-10"
                style={{ left: `${position}%` }}
                onMouseEnter={() => setHoveredEvent(event)}
                onMouseLeave={() => setHoveredEvent(null)}
              >
                <div className={`w-3 h-12 ${getEventColor(event)} rounded-full shadow-sm cursor-pointer transition-all hover:scale-110 hover:shadow-md`}>
                  <div className="absolute -top-1 left-1/2 transform -translate-x-1/2 text-xs">
                    {getEventIcon(event)}
                  </div>
                </div>
              </div>
            );
          })}

          {/* Current time indicator - modern design */}
          <div
            className="absolute top-0 h-full w-0.5 bg-blue-500 z-20 shadow-lg"
            style={{ left: `${getTimePosition(currentTime)}%` }}
          >
            <div className="absolute -top-2 -left-2 w-4 h-4 bg-blue-500 rounded-full shadow-lg border-2 border-white">
              <div className="absolute inset-1 bg-white rounded-full"></div>
            </div>
            <div className="absolute -bottom-6 -left-8 bg-blue-500 text-white text-xs px-2 py-1 rounded shadow-lg whitespace-nowrap">
              {formatTime(currentTime)}
            </div>
          </div>

          {/* Enhanced hover tooltip */}
          {hoveredEvent && (
            <div className="absolute z-30 bg-gray-900 text-white p-3 rounded-lg text-xs whitespace-nowrap transform -translate-x-1/2 -translate-y-full shadow-xl border border-gray-700"
                 style={{ left: `${getTimePosition(hoveredEvent.timestamp)}%`, top: '-10px' }}>
              <div className="font-semibold flex items-center mb-1">
                <span className="mr-2 text-sm">{getEventIcon(hoveredEvent)}</span>
                {hoveredEvent.type.replace('_', ' ').toUpperCase()}
              </div>
              <div className="text-gray-300 mb-1">{hoveredEvent.description}</div>
              <div className="text-gray-400 text-xs border-t border-gray-700 pt-1">
                {formatTime(hoveredEvent.timestamp)}
              </div>
              {/* Arrow pointing down */}
              <div className="absolute top-full left-1/2 transform -translate-x-1/2 w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-gray-900"></div>
            </div>
          )}
        </div>

        {/* Controls with cleaner layout */}
  <div className={`flex items-center justify-between ${compact ? 'mt-1' : ''} flex-shrink-0`}>
          <div className="flex items-center space-x-2">
            {/* Playback controls */}
            <Button
              variant="outline"
              size="sm"
              onClick={onReset}
              className="h-8 w-8 p-0"
              title="Reset to start"
            >
              <RotateCcw className="w-3 h-3" />
            </Button>
            
            <Button
              variant="outline"
              size="sm"
              onClick={() => onTimeChange(Math.max(timeRange.start, currentTime - 5000))}
              className="h-8 w-8 p-0"
              title="Step backward"
            >
              <SkipBack className="w-3 h-3" />
            </Button>
            
            <Button
              variant={isPlaying ? "default" : "outline"}
              size="sm"
              onClick={onPlayToggle}
              className="h-8 w-8 p-0"
            >
              {isPlaying ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
            </Button>
            
            <Button
              variant="outline"
              size="sm"
              onClick={() => onTimeChange(Math.min(timeRange.end, currentTime + 5000))}
              className="h-8 w-8 p-0"
              title="Step forward"
            >
              <SkipForward className="w-3 h-3" />
            </Button>
          </div>

          {/* Speed control */}
          <div className="flex items-center space-x-2">
            <span className="text-sm text-gray-600">Speed:</span>
            <select
              value={playbackSpeed}
              onChange={(e) => onSpeedChange(parseFloat(e.target.value))}
              className="text-sm border border-gray-300 rounded px-2 py-1 bg-white"
            >
              {speedOptions.map(speed => (
                <option key={speed} value={speed}>
                  {speed}x
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* Current time display */}
        {!compact && (
          <div className="mt-3 text-center text-sm text-gray-600 bg-gray-50 rounded py-2 flex-shrink-0">
            Current: {formatTime(currentTime)}
          </div>
        )}
      </div>
    </div>
  );
}
