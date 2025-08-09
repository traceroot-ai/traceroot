export interface GraphNode {
  id: string;
  label: string;
  type: 'service' | 'function' | 'module' | 'endpoint';
  status: 'healthy' | 'warning' | 'error' | 'critical';
  serviceName?: string;
  functionName?: string;
  moduleName?: string;
  position: { x: number; y: number };
  metadata: {
    errorCount: number;
    latency?: number;
    memoryUsage?: number;
    cpuUsage?: number;
    lastError?: string;
    traceId?: string;
    spanId?: string;
    startTime?: number;
    endTime?: number;
    duration?: number;
    logs?: LogEntry[];
    stackTrace?: string[];
    sourceCode?: SourceCodeInfo;
  };
  animation?: {
    pulse: boolean;
    propagation: boolean;
    intensity: number;
  };
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'api_call' | 'function_call' | 'data_flow' | 'dependency';
  status: 'healthy' | 'slow' | 'failing';
  metadata: {
    callCount: number;
    averageLatency: number;
    errorRate: number;
    lastCall?: number;
    protocol?: string;
    method?: string;
    endpoint?: string;
  };
  animation?: {
    flow: boolean;
    direction: 'forward' | 'backward';
    speed: number;
  };
}

export interface LogEntry {
  timestamp: number;
  level: 'debug' | 'info' | 'warning' | 'error' | 'critical';
  message: string;
  service: string;
  traceId?: string;
  spanId?: string;
  metadata?: Record<string, any>;
}

export interface SourceCodeInfo {
  repository: string;
  filePath: string;
  lineNumber: number;
  contextLines: string[];
  githubUrl?: string;
}

export interface FailureCluster {
  id: string;
  pattern: string;
  count: number;
  timeWindow: { start: number; end: number };
  affectedNodes: string[];
  commonCause?: string;
  confidence: number;
}

export interface AIAnalysis {
  rootCause: string;
  confidence: number;
  suggestedFixes: string[];
  affectedComponents: string[];
  similarIncidents: IncidentReference[];
  explanation: string;
}

export interface IncidentReference {
  id: string;
  timestamp: number;
  similarity: number;
  resolution?: string;
}

export interface TimelineEvent {
  timestamp: number;
  type: 'api_call' | 'error' | 'performance_spike' | 'deployment' | 'log_entry';
  nodeId: string;
  description: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  metadata?: Record<string, any>;
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
  timeline: TimelineEvent[];
  failureClusters: FailureCluster[];
  aiAnalysis?: AIAnalysis;
  timeRange: { start: number; end: number };
  currentTime: number;
}

export interface GraphViewport {
  x: number;
  y: number;
  scale: number;
}

export interface GraphInteraction {
  selectedNode?: string;
  hoveredNode?: string;
  selectedEdge?: string;
  draggedNode?: string;
  isPlaying: boolean;
  playbackSpeed: number;
  currentTimePosition: number;
}
