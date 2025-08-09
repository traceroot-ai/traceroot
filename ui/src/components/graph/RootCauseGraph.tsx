'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  GraphData, 
  GraphNode, 
  GraphEdge, 
  GraphViewport, 
  GraphInteraction,
  TimelineEvent 
} from '@/types/graph';
import { 
  ZoomIn, 
  ZoomOut, 
  Maximize2, 
  Minimize2,
  Move,
  Target,
  Layers,
  Filter,
  Settings
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';

interface RootCauseGraphProps {
  data: GraphData;
  width: number;
  height: number;
  onNodeClick?: (node: GraphNode) => void;
  onEdgeClick?: (edge: GraphEdge) => void;
  className?: string;
}

interface ForceSimulation {
  nodes: Array<GraphNode & { 
    vx: number; 
    vy: number; 
    fx?: number; 
    fy?: number;
    mass: number;
  }>;
  running: boolean;
}

interface GraphFilters {
  showHealthy: boolean;
  showWarning: boolean;
  showError: boolean;
  showCritical: boolean;
  nodeTypes: Set<string>;
  edgeTypes: Set<string>;
  minErrorCount: number;
  maxLatency: number;
}

export default function RootCauseGraph({ 
  data, 
  width, 
  height, 
  onNodeClick, 
  onEdgeClick,
  className = '' 
}: RootCauseGraphProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number | undefined>(undefined);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const lastPanPosition = useRef({ x: 0, y: 0 });
  
  const [viewport, setViewport] = useState<GraphViewport>({
    x: 0,
    y: 0,
    scale: 1
  });
  
  const [interaction, setInteraction] = useState<GraphInteraction>({
    isPlaying: false,
    playbackSpeed: 1,
    currentTimePosition: 0
  });

  const [forceSimulation, setForceSimulation] = useState<ForceSimulation>({
    nodes: [],
    running: false
  });

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [filters, setFilters] = useState<GraphFilters>({
    showHealthy: true,
    showWarning: true,
    showError: true,
    showCritical: true,
    nodeTypes: new Set(['service', 'function', 'module', 'endpoint']),
    edgeTypes: new Set(['api_call', 'function_call', 'data_flow', 'dependency']),
    minErrorCount: 0,
    maxLatency: Infinity
  });

  const [hoveredElement, setHoveredElement] = useState<{
    type: 'node' | 'edge';
    id: string;
    data: GraphNode | GraphEdge;
    position: { x: number; y: number };
  } | null>(null);

  // Enhanced color schemes for better visual hierarchy
  const getNodeColor = (node: GraphNode, isDark = false) => {
    const baseColors = {
      healthy: isDark ? '#22c55e' : '#16a34a',
      warning: isDark ? '#fbbf24' : '#d97706', 
      error: isDark ? '#f87171' : '#dc2626',
      critical: isDark ? '#ef4444' : '#991b1b'
    };
    return baseColors[node.status] || '#6b7280';
  };

  const getNodeGradient = (node: GraphNode) => {
    const colors = {
      healthy: ['#16a34a', '#22c55e'],
      warning: ['#d97706', '#fbbf24'],
      error: ['#dc2626', '#f87171'],
      critical: ['#991b1b', '#ef4444']
    };
    return colors[node.status] || ['#6b7280', '#9ca3af'];
  };

  const getEdgeColor = (edge: GraphEdge, opacity = 0.7) => {
    const colors = {
      healthy: `rgba(107, 114, 128, ${opacity})`,
      slow: `rgba(245, 158, 11, ${opacity})`,
      failing: `rgba(239, 68, 68, ${opacity})`
    };
    return colors[edge.status] || `rgba(156, 163, 175, ${opacity})`;
  };

  // Simplified node size - more consistent and clean
  const getNodeSize = (node: GraphNode) => {
    const baseSize = 16;
    const errorMultiplier = Math.min(node.metadata.errorCount * 2, 16);
    return baseSize + errorMultiplier;
  };

  // Enhanced connection strength calculation for force simulation
  const getConnectionStrength = (edge: GraphEdge) => {
    const baseStrength = 0.3;
    const callCountFactor = Math.log(edge.metadata.callCount + 1) * 0.1;
    const errorFactor = edge.metadata.errorRate * 0.5;
    const latencyFactor = edge.metadata.averageLatency > 1000 ? 0.2 : 0;
    
    return Math.min(baseStrength + callCountFactor + errorFactor + latencyFactor, 1);
  };

  // Force simulation for dynamic layout
  useEffect(() => {
    if (!data.nodes.length) return;

    const simulationNodes = data.nodes.map(node => ({
      ...node,
      vx: 0,
      vy: 0,
      mass: getNodeSize(node) / 20,
      fx: undefined,
      fy: undefined
    }));

    setForceSimulation({
      nodes: simulationNodes,
      running: true
    });

    // Start physics simulation
    const tick = () => {
      simulationNodes.forEach((node, i) => {
        // Central force towards center
        const centerX = width / 2;
        const centerY = height / 2;
        const toCenterX = centerX - node.position.x;
        const toCenterY = centerY - node.position.y;
        const centerDistance = Math.sqrt(toCenterX * toCenterX + toCenterY * toCenterY);
        
        if (centerDistance > 0) {
          const centerForce = 0.001;
          node.vx += (toCenterX / centerDistance) * centerForce;
          node.vy += (toCenterY / centerDistance) * centerForce;
        }

        // Repulsion between nodes
        simulationNodes.forEach((other, j) => {
          if (i === j) return;
          
          const dx = node.position.x - other.position.x;
          const dy = node.position.y - other.position.y;
          const distance = Math.sqrt(dx * dx + dy * dy) || 1;
          const minDistance = (getNodeSize(node) + getNodeSize(other)) * 2;
          
          if (distance < minDistance) {
            const force = (minDistance - distance) / distance * 0.1;
            node.vx += (dx / distance) * force;
            node.vy += (dy / distance) * force;
          }
        });

        // Spring forces from edges
        data.edges.forEach(edge => {
          const sourceNode = simulationNodes.find(n => n.id === edge.source);
          const targetNode = simulationNodes.find(n => n.id === edge.target);
          
          if (sourceNode && targetNode) {
            const dx = targetNode.position.x - sourceNode.position.x;
            const dy = targetNode.position.y - sourceNode.position.y;
            const distance = Math.sqrt(dx * dx + dy * dy) || 1;
            const idealDistance = 150;
            const force = (distance - idealDistance) * getConnectionStrength(edge) * 0.01;
            
            if (sourceNode.id === node.id) {
              node.vx += (dx / distance) * force;
              node.vy += (dy / distance) * force;
            }
            if (targetNode.id === node.id) {
              node.vx -= (dx / distance) * force;
              node.vy -= (dy / distance) * force;
            }
          }
        });

        // Apply velocity damping
        node.vx *= 0.9;
        node.vy *= 0.9;

        // Update position if not pinned
        if (node.fx === undefined) {
          node.position.x += node.vx;
          node.position.y += node.vy;
        }

        // Boundary constraints
        const nodeSize = getNodeSize(node);
        node.position.x = Math.max(nodeSize, Math.min(width - nodeSize, node.position.x));
        node.position.y = Math.max(nodeSize, Math.min(height - nodeSize, node.position.y));
      });

      setForceSimulation(prev => ({ ...prev, nodes: [...simulationNodes] }));
    };

    const interval = setInterval(tick, 16); // ~60fps
    
    // Stop simulation after some time
    setTimeout(() => {
      clearInterval(interval);
      setForceSimulation(prev => ({ ...prev, running: false }));
    }, 5000);

    return () => clearInterval(interval);
  }, [data.nodes, data.edges, width, height]);

  // Filter nodes and edges based on current filters
  const filteredNodes = data.nodes.filter(node => {
    if (!filters.nodeTypes.has(node.type)) return false;
    if (!filters.showHealthy && node.status === 'healthy') return false;
    if (!filters.showWarning && node.status === 'warning') return false;
    if (!filters.showError && node.status === 'error') return false;
    if (!filters.showCritical && node.status === 'critical') return false;
    if (node.metadata.errorCount < filters.minErrorCount) return false;
    if (node.metadata.latency && node.metadata.latency > filters.maxLatency) return false;
    return true;
  });

  const filteredEdges = data.edges.filter(edge => {
    if (!filters.edgeTypes.has(edge.type)) return false;
    const sourceVisible = filteredNodes.some(n => n.id === edge.source);
    const targetVisible = filteredNodes.some(n => n.id === edge.target);
    return sourceVisible && targetVisible;
  });

  // Event handlers
  const handleNodeClick = useCallback((event: React.MouseEvent, node: GraphNode) => {
    event.stopPropagation();
    setInteraction(prev => ({ ...prev, selectedNode: node.id }));
    onNodeClick?.(node);
  }, [onNodeClick]);

  const handleEdgeClick = useCallback((event: React.MouseEvent, edge: GraphEdge) => {
    event.stopPropagation();
    setInteraction(prev => ({ ...prev, selectedEdge: edge.id }));
    onEdgeClick?.(edge);
  }, [onEdgeClick]);

  const handleNodeMouseEnter = useCallback((event: React.MouseEvent, node: GraphNode) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (rect) {
      setHoveredElement({
        type: 'node',
        id: node.id,
        data: node,
        position: {
          x: event.clientX - rect.left,
          y: event.clientY - rect.top
        }
      });
    }
    setInteraction(prev => ({ ...prev, hoveredNode: node.id }));
  }, []);

  const handleNodeMouseLeave = useCallback(() => {
    setHoveredElement(null);
    setInteraction(prev => ({ ...prev, hoveredNode: undefined }));
  }, []);

  // Viewport controls
  const zoomIn = useCallback(() => {
    setViewport(prev => ({
      ...prev,
      scale: Math.min(prev.scale * 1.2, 5)
    }));
  }, []);

  const zoomOut = useCallback(() => {
    setViewport(prev => ({
      ...prev,
      scale: Math.max(prev.scale / 1.2, 0.1)
    }));
  }, []);

  const resetView = useCallback(() => {
    setViewport({ x: 0, y: 0, scale: 1 });
  }, []);

  const centerOnNode = useCallback((nodeId: string) => {
    const node = filteredNodes.find(n => n.id === nodeId);
    if (node) {
      setViewport({
        x: width / 2 - node.position.x,
        y: height / 2 - node.position.y,
        scale: 1.5
      });
    }
  }, [filteredNodes, width, height]);

  // Pan and zoom handling
  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button === 0) { // Left mouse button
      isDragging.current = true;
      dragStart.current = { x: event.clientX, y: event.clientY };
      lastPanPosition.current = { x: viewport.x, y: viewport.y };
    }
  }, [viewport]);

  const handleMouseMove = useCallback((event: React.MouseEvent) => {
    if (isDragging.current) {
      const deltaX = event.clientX - dragStart.current.x;
      const deltaY = event.clientY - dragStart.current.y;
      
      setViewport(prev => ({
        ...prev,
        x: lastPanPosition.current.x + deltaX,
        y: lastPanPosition.current.y + deltaY
      }));
    }
  }, []);

  const handleMouseUp = useCallback(() => {
    isDragging.current = false;
  }, []);

  const handleWheel = useCallback((event: React.WheelEvent) => {
    event.preventDefault();
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;
    const delta = event.deltaY > 0 ? 0.9 : 1.1;
    
    setViewport(prev => {
      const newScale = Math.max(0.1, Math.min(5, prev.scale * delta));
      const scaleRatio = newScale / prev.scale;
      
      return {
        x: mouseX - (mouseX - prev.x) * scaleRatio,
        y: mouseY - (mouseY - prev.y) * scaleRatio,
        scale: newScale
      };
    });
  }, []);;

  // Animation loop for pulsing and flow effects
  useEffect(() => {
    if (!interaction.isPlaying) return;

    const animate = () => {
      setInteraction(prev => ({
        ...prev,
        currentTimePosition: (prev.currentTimePosition + prev.playbackSpeed) % 100
      }));
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, [interaction.isPlaying, interaction.playbackSpeed]);

  // Simplified node rendering with clean Obsidian-like design
  const renderNodes = () => {
    return filteredNodes.map(node => {
      const size = Math.max(16, Math.min(32, 16 + node.metadata.errorCount * 2)); // Smaller, more consistent sizes
      const isSelected = interaction.selectedNode === node.id;
      const isHovered = interaction.hoveredNode === node.id;
      
      // Simple color scheme
      const getNodeColor = () => {
        switch (node.status) {
          case 'healthy': return '#22c55e';
          case 'warning': return '#f59e0b';
          case 'error': return '#ef4444';
          case 'critical': return '#dc2626';
          default: return '#6b7280';
        }
      };
      
      return (
        <g key={node.id} transform={`translate(${node.position.x}, ${node.position.y})`}>
          {/* Simple glow for errors */}
          {(node.status === 'error' || node.status === 'critical') && (
            <circle
              r={size + 4}
              fill={getNodeColor()}
              opacity={0.2}
              className={node.animation?.pulse ? 'animate-pulse' : ''}
            />
          )}
          
          {/* Main node circle - simple and clean */}
          <circle
            r={size}
            fill={getNodeColor()}
            stroke={isSelected ? '#3b82f6' : isHovered ? '#374151' : '#ffffff'}
            strokeWidth={isSelected ? 3 : isHovered ? 2 : 1}
            className="cursor-pointer transition-all duration-200"
            onClick={(e) => handleNodeClick(e, node)}
            onMouseEnter={(e) => handleNodeMouseEnter(e, node)}
            onMouseLeave={handleNodeMouseLeave}
            style={{
              filter: isSelected ? 'drop-shadow(0 0 8px rgba(59, 130, 246, 0.6))' : 
                      'drop-shadow(0 1px 2px rgba(0, 0, 0, 0.1))'
            }}
          />
          
          {/* Simple node label */}
          <text
            y={size + 16}
            textAnchor="middle"
            className="text-xs font-medium fill-gray-700 pointer-events-none select-none"
          >
            {node.label.length > 10 ? `${node.label.substring(0, 8)}...` : node.label}
          </text>
          
          {/* Error count indicator */}
          {node.metadata.errorCount > 0 && (
            <g transform={`translate(${size * 0.6}, ${-size * 0.6})`}>
              <circle r="6" fill="#dc2626" />
              <text
                textAnchor="middle"
                y="2"
                className="text-xs font-bold fill-white pointer-events-none select-none"
              >
                {node.metadata.errorCount > 9 ? '9+' : node.metadata.errorCount}
              </text>
            </g>
          )}
        </g>
      );
    });
  };

  // Simplified edge rendering
  const renderEdges = () => {
    return filteredEdges.map(edge => {
      const sourceNode = filteredNodes.find(n => n.id === edge.source);
      const targetNode = filteredNodes.find(n => n.id === edge.target);
      
      if (!sourceNode || !targetNode) return null;
      
      const isSelected = interaction.selectedEdge === edge.id;
      
      // Simple color scheme for edges
      const getEdgeColor = () => {
        switch (edge.status) {
          case 'healthy': return '#6b7280';
          case 'slow': return '#f59e0b';
          case 'failing': return '#ef4444';
          default: return '#9ca3af';
        }
      };
      
      return (
        <g key={edge.id}>
          <line
            x1={sourceNode.position.x}
            y1={sourceNode.position.y}
            x2={targetNode.position.x}
            y2={targetNode.position.y}
            stroke={getEdgeColor()}
            strokeWidth={isSelected ? 3 : edge.metadata.errorRate > 0.1 ? 2 : 1}
            opacity={isSelected ? 1 : 0.6}
            className="cursor-pointer transition-all duration-200"
            onClick={(e) => handleEdgeClick(e, edge)}
            style={{
              filter: isSelected ? 'drop-shadow(0 0 4px rgba(59, 130, 246, 0.4))' : ''
            }}
          />
          
          {/* Simple arrow */}
          <polygon
            points="0,0 -8,-3 -8,3"
            fill={getEdgeColor()}
            opacity={isSelected ? 1 : 0.6}
            transform={`translate(${targetNode.position.x}, ${targetNode.position.y}) rotate(${
              Math.atan2(
                targetNode.position.y - sourceNode.position.y,
                targetNode.position.x - sourceNode.position.x
              ) * 180 / Math.PI
            })`}
          />
          
          {/* Flow animation */}
          {edge.animation?.flow && (
            <circle r="2" fill="#3b82f6" opacity="0.8">
              <animateMotion
                dur={`${2 / interaction.playbackSpeed}s`}
                repeatCount="indefinite"
                path={`M${sourceNode.position.x},${sourceNode.position.y} L${targetNode.position.x},${targetNode.position.y}`}
              />
            </circle>
          )}
        </g>
      );
    });
  };

  return (
    <div className={`relative overflow-hidden bg-white ${className}`}>
      {/* Main SVG Canvas with cleaner design */}
      <svg
        ref={svgRef}
        width={width}
        height={height}
        viewBox={`${-viewport.x / viewport.scale} ${-viewport.y / viewport.scale} ${width / viewport.scale} ${height / viewport.scale}`}
        className="cursor-grab active:cursor-grabbing"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onWheel={handleWheel}
      >
        {/* Gradient Definitions */}
        <defs>
          {/* Node gradients with more subtle colors */}
          <radialGradient id="gradient-healthy" cx="30%" cy="30%">
            <stop offset="0%" stopColor="#10b981" />
            <stop offset="100%" stopColor="#059669" />
          </radialGradient>
          <radialGradient id="gradient-warning" cx="30%" cy="30%">
            <stop offset="0%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#d97706" />
          </radialGradient>
          <radialGradient id="gradient-error" cx="30%" cy="30%">
            <stop offset="0%" stopColor="#ef4444" />
            <stop offset="100%" stopColor="#dc2626" />
          </radialGradient>
          <radialGradient id="gradient-critical" cx="30%" cy="30%">
            <stop offset="0%" stopColor="#dc2626" />
            <stop offset="100%" stopColor="#991b1b" />
          </radialGradient>
          
          {/* Subtle glow effects */}
          <radialGradient id="glow-error" cx="50%" cy="50%">
            <stop offset="0%" stopColor="#ef4444" stopOpacity="0.2" />
            <stop offset="100%" stopColor="#ef4444" stopOpacity="0" />
          </radialGradient>
          <radialGradient id="glow-critical" cx="50%" cy="50%">
            <stop offset="0%" stopColor="#dc2626" stopOpacity="0.3" />
            <stop offset="100%" stopColor="#dc2626" stopOpacity="0" />
          </radialGradient>
          
          {/* Clean arrow markers */}
          <marker id="arrowhead-healthy" markerWidth="8" markerHeight="6" 
                  refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L0,6 L8,3 z" fill="#10b981" />
          </marker>
          <marker id="arrowhead-slow" markerWidth="8" markerHeight="6" 
                  refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L0,6 L8,3 z" fill="#f59e0b" />
          </marker>
          <marker id="arrowhead-failing" markerWidth="8" markerHeight="6" 
                  refX="7" refY="3" orient="auto" markerUnits="strokeWidth">
            <path d="M0,0 L0,6 L8,3 z" fill="#ef4444" />
          </marker>
          
          {/* Grid pattern */}
          <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
            <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#f8fafc" strokeWidth="1"/>
          </pattern>
        </defs>

        {/* Clean grid background */}
        <rect width="100%" height="100%" fill="#fdfdfd" />
        <rect width="100%" height="100%" fill="url(#grid)" />
        
        {/* Failure clusters visualization with better design */}
        {data.failureClusters.map((cluster, index) => {
          const clusterNodes = filteredNodes.filter(n => cluster.affectedNodes.includes(n.id));
          if (clusterNodes.length < 2) return null;
          
          const centerX = clusterNodes.reduce((sum, n) => sum + n.position.x, 0) / clusterNodes.length;
          const centerY = clusterNodes.reduce((sum, n) => sum + n.position.y, 0) / clusterNodes.length;
          const maxDistance = Math.max(...clusterNodes.map(n => 
            Math.sqrt((n.position.x - centerX) ** 2 + (n.position.y - centerY) ** 2)
          ));
          
          return (
            <circle
              key={`cluster-${index}`}
              cx={centerX}
              cy={centerY}
              r={maxDistance + 60}
              fill="rgba(239, 68, 68, 0.03)"
              stroke="rgba(239, 68, 68, 0.15)"
              strokeWidth="1"
              strokeDasharray="8,4"
            />
          );
        })}
        
        {/* Render edges first (behind nodes) */}
        {renderEdges()}
        
        {/* Render nodes */}
        {renderNodes()}
      </svg>
      
      {/* Simplified Control Panel */}
      {showControls && (
        <div className="absolute top-4 left-4 bg-white/95 backdrop-blur-sm border border-gray-200 rounded-lg p-3 shadow-sm">
          <div className="flex flex-col space-y-2">
            {/* Zoom Controls */}
            <div className="flex items-center space-x-2">
              <Button variant="ghost" size="sm" onClick={zoomOut} className="p-2 h-8 w-8">
                <ZoomOut className="w-4 h-4" />
              </Button>
              <div className="text-xs text-gray-600 min-w-[50px] text-center">
                {Math.round(viewport.scale * 100)}%
              </div>
              <Button variant="ghost" size="sm" onClick={zoomIn} className="p-2 h-8 w-8">
                <ZoomIn className="w-4 h-4" />
              </Button>
            </div>
            
            {/* Reset View */}
            <Button variant="ghost" size="sm" onClick={resetView} className="p-2 h-8" title="Reset View">
              <Target className="w-4 h-4 mr-1" />
              <span className="text-xs">Reset</span>
            </Button>
          </div>
        </div>
      )}

      {/* Cleaner Stats Panel */}
      <div className="absolute top-4 right-4 bg-white/95 backdrop-blur-sm border border-gray-200 rounded-lg p-3 shadow-sm">
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-700 border-b border-gray-100 pb-1">
            Network Stats
          </div>
          <div className="space-y-1 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-gray-600">Components:</span>
              <span className="font-medium">{filteredNodes.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-600">Connections:</span>
              <span className="font-medium">{filteredEdges.length}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-600">Active Errors:</span>
              <span className="font-medium text-red-600">
                {filteredNodes.reduce((sum, n) => sum + n.metadata.errorCount, 0)}
              </span>
            </div>
          </div>
        </div>
      </div>


      {/* Simulation indicator */}
      {forceSimulation.running && (
        <div className="absolute bottom-4 right-4 bg-blue-50 border border-blue-200 rounded-lg p-2 shadow-sm">
          <div className="flex items-center space-x-2">
            <div className="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-600"></div>
            <span className="text-xs text-blue-700">Optimizing layout...</span>
          </div>
        </div>
      )}

      {/* Enhanced Hover Tooltip */}
      {hoveredElement && (
        <div 
          className="absolute z-50 bg-gray-900 text-white p-3 rounded-lg shadow-xl max-w-xs pointer-events-none"
          style={{
            left: Math.min(hoveredElement.position.x + 15, width - 200),
            top: Math.max(hoveredElement.position.y - 60, 10)
          }}
        >
          {hoveredElement.type === 'node' ? (
            <div className="space-y-1">
              <div className="font-semibold text-sm">{(hoveredElement.data as GraphNode).label}</div>
              <div className="text-xs text-gray-300 capitalize">
                {(hoveredElement.data as GraphNode).type} • {(hoveredElement.data as GraphNode).status}
              </div>
              {(hoveredElement.data as GraphNode).metadata.errorCount > 0 && (
                <div className="text-xs bg-red-600 text-white px-1 rounded">
                  {(hoveredElement.data as GraphNode).metadata.errorCount} errors
                </div>
              )}
              {(hoveredElement.data as GraphNode).metadata.latency && (
                <div className="text-xs text-blue-300">
                  {(hoveredElement.data as GraphNode).metadata.latency}ms latency
                </div>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              <div className="font-semibold text-sm capitalize">{(hoveredElement.data as GraphEdge).type}</div>
              <div className="text-xs text-gray-300">
                {(hoveredElement.data as GraphEdge).metadata.callCount} calls
              </div>
              <div className="text-xs text-gray-300">
                {(hoveredElement.data as GraphEdge).metadata.averageLatency}ms avg
              </div>
              {(hoveredElement.data as GraphEdge).metadata.errorRate > 0 && (
                <div className="text-xs text-red-300">
                  {Math.round((hoveredElement.data as GraphEdge).metadata.errorRate * 100)}% error rate
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Controls Toggle */}
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setShowControls(!showControls)}
        className="absolute bottom-4 right-16 p-2 h-8 w-8 bg-white/95 backdrop-blur-sm border border-gray-200 shadow-sm"
        title="Toggle Controls"
      >
        <Settings className="w-4 h-4" />
      </Button>
    </div>
  );
}
