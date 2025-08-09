import React from 'react';
import { GraphNode, LogEntry, SourceCodeInfo } from '@/types/graph';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ExternalLink, Clock, AlertTriangle, Code, Server } from 'lucide-react';

interface NodeInspectorProps {
  node: GraphNode | null;
  isOpen: boolean;
  onClose: () => void;
}

export default function NodeInspector({ node, isOpen, onClose }: NodeInspectorProps) {
  if (!node) return null;

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  const formatDuration = (duration: number) => {
    if (duration < 1000) return `${duration}ms`;
    return `${(duration / 1000).toFixed(2)}s`;
  };

  const getLogLevelColor = (level: string) => {
    switch (level) {
      case 'error': return 'bg-red-100 text-red-800';
      case 'critical': return 'bg-red-200 text-red-900';
      case 'warning': return 'bg-yellow-100 text-yellow-800';
      case 'info': return 'bg-blue-100 text-blue-800';
      case 'debug': return 'bg-gray-100 text-gray-800';
      default: return 'bg-gray-100 text-gray-800';
    }
  };

  const renderStackTrace = () => {
    if (!node.metadata.stackTrace) return null;
    
    return (
      <div className="space-y-2">
        <h4 className="font-medium text-sm text-gray-700">Stack Trace</h4>
        <div className="bg-gray-900 text-green-400 p-3 rounded text-xs font-mono max-h-60 overflow-y-auto">
          {node.metadata.stackTrace.map((line, index) => (
            <div key={index} className="mb-1">
              {line}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderSourceCode = () => {
    if (!node.metadata.sourceCode) return null;
    
    const sourceCode = node.metadata.sourceCode;
    
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h4 className="font-medium text-sm text-gray-700">Source Code</h4>
          {sourceCode.githubUrl && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(sourceCode.githubUrl, '_blank')}
              className="text-xs"
            >
              <ExternalLink className="w-3 h-3 mr-1" />
              View on GitHub
            </Button>
          )}
        </div>
        
        <div className="bg-gray-50 p-2 rounded text-xs">
          <div className="text-gray-600 mb-2">
            {sourceCode.repository} • {sourceCode.filePath}:{sourceCode.lineNumber}
          </div>
        </div>
        
        <div className="bg-gray-900 text-white p-3 rounded text-xs font-mono max-h-60 overflow-y-auto">
          {sourceCode.contextLines.map((line, index) => (
            <div 
              key={index} 
              className={`mb-1 ${index === Math.floor(sourceCode.contextLines.length / 2) ? 'bg-red-800' : ''}`}
            >
              <span className="text-gray-500 mr-3">
                {sourceCode.lineNumber - Math.floor(sourceCode.contextLines.length / 2) + index}
              </span>
              {line}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderLogs = () => {
    if (!node.metadata.logs || node.metadata.logs.length === 0) return null;
    
    const logs = node.metadata.logs.slice(0, 20); // Show latest 20 logs
    
    return (
      <div className="space-y-2">
        <h4 className="font-medium text-sm text-gray-700">Recent Logs</h4>
        <div className="space-y-1 max-h-60 overflow-y-auto">
          {logs.map((log, index) => (
            <div key={index} className="bg-gray-50 p-2 rounded text-xs">
              <div className="flex items-center justify-between mb-1">
                <Badge className={`text-xs ${getLogLevelColor(log.level)}`}>
                  {log.level.toUpperCase()}
                </Badge>
                <span className="text-gray-500 text-xs">
                  {formatTimestamp(log.timestamp)}
                </span>
              </div>
              <div className="text-gray-800">{log.message}</div>
              {log.metadata && Object.keys(log.metadata).length > 0 && (
                <details className="mt-1">
                  <summary className="text-gray-600 cursor-pointer text-xs">
                    Metadata
                  </summary>
                  <pre className="text-xs text-gray-600 mt-1 bg-white p-1 rounded">
                    {JSON.stringify(log.metadata, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  const renderPerformanceMetrics = () => {
    const { latency, memoryUsage, cpuUsage, duration } = node.metadata;
    
    return (
      <div className="space-y-4">
        <h4 className="font-medium text-sm text-gray-700">Performance Metrics</h4>
        
        <div className="grid grid-cols-2 gap-4">
          {duration && (
            <div className="bg-gray-50 p-3 rounded">
              <div className="flex items-center mb-1">
                <Clock className="w-4 h-4 mr-1 text-gray-600" />
                <span className="text-sm font-medium">Duration</span>
              </div>
              <div className="text-lg font-bold text-gray-800">
                {formatDuration(duration)}
              </div>
            </div>
          )}
          
          {latency && (
            <div className="bg-gray-50 p-3 rounded">
              <div className="flex items-center mb-1">
                <AlertTriangle className="w-4 h-4 mr-1 text-gray-600" />
                <span className="text-sm font-medium">Latency</span>
              </div>
              <div className="text-lg font-bold text-gray-800">
                {formatDuration(latency)}
              </div>
            </div>
          )}
          
          {memoryUsage && (
            <div className="bg-gray-50 p-3 rounded">
              <div className="flex items-center mb-1">
                <Server className="w-4 h-4 mr-1 text-gray-600" />
                <span className="text-sm font-medium">Memory</span>
              </div>
              <div className="text-lg font-bold text-gray-800">
                {(memoryUsage / 1024 / 1024).toFixed(1)} MB
              </div>
            </div>
          )}
          
          {cpuUsage && (
            <div className="bg-gray-50 p-3 rounded">
              <div className="flex items-center mb-1">
                <Code className="w-4 h-4 mr-1 text-gray-600" />
                <span className="text-sm font-medium">CPU Usage</span>
              </div>
              <div className="text-lg font-bold text-gray-800">
                {cpuUsage.toFixed(1)}%
              </div>
            </div>
          )}
        </div>
        
        {node.metadata.errorCount > 0 && (
          <div className="bg-red-50 border border-red-200 p-3 rounded">
            <div className="flex items-center mb-1">
              <AlertTriangle className="w-4 h-4 mr-1 text-red-600" />
              <span className="text-sm font-medium text-red-800">Error Count</span>
            </div>
            <div className="text-lg font-bold text-red-800">
              {node.metadata.errorCount} errors
            </div>
            {node.metadata.lastError && (
              <div className="mt-2 text-sm text-red-700">
                Latest: {node.metadata.lastError}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="max-w-4xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <div 
              className="w-4 h-4 rounded-full"
              style={{ backgroundColor: getNodeColor(node) }}
            />
            <span>{node.label}</span>
            <Badge variant="outline" className="text-xs">
              {node.type}
            </Badge>
          </DialogTitle>
        </DialogHeader>
        
        <Tabs defaultValue="overview" className="w-full">
          <TabsList className="grid w-full grid-cols-4">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="code">Code</TabsTrigger>
            <TabsTrigger value="logs">Logs</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
          </TabsList>
          
          <TabsContent value="overview" className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div>
                <h4 className="font-medium text-sm text-gray-700 mb-2">Basic Info</h4>
                <div className="space-y-1 text-sm">
                  <div><strong>ID:</strong> {node.id}</div>
                  <div><strong>Type:</strong> {node.type}</div>
                  <div><strong>Status:</strong> 
                    <Badge className={`ml-2 ${
                      node.status === 'healthy' ? 'bg-green-100 text-green-800' :
                      node.status === 'warning' ? 'bg-yellow-100 text-yellow-800' :
                      node.status === 'error' ? 'bg-red-100 text-red-800' :
                      'bg-red-200 text-red-900'
                    }`}>
                      {node.status}
                    </Badge>
                  </div>
                  {node.serviceName && <div><strong>Service:</strong> {node.serviceName}</div>}
                  {node.functionName && <div><strong>Function:</strong> {node.functionName}</div>}
                  {node.moduleName && <div><strong>Module:</strong> {node.moduleName}</div>}
                </div>
              </div>
              
              <div>
                <h4 className="font-medium text-sm text-gray-700 mb-2">Trace Info</h4>
                <div className="space-y-1 text-sm">
                  {node.metadata.traceId && <div><strong>Trace ID:</strong> {node.metadata.traceId}</div>}
                  {node.metadata.spanId && <div><strong>Span ID:</strong> {node.metadata.spanId}</div>}
                  {node.metadata.startTime && (
                    <div><strong>Start Time:</strong> {formatTimestamp(node.metadata.startTime)}</div>
                  )}
                  {node.metadata.endTime && (
                    <div><strong>End Time:</strong> {formatTimestamp(node.metadata.endTime)}</div>
                  )}
                </div>
              </div>
            </div>
            
            {renderPerformanceMetrics()}
          </TabsContent>
          
          <TabsContent value="code" className="space-y-4">
            {renderStackTrace()}
            {renderSourceCode()}
          </TabsContent>
          
          <TabsContent value="logs" className="space-y-4">
            {renderLogs()}
          </TabsContent>
          
          <TabsContent value="performance" className="space-y-4">
            {renderPerformanceMetrics()}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}

// Helper function to get node color (matching the graph component)
function getNodeColor(node: GraphNode) {
  switch (node.status) {
    case 'healthy': return '#10b981';
    case 'warning': return '#f59e0b';
    case 'error': return '#ef4444';
    case 'critical': return '#dc2626';
    default: return '#6b7280';
  }
}
