import { Trace, Span } from '@/models/trace';
import { 
  GraphData, 
  GraphNode, 
  GraphEdge, 
  TimelineEvent, 
  FailureCluster,
  LogEntry 
} from '@/types/graph';

/**
 * Transforms trace data into graph visualization data
 */
export function transformTraceToGraph(traces: Trace[]): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const timeline: TimelineEvent[] = [];
  const nodeMap = new Map<string, GraphNode>();
  const edgeMap = new Map<string, GraphEdge>();

  // Process each trace
  traces.forEach((trace, traceIndex) => {
    const traceStartTime = trace.start_time;
    const traceEndTime = trace.end_time;

    // Create service-level node
    const serviceNode: GraphNode = {
      id: `service-${trace.service_name || 'unknown'}-${trace.id}`,
      label: trace.service_name || 'Unknown Service',
      type: 'service',
      status: getStatusFromTrace(trace),
      serviceName: trace.service_name,
      position: calculateServicePosition(traceIndex, traces.length),
      metadata: {
        errorCount: (trace.num_error_logs || 0) + (trace.num_critical_logs || 0),
        latency: trace.duration,
        traceId: trace.id,
        startTime: traceStartTime,
        endTime: traceEndTime,
        duration: trace.duration,
        logs: generateLogsFromTrace(trace)
      }
    };

    nodes.push(serviceNode);
    nodeMap.set(serviceNode.id, serviceNode);

    // Add timeline event for trace start
    timeline.push({
      timestamp: traceStartTime,
      type: 'api_call',
      nodeId: serviceNode.id,
      description: `Trace started for ${trace.service_name}`,
      severity: 'low'
    });

    // Process spans recursively
    if (trace.spans && trace.spans.length > 0) {
      processSpans(trace.spans, serviceNode, nodes, edges, timeline, nodeMap, edgeMap, trace.id);
    }

    // Add error events if present
    if (serviceNode.metadata.errorCount > 0) {
      timeline.push({
        timestamp: traceEndTime,
        type: 'error',
        nodeId: serviceNode.id,
        description: `${serviceNode.metadata.errorCount} errors detected`,
        severity: serviceNode.metadata.errorCount > 5 ? 'critical' : 'high'
      });
    }
  });

  // Generate failure clusters
  const failureClusters = generateFailureClusters(nodes, timeline);

  // Calculate time range
  const allTimestamps = timeline.map(e => e.timestamp);
  const timeRange = {
    start: Math.min(...allTimestamps),
    end: Math.max(...allTimestamps)
  };

  return {
    nodes,
    edges,
    timeline: timeline.sort((a, b) => a.timestamp - b.timestamp),
    failureClusters,
    timeRange,
    currentTime: timeRange.start
  };
}

function processSpans(
  spans: Span[],
  parentNode: GraphNode,
  nodes: GraphNode[],
  edges: GraphEdge[],
  timeline: TimelineEvent[],
  nodeMap: Map<string, GraphNode>,
  edgeMap: Map<string, GraphEdge>,
  traceId: string,
  depth: number = 0
) {
  spans.forEach((span, spanIndex) => {
    // Create node for this span
    const spanNode: GraphNode = {
      id: `span-${span.id}`,
      label: span.name || `Span ${span.id.substring(0, 8)}`,
      type: span.name?.includes('function') ? 'function' : 'module',
      status: getStatusFromSpan(span),
      functionName: span.name,
      position: calculateSpanPosition(parentNode.position, spanIndex, spans.length, depth),
      metadata: {
        errorCount: (span.num_error_logs || 0) + (span.num_critical_logs || 0),
        latency: span.duration,
        traceId: traceId,
        spanId: span.id,
        startTime: span.start_time,
        endTime: span.end_time,
        duration: span.duration,
        logs: generateLogsFromSpan(span),
        sourceCode: generateSourceCodeInfo(span)
      }
    };

    nodes.push(spanNode);
    nodeMap.set(spanNode.id, spanNode);

    // Create edge from parent to this span
    const edgeId = `${parentNode.id}-${spanNode.id}`;
    if (!edgeMap.has(edgeId)) {
      const edge: GraphEdge = {
        id: edgeId,
        source: parentNode.id,
        target: spanNode.id,
        type: 'function_call',
        status: spanNode.status === 'error' || spanNode.status === 'critical' ? 'failing' : 'healthy',
        metadata: {
          callCount: 1,
          averageLatency: span.duration,
          errorRate: spanNode.metadata.errorCount > 0 ? 1 : 0,
          lastCall: span.start_time
        }
      };
      edges.push(edge);
      edgeMap.set(edgeId, edge);
    }

    // Add timeline events for span
    timeline.push({
      timestamp: span.start_time,
      type: 'api_call',
      nodeId: spanNode.id,
      description: `${span.name} started`,
      severity: 'low'
    });

    if (spanNode.metadata.errorCount > 0) {
      timeline.push({
        timestamp: span.end_time,
        type: 'error',
        nodeId: spanNode.id,
        description: `Error in ${span.name}`,
        severity: spanNode.metadata.errorCount > 3 ? 'critical' : 'high'
      });
    }

    // Process nested spans
    if (span.spans && span.spans.length > 0) {
      processSpans(span.spans, spanNode, nodes, edges, timeline, nodeMap, edgeMap, traceId, depth + 1);
    }
  });
}

function getStatusFromTrace(trace: Trace): 'healthy' | 'warning' | 'error' | 'critical' {
  const errorCount = (trace.num_error_logs || 0) + (trace.num_critical_logs || 0);
  const warningCount = trace.num_warning_logs || 0;

  if (errorCount > 5) return 'critical';
  if (errorCount > 0) return 'error';
  if (warningCount > 0) return 'warning';
  return 'healthy';
}

function getStatusFromSpan(span: Span): 'healthy' | 'warning' | 'error' | 'critical' {
  const errorCount = (span.num_error_logs || 0) + (span.num_critical_logs || 0);
  const warningCount = span.num_warning_logs || 0;

  if (errorCount > 3) return 'critical';
  if (errorCount > 0) return 'error';
  if (warningCount > 0) return 'warning';
  return 'healthy';
}

function calculateServicePosition(index: number, total: number): { x: number; y: number } {
  // Arrange services in a circular layout
  const radius = 300;
  const centerX = 400;
  const centerY = 300;
  const angle = (index / total) * 2 * Math.PI;
  
  return {
    x: centerX + radius * Math.cos(angle),
    y: centerY + radius * Math.sin(angle)
  };
}

function calculateSpanPosition(
  parentPosition: { x: number; y: number },
  index: number,
  total: number,
  depth: number
): { x: number; y: number } {
  // Arrange spans around their parent in a fan pattern
  const radius = Math.max(100 - depth * 20, 40);
  const angle = (index / Math.max(total - 1, 1)) * Math.PI - Math.PI / 2;
  const offsetAngle = depth * 0.3; // Slight rotation per depth level
  
  return {
    x: parentPosition.x + radius * Math.cos(angle + offsetAngle),
    y: parentPosition.y + radius * Math.sin(angle + offsetAngle)
  };
}

function generateLogsFromTrace(trace: Trace): LogEntry[] {
  const logs: LogEntry[] = [];
  
  // Generate mock logs based on trace data
  if (trace.num_error_logs && trace.num_error_logs > 0) {
    for (let i = 0; i < Math.min(trace.num_error_logs, 5); i++) {
      logs.push({
        timestamp: trace.start_time + (trace.duration * i / 5),
        level: 'error',
        message: `Error occurred in ${trace.service_name}`,
        service: trace.service_name || 'unknown',
        traceId: trace.id
      });
    }
  }

  if (trace.num_warning_logs && trace.num_warning_logs > 0) {
    logs.push({
      timestamp: trace.start_time + trace.duration * 0.7,
      level: 'warning',
      message: `Warning in ${trace.service_name}`,
      service: trace.service_name || 'unknown',
      traceId: trace.id
    });
  }

  return logs;
}

function generateLogsFromSpan(span: Span): LogEntry[] {
  const logs: LogEntry[] = [];
  
  if (span.num_error_logs && span.num_error_logs > 0) {
    for (let i = 0; i < Math.min(span.num_error_logs, 3); i++) {
      logs.push({
        timestamp: span.start_time + (span.duration * i / 3),
        level: 'error',
        message: `Error in span ${span.name}`,
        service: 'span',
        traceId: 'unknown',
        spanId: span.id
      });
    }
  }

  return logs;
}

function generateSourceCodeInfo(span: Span) {
  // This would typically come from actual source code analysis
  // For now, generate mock data
  if (span.name && span.name.includes('function')) {
    return {
      repository: 'user/project',
      filePath: `src/${span.name.toLowerCase().replace(/\s+/g, '_')}.py`,
      lineNumber: 42,
      contextLines: [
        'def process_request(data):',
        '    try:',
        '        result = expensive_operation(data)  # ← Error occurred here',
        '        return result',
        '    except Exception as e:',
        '        logger.error(f"Failed to process: {e}")',
        '        raise'
      ],
      githubUrl: `https://github.com/user/project/blob/main/src/${span.name.toLowerCase().replace(/\s+/g, '_')}.py#L42`
    };
  }
  
  return undefined;
}

function generateFailureClusters(nodes: GraphNode[], timeline: TimelineEvent[]): FailureCluster[] {
  const clusters: FailureCluster[] = [];
  
  // Find error events
  const errorEvents = timeline.filter(e => e.type === 'error');
  
  if (errorEvents.length > 1) {
    // Group by time window (5 minute windows)
    const windowSize = 5 * 60 * 1000; // 5 minutes
    const windows = new Map<number, TimelineEvent[]>();
    
    errorEvents.forEach(event => {
      const windowStart = Math.floor(event.timestamp / windowSize) * windowSize;
      if (!windows.has(windowStart)) {
        windows.set(windowStart, []);
      }
      windows.get(windowStart)!.push(event);
    });
    
    // Create clusters for windows with multiple errors
    windows.forEach((events, windowStart) => {
      if (events.length > 1) {
        const affectedNodes = [...new Set(events.map(e => e.nodeId))];
        clusters.push({
          id: `cluster-${windowStart}`,
          pattern: `${events.length} errors in 5-minute window`,
          count: events.length,
          timeWindow: {
            start: windowStart,
            end: windowStart + windowSize
          },
          affectedNodes,
          commonCause: affectedNodes.length === 1 ? 'Single component failure' : 'Cascading failure',
          confidence: events.length > 3 ? 0.9 : 0.7
        });
      }
    });
  }
  
  return clusters;
}

/**
 * Generates mock AI analysis for demonstration
 */
export function generateMockAIAnalysis(graphData: GraphData) {
  const errorNodes = graphData.nodes.filter(n => n.status === 'error' || n.status === 'critical');
  
  if (errorNodes.length === 0) return undefined;
  
  const primaryErrorNode = errorNodes[0];
  
  return {
    rootCause: `High latency in ${primaryErrorNode.label} causing downstream failures`,
    confidence: 0.85,
    suggestedFixes: [
      'Optimize database queries in the affected service',
      'Increase connection pool size',
      'Add circuit breaker pattern to prevent cascade failures',
      'Implement request timeout and retry logic'
    ],
    affectedComponents: errorNodes.map(n => n.label),
    similarIncidents: [
      {
        id: 'INC-2024-001',
        timestamp: Date.now() - 7 * 24 * 60 * 60 * 1000, // 7 days ago
        similarity: 0.92,
        resolution: 'Increased database connection pool from 10 to 50'
      },
      {
        id: 'INC-2024-002',
        timestamp: Date.now() - 14 * 24 * 60 * 60 * 1000, // 14 days ago
        similarity: 0.78,
        resolution: 'Added caching layer to reduce database load'
      }
    ],
    explanation: `The root cause appears to be a performance bottleneck in ${primaryErrorNode.label}. The high latency (${primaryErrorNode.metadata.latency}ms) is causing timeouts and failures in downstream services. This pattern matches previous incidents where database connection exhaustion led to similar cascade failures.`
  };
}
