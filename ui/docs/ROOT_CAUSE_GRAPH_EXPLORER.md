# Root Cause Graph Explorer

A comprehensive, interactive visualization tool that maps the entire chain of events leading to errors in distributed systems. Built with React, TypeScript, and SVG for real-time analysis of microservice failures and dependencies.

## Features

### 🎯 Dynamic Microservice Dependency Graph
- **Visual Nodes**: Each node represents a microservice, Python module, or function
- **Smart Edges**: Represent API calls, function calls, or data flows between components
- **Status Indicators**: Color-coded nodes (healthy/warning/error/critical) with real-time status
- **Performance Metrics**: Overlays latency, memory, and CPU usage data on graph nodes

### 🔥 Real-Time Failure Propagation Animation
- **Error Origin**: Nodes where errors originated glow red and pulse
- **Propagation Path**: Animated tracing of downstream impacts in orange and yellow
- **Flow Animation**: Real-time visualization of data flow and failure cascade

### 🔍 Click-to-Inspect Detailed Analysis
- **Error Stack Traces**: Full stack trace with syntax highlighting
- **Source Code Integration**: Linked to GitHub with line-by-line code context
- **Filtered Logs**: Service logs filtered to failure time window
- **Environment State**: Variables and environment captured at crash point

### ⏰ Interactive Timeline Scrubber
- **Event Playback**: "Rewind" and "play" the sequence of events step-by-step
- **Speed Control**: Variable playback speed (0.25x to 8x)
- **Event Markers**: Visual timeline with error events, API calls, and performance spikes
- **Time Navigation**: Click timeline to jump to specific moments

### 🤖 AI-Powered Root Cause Analysis
- **Natural Language Explanations**: AI explains likely causes in plain language
- **Confidence Scoring**: Displays confidence score for each AI-detected root cause
- **Fix Suggestions**: Specific, actionable fix recommendations
- **Similar Incidents**: Historical incident matching with resolution details

### 📊 Error Pattern Recognition
- **Failure Clustering**: Groups related failures and highlights patterns
- **Trend Analysis**: "This API endpoint has caused 5 failures in the last hour"
- **Common Causes**: Identifies recurring failure patterns across services

## Architecture

### Component Structure
```
RootCauseGraphExplorer/
├── RootCauseGraph.tsx          # Main SVG graph visualization
├── NodeInspector.tsx           # Detailed node analysis modal
├── TimelineScrubber.tsx        # Timeline control and playback
├── AIAnalysisPanel.tsx         # AI insights and recommendations
└── utils/
    └── graphTransform.ts       # Data transformation utilities
```

### Data Flow
1. **Trace Data Input**: Receives trace data from TraceRoot API
2. **Graph Transformation**: Converts traces to graph nodes and edges
3. **Real-time Updates**: Animates failure propagation and data flow
4. **AI Analysis**: Generates root cause analysis and suggestions
5. **Interactive Exploration**: Enables deep-dive inspection of components

## Types and Interfaces

### Core Graph Types
```typescript
interface GraphNode {
  id: string;
  label: string;
  type: 'service' | 'function' | 'module' | 'endpoint';
  status: 'healthy' | 'warning' | 'error' | 'critical';
  position: { x: number; y: number };
  metadata: {
    errorCount: number;
    latency?: number;
    memoryUsage?: number;
    cpuUsage?: number;
    logs?: LogEntry[];
    stackTrace?: string[];
    sourceCode?: SourceCodeInfo;
  };
}

interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type: 'api_call' | 'function_call' | 'data_flow';
  status: 'healthy' | 'slow' | 'failing';
  metadata: {
    callCount: number;
    averageLatency: number;
    errorRate: number;
  };
}
```

### AI Analysis Types
```typescript
interface AIAnalysis {
  rootCause: string;
  confidence: number;
  suggestedFixes: string[];
  affectedComponents: string[];
  similarIncidents: IncidentReference[];
  explanation: string;
}
```

## Usage

### Integration with Workflow Page
The Root Cause Graph Explorer is integrated into the workflow page as a separate tab:

```typescript
// In RightPanel.tsx
<Tabs value={activeTab} onValueChange={setActiveTab}>
  <TabsTrigger value="workflow">Workflow</TabsTrigger>
  <TabsTrigger value="graph">Root Cause Graph</TabsTrigger>
  
  <TabsContent value="graph">
    <RootCauseGraphExplorer traces={traces} />
  </TabsContent>
</Tabs>
```

### Basic Usage
```typescript
import RootCauseGraphExplorer from '@/components/graph/RootCauseGraphExplorer';

function MyComponent() {
  const [traces, setTraces] = useState<Trace[]>([]);
  
  return (
    <RootCauseGraphExplorer 
      traces={traces}
      className="w-full h-screen"
    />
  );
}
```

## Features in Detail

### Graph Visualization
- **SVG-based Rendering**: Scalable, interactive graph with smooth animations
- **Force-directed Layout**: Automatic positioning with collision detection
- **Zoom and Pan**: Navigate large graphs with mouse/touch controls
- **Responsive Design**: Adapts to different screen sizes and orientations

### Timeline Features
- **Event Types**: API calls, errors, performance spikes, deployments, log entries
- **Severity Levels**: Visual indicators (critical/high/medium/low)
- **Interactive Scrubbing**: Click timeline to jump to specific events
- **Playback Controls**: Play/pause, speed control, reset functionality

### AI Integration
- **Root Cause Detection**: Machine learning-based failure analysis
- **Pattern Recognition**: Identifies recurring issues and trends
- **Fix Recommendations**: Context-aware suggestions for resolution
- **Historical Correlation**: Links to similar past incidents

### Performance Overlay
- **Real-time Metrics**: CPU, memory, latency overlaid on graph
- **Threshold Alerts**: Visual warnings when metrics exceed limits
- **Trend Visualization**: Historical performance data integration
- **Bottleneck Detection**: Automatic identification of slow components

## Customization

### Styling
The component uses Tailwind CSS classes and can be customized through:
- CSS custom properties for colors and animations
- Tailwind utility classes for layout and spacing
- Custom SVG styles for graph elements

### Configuration
```typescript
// Example configuration options
const config = {
  animation: {
    enabled: true,
    speed: 1,
    pulseIntensity: 0.8
  },
  layout: {
    nodeSpacing: 100,
    edgeLength: 200,
    forceStrength: 0.5
  },
  ui: {
    showTimeline: true,
    showAIPanel: true,
    autoplay: false
  }
};
```

## Dependencies

### Required Packages
- React 19+
- TypeScript 5+
- Lucide React (icons)
- Radix UI components
- Tailwind CSS

### Optional Enhancements
- D3.js for advanced force simulations
- WebGL for performance optimization
- Web Workers for background processing

## Future Enhancements

### Planned Features
- **3D Graph Visualization**: WebGL-based 3D network graphs
- **Real-time Streaming**: Live data updates via WebSocket
- **Export Capabilities**: PNG/SVG export, PDF reports
- **Collaborative Features**: Shared annotations and comments
- **Mobile App**: React Native version for mobile debugging

### Performance Optimizations
- **Virtualization**: Render only visible nodes for large graphs
- **WebGL Acceleration**: GPU-accelerated rendering for complex graphs
- **Data Streaming**: Incremental loading for large datasets
- **Caching**: Intelligent caching of graph layouts and AI analysis

## Contributing

To contribute to the Root Cause Graph Explorer:

1. Fork the repository
2. Create a feature branch
3. Implement your changes
4. Add tests for new functionality
5. Submit a pull request

## License

This component is part of the TraceRoot.AI project and follows the same licensing terms.
