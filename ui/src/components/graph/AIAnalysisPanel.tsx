import React from 'react';
import { AIAnalysis, FailureCluster } from '@/types/graph';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { 
  Brain, 
  AlertTriangle, 
  TrendingUp, 
  Lightbulb, 
  Clock,
  ExternalLink,
  CheckCircle,
  XCircle,
  AlertCircle,
  Target,
  Zap,
  BarChart3
} from 'lucide-react';

interface AIAnalysisPanelProps {
  analysis?: AIAnalysis;
  failureClusters: FailureCluster[];
  isLoading?: boolean;
  onRegenerateAnalysis?: () => void;
  className?: string;
}

export default function AIAnalysisPanel({
  analysis,
  failureClusters,
  isLoading = false,
  onRegenerateAnalysis,
  className = ''
}: AIAnalysisPanelProps) {
  const getConfidenceColor = (confidence: number) => {
    if (confidence >= 0.8) return 'bg-green-50 text-green-700 border-green-200';
    if (confidence >= 0.6) return 'bg-yellow-50 text-yellow-700 border-yellow-200';
    return 'bg-red-50 text-red-700 border-red-200';
  };

  const getConfidenceIcon = (confidence: number) => {
    if (confidence >= 0.8) return <CheckCircle className="w-4 h-4" />;
    if (confidence >= 0.6) return <AlertCircle className="w-4 h-4" />;
    return <XCircle className="w-4 h-4" />;
  };

  const formatTimeWindow = (timeWindow: { start: number; end: number }) => {
    const duration = timeWindow.end - timeWindow.start;
    const minutes = Math.floor(duration / 60000);
    const hours = Math.floor(minutes / 60);
    
    if (hours > 0) {
      return `${hours}h ${minutes % 60}m`;
    }
    return `${minutes}m`;
  };

  if (isLoading) {
    return (
      <div className={`h-full ${className}`}>
        <Card className="h-full border-0 shadow-sm">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center space-x-2 text-lg">
              <Brain className="w-5 h-5 text-blue-600" />
              <span>AI Analysis</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-col items-center justify-center py-12">
              <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-blue-600 mb-4"></div>
              <p className="text-sm text-gray-600 text-center">
                Analyzing root causes and failure patterns...
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    // Make panel its own scroll container so content growth doesn't push outer layout, preventing infinite page scroll.
    // overscroll-contain stops scroll chaining that could look like runaway scrolling when new AI analysis chunks stream in.
    <div className={`h-full flex flex-col min-h-0 ${className}`}>
      <div className="flex-1 flex flex-col gap-4 overflow-y-auto px-0 pb-4 pr-2 scrollbar-thin scrollbar-track-transparent scrollbar-thumb-gray-300 hover:scrollbar-thumb-gray-400 overscroll-contain">
      {/* AI Root Cause Analysis */}
      {analysis && (
        <Card className="border-0 shadow-sm">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center space-x-2 text-lg">
                <Brain className="w-5 h-5 text-blue-600" />
                <span>Root Cause Analysis</span>
              </CardTitle>
              <div className="flex items-center space-x-2">
                <Badge className={`text-xs border ${getConfidenceColor(analysis.confidence)}`}>
                  {getConfidenceIcon(analysis.confidence)}
                  <span className="ml-1">{Math.round(analysis.confidence * 100)}%</span>
                </Badge>
                {onRegenerateAnalysis && (
                  <Button variant="ghost" size="sm" onClick={onRegenerateAnalysis} className="h-8 px-2">
                    <Zap className="w-3 h-3" />
                  </Button>
                )}
              </div>
            </div>
          </CardHeader>
          <CardContent className="space-y-4 pt-0">
            {/* Root Cause */}
            <div className="bg-red-50 border border-red-100 rounded-lg p-3">
              <div className="flex items-start space-x-2 mb-2">
                <AlertTriangle className="w-4 h-4 text-red-600 mt-0.5 flex-shrink-0" />
                <h4 className="font-medium text-red-800 text-sm">Primary Issue</h4>
              </div>
              <p className="text-sm text-red-700 leading-relaxed">{analysis.rootCause}</p>
            </div>

            {/* Explanation */}
            <div>
              <h4 className="font-medium text-gray-900 text-sm mb-2">Analysis</h4>
              <p className="text-sm text-gray-700 leading-relaxed">{analysis.explanation}</p>
            </div>

            {/* Affected Components */}
            {analysis.affectedComponents.length > 0 && (
              <div>
                <h4 className="font-medium text-gray-900 text-sm mb-2 flex items-center">
                  <Target className="w-4 h-4 mr-1" />
                  Affected Components
                </h4>
                <div className="flex flex-wrap gap-1">
                  {analysis.affectedComponents.map((component, index) => (
                    <Badge key={index} variant="outline" className="text-xs">
                      {component}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            <Separator />

            {/* Suggested Fixes */}
            {analysis.suggestedFixes.length > 0 && (
              <div>
                <h4 className="font-medium text-gray-900 text-sm mb-3 flex items-center">
                  <Lightbulb className="w-4 h-4 mr-1 text-yellow-600" />
                  Recommended Actions
                </h4>
                <div className="space-y-2">
                  {analysis.suggestedFixes.slice(0, 3).map((fix, index) => (
                    <div key={index} className="flex items-start space-x-2 bg-yellow-50 border border-yellow-100 rounded p-2">
                      <span className="text-yellow-600 font-medium text-sm mt-0.5">{index + 1}.</span>
                      <span className="text-sm text-yellow-800">{fix}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Similar Incidents */}
            {analysis.similarIncidents.length > 0 && (
              <div>
                <h4 className="font-medium text-gray-900 text-sm mb-2 flex items-center">
                  <BarChart3 className="w-4 h-4 mr-1" />
                  Similar Incidents
                </h4>
                <div className="space-y-2">
                  {analysis.similarIncidents.slice(0, 2).map((incident, index) => (
                    <div key={incident.id} className="bg-blue-50 border border-blue-100 rounded p-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-medium text-blue-800 text-sm">#{incident.id}</span>
                        <Badge variant="outline" className="text-xs">
                          {Math.round(incident.similarity * 100)}% match
                        </Badge>
                      </div>
                      <div className="text-xs text-blue-600 mb-1">
                        {new Date(incident.timestamp).toLocaleDateString()}
                      </div>
                      {incident.resolution && (
                        <div className="text-xs text-blue-700">
                          <strong>Solution:</strong> {incident.resolution}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

  {/* Failure Clusters */}
      {failureClusters.length > 0 && (
        <Card className="border-0 shadow-sm flex-1">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center space-x-2 text-lg">
              <TrendingUp className="w-5 h-5 text-orange-600" />
              <span>Failure Patterns</span>
              <Badge variant="outline" className="text-xs">
                {failureClusters.length}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="space-y-3 max-h-60 overflow-y-auto">
              {failureClusters.map((cluster, index) => (
                <div key={cluster.id} className="bg-orange-50 border border-orange-100 rounded-lg p-3">
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-medium text-orange-800 text-sm">{cluster.pattern}</span>
                    <Badge variant="outline" className="text-xs">
                      {cluster.count}x
                    </Badge>
                  </div>

                  <div className="flex items-center space-x-2 text-xs text-orange-600 mb-2">
                    <Clock className="w-3 h-3" />
                    <span>{formatTimeWindow(cluster.timeWindow)}</span>
                    <span>•</span>
                    <span>{cluster.affectedNodes.length} components</span>
                  </div>

                  {cluster.commonCause && (
                    <div className="text-xs text-orange-700 mb-2">
                      <strong>Cause:</strong> {cluster.commonCause}
                    </div>
                  )}

                  <div className="flex items-center justify-between">
                    <div className="flex flex-wrap gap-1">
                      {cluster.affectedNodes.slice(0, 3).map((nodeId, idx) => (
                        <Badge key={idx} variant="outline" className="text-xs">
                          {nodeId.split('-').pop()}
                        </Badge>
                      ))}
                      {cluster.affectedNodes.length > 3 && (
                        <Badge variant="outline" className="text-xs">
                          +{cluster.affectedNodes.length - 3}
                        </Badge>
                      )}
                    </div>
                    <Badge className={`text-xs border ${getConfidenceColor(cluster.confidence)}`}>
                      {Math.round(cluster.confidence * 100)}%
                    </Badge>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* No Analysis Available */}
      {!analysis && !isLoading && (
        <Card className="border-0 shadow-sm flex-1">
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center space-x-2 text-lg">
              <Brain className="w-5 h-5 text-gray-400" />
              <span>AI Analysis</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-center py-8">
              <Brain className="w-12 h-12 mx-auto text-gray-300 mb-3" />
              <p className="text-gray-500 mb-4 text-sm">No analysis available</p>
              {onRegenerateAnalysis && (
                <Button onClick={onRegenerateAnalysis} size="sm" className="text-sm">
                  <Zap className="w-4 h-4 mr-2" />
                  Generate Analysis
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
      </div>
    </div>
  );
}
