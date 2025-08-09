'use client';

import React, { useState, useEffect, useMemo, useRef } from 'react';
import RootCauseGraph from './RootCauseGraph';
import TimelineScrubber from './TimelineScrubber';
import AIAnalysisPanel from './AIAnalysisPanel';
import { GraphData, GraphNode, TimelineEvent } from '@/types/graph';
import { Button } from '@/components/ui/button';
import { Clock, TrendingUp, RefreshCw } from 'lucide-react';

interface RootCauseGraphExplorerProps {
  initialData?: GraphData;
  className?: string;
}

export default function RootCauseGraphExplorer({
  initialData,
  className = ''
}: RootCauseGraphExplorerProps) {
  // Use static time values to prevent hydration mismatch
  const staticEndTime = 1723276800000; // Fixed timestamp for SSR consistency
  const staticStartTime = staticEndTime - 3600000; // 1 hour before

  // State management
  const [graphData, setGraphData] = useState<GraphData>(initialData || {
    nodes: [],
    edges: [],
    failureClusters: [],
    timeRange: { start: staticStartTime, end: staticEndTime },
    timeline: [],
    currentTime: staticEndTime
  });
  
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [showTimeline, setShowTimeline] = useState(false);
  const [showAIPanel, setShowAIPanel] = useState(true);
  const [currentTime, setCurrentTime] = useState(staticEndTime);
  // Dynamic graph sizing
  const graphWrapperRef = useRef<HTMLDivElement | null>(null);
  const [graphDimensions, setGraphDimensions] = useState({ width: 0, height: 0 });

  // Resize observer to keep graph responsive and leave space for AI panel
  useEffect(() => {
    const el = graphWrapperRef.current;
    if (!el) return;
    const resize = () => {
      const rect = el.getBoundingClientRect();
      setGraphDimensions({ width: Math.max(0, rect.width), height: Math.max(0, rect.height) });
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    return () => ro.disconnect();
  }, [showAIPanel]);

  // Debug AI panel state
  useEffect(() => {
    console.log('AI Panel state:', showAIPanel);
  }, [showAIPanel]);

  // Mock AI analysis data
  const mockAnalysis = {
    rootCause: "Performance bottleneck in example service causing high latency",
    confidence: 0.85,
    suggestedFixes: [
      "Check database connection pool configuration and limits",
      "Scale example service by increasing instance count or resources", 
      "Implement circuit breaker pattern to prevent cascade failures",
      "Add caching layer to reduce database load",
      "Optimize database queries and add proper indexing"
    ],
    affectedComponents: ["example", "__main__.__main__", "__main__.logging_function"],
    similarIncidents: [
      {
        id: "incident-001",
        timestamp: staticStartTime - 86400000, // 1 day ago
        similarity: 0.92,
        resolution: "Increased connection pool size and added caching"
      },
      {
        id: "incident-002", 
        timestamp: staticStartTime - 172800000, // 2 days ago
        similarity: 0.78,
        resolution: "Database query optimization and indexing"
      }
    ],
    explanation: "The root cause appears to be a performance bottleneck in the example service. High latency (1.19s) is causing timeouts and failures in downstream services. This pattern is similar to previous incidents where database connection pool exhaustion led to cascading failures."
  };

  // Mock data for demonstration
  useEffect(() => {
    const mockData: GraphData = {
      nodes: [
        {
          id: '1',
          label: '__main__',
          type: 'function',
          status: 'error',
          position: { x: 400, y: 100 },
          functionName: '__main__.__main__',
          metadata: { errorCount: 5, latency: 200 }
        },
        {
          id: '2', 
          label: '__main__',
          type: 'function',
          status: 'error',
          position: { x: 200, y: 250 },
          functionName: '__main__.helper_function',
          metadata: { errorCount: 3, latency: 150 }
        },
        {
          id: '3',
          label: '__main__',
          type: 'function', 
          status: 'error',
          position: { x: 400, y: 400 },
          functionName: '__main__.logging_function',
          metadata: { errorCount: 8, latency: 300 }
        },
        {
          id: '4',
          label: 'example',
          type: 'service',
          status: 'critical',
          position: { x: 300, y: 550 },
          functionName: 'example.service_call',
          metadata: { errorCount: 12, latency: 1190 }
        },
        {
          id: '5',
          label: '__main__',
          type: 'function',
          status: 'error', 
          position: { x: 600, y: 250 },
          functionName: '__main__.db_query',
          metadata: { errorCount: 6, latency: 180 }
        },
        {
          id: '6',
          label: '__main__',
          type: 'function',
          status: 'error',
          position: { x: 800, y: 400 },
          functionName: '__main__.cache_lookup',
          metadata: { errorCount: 4, latency: 220 }
        }
      ],
      edges: [
        {
          id: 'e1',
          source: '1',
          target: '2',
          type: 'function_call',
          status: 'failing',
          metadata: { callCount: 150, averageLatency: 200, errorRate: 0.15 }
        },
        {
          id: 'e2', 
          source: '2',
          target: '3',
          type: 'function_call',
          status: 'failing',
          metadata: { callCount: 120, averageLatency: 250, errorRate: 0.20 }
        },
        {
          id: 'e3',
          source: '3', 
          target: '4',
          type: 'api_call',
          status: 'failing',
          metadata: { callCount: 200, averageLatency: 400, errorRate: 0.35 }
        },
        {
          id: 'e4',
          source: '1',
          target: '5', 
          type: 'function_call',
          status: 'failing',
          metadata: { callCount: 80, averageLatency: 180, errorRate: 0.12 }
        },
        {
          id: 'e5',
          source: '5',
          target: '6',
          type: 'function_call', 
          status: 'failing',
          metadata: { callCount: 60, averageLatency: 220, errorRate: 0.18 }
        }
      ],
      failureClusters: [],
      timeRange: { start: staticStartTime, end: staticEndTime },
      timeline: [],
      currentTime: staticEndTime
    };
    
    setGraphData(mockData);
  }, [staticStartTime, staticEndTime]);

  // Event handlers
  const handleNodeClick = (node: GraphNode) => {
    setSelectedNode(selectedNode === node.id ? null : node.id);
    setSelectedEdge(null);
  };

  const handleEdgeClick = (edge: any) => {
    setSelectedEdge(selectedEdge === edge.id ? null : edge.id);
    setSelectedNode(null);
  };

  const refreshData = () => {
    // Refresh logic would go here
    console.log('Refreshing graph data...');
  };

  // Calculate statistics
  const totalNodes = graphData.nodes.length;
  const errorCount = graphData.nodes.reduce((sum, n) => sum + n.metadata.errorCount, 0);

  return (
    <div className={`w-full h-full min-h-0 flex flex-col bg-gray-50 ${className}`}>
      {/* Clean minimal header */}
      <div className="bg-white border-b border-gray-200 px-6 py-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-4">
            <h1 className="text-xl font-semibold text-gray-900">Root Cause Graph</h1>
            <div className="flex items-center space-x-3 text-sm text-gray-600">
              <span>{totalNodes} nodes</span>
              <span>•</span>
              <span>{graphData.edges.length} edges</span>
              {errorCount > 0 && (
                <>
                  <span>•</span>
                  <span className="text-red-600 font-medium">{errorCount} errors</span>
                </>
              )}
            </div>
          </div>
          
          <div className="flex items-center space-x-2">
            <Button
              variant={showTimeline ? "default" : "outline"}
              size="sm"
              onClick={() => setShowTimeline(!showTimeline)}
            >
              <Clock className="w-4 h-4 mr-1" />
              Timeline
            </Button>
            <Button
              variant={showAIPanel ? "default" : "outline"}
              size="sm"
              onClick={() => setShowAIPanel(!showAIPanel)}
              className={showAIPanel ? "bg-blue-600 hover:bg-blue-700 text-white" : ""}
            >
              <TrendingUp className="w-4 h-4 mr-1" />
              AI Analysis
              {showAIPanel && <span className="ml-1 text-xs">•</span>}
            </Button>
            <Button variant="outline" size="sm" onClick={refreshData}>
              <RefreshCw className="w-4 h-4 mr-1" />
              Refresh
            </Button>
          </div>
        </div>
      </div>

      {/* Main content area with proper spacing */}
  <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Graph area with padding to prevent overlap */}
        <div ref={graphWrapperRef} className="flex-1 relative pb-8">
          <RootCauseGraph
            data={graphData}
            width={graphDimensions.width || 800}
            height={graphDimensions.height || 600}
            onNodeClick={handleNodeClick}
            onEdgeClick={handleEdgeClick}
            className="w-full h-full"
          />

          {/* If no dimensions yet (initial render), show subtle placeholder */}
          {graphDimensions.width === 0 && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-gray-400">
              Preparing graph layout...
            </div>
          )}

          {/* Floating legend - repositioned to avoid overlap */}
          <div className="absolute bottom-4 left-4 bg-white/95 backdrop-blur-sm rounded-lg shadow-lg border border-gray-200 p-3">
            <div className="text-xs font-medium text-gray-700 mb-2">Node Status</div>
            <div className="grid grid-cols-2 gap-2">
              <div className="flex items-center space-x-2 text-xs">
                <div className="w-3 h-3 bg-green-500 rounded-full"></div>
                <span className="text-gray-600">Healthy</span>
              </div>
              <div className="flex items-center space-x-2 text-xs">
                <div className="w-3 h-3 bg-yellow-500 rounded-full"></div>
                <span className="text-gray-600">Warning</span>
              </div>
              <div className="flex items-center space-x-2 text-xs">
                <div className="w-3 h-3 bg-red-500 rounded-full"></div>
                <span className="text-gray-600">Error</span>
              </div>
              <div className="flex items-center space-x-2 text-xs">
                <div className="w-3 h-3 bg-red-700 rounded-full"></div>
                <span className="text-gray-600">Critical</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right sidebar - AI Analysis Panel */}
        {showAIPanel && (
          <AIAnalysisPanel 
            analysis={mockAnalysis}
            failureClusters={graphData.failureClusters}
            onRegenerateAnalysis={() => console.log('Regenerating analysis...')}
            className="w-96 border-l-2 border-gray-200 h-full"
          />
        )}
      </div>

      {/* Timeline at bottom (only when enabled) */}
      {showTimeline && (
        <div className="flex-shrink-0 h-32 border-t border-gray-200">
          <TimelineScrubber
            events={[]}
            timeRange={{ start: staticStartTime, end: staticEndTime }}
            currentTime={currentTime}
            isPlaying={false}
            playbackSpeed={1}
            onTimeChange={(time) => setCurrentTime(time)}
            onPlayToggle={() => {}}
            onSpeedChange={() => {}}
            onReset={() => setCurrentTime(staticStartTime)}
            className="h-full"
            compact
          />
        </div>
      )}
    </div>
  );
}
