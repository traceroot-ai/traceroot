'use client';

import React, { useState, useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Trash2 } from 'lucide-react';

interface WorkflowCheckbox {
  summarization: boolean;
  issue_creation: boolean;
  pr_creation: boolean;
}

interface Pattern {
  pattern_id: string;
  pattern_description: string;
}

interface WorkflowTableData {
  service_name: string;
  trace_id: string;
  error_count: number;
  summarization: string;
  created_issue: string;
  created_pr: string;
  summarization_chat_id?: string | null;
  created_issue_chat_id?: string | null;
  created_pr_chat_id?: string | null;
  pattern: Pattern;
  timestamp: string;
}

interface SummarizationCellProps {
  text: string;
}

function SummarizationCell({ text }: SummarizationCellProps) {
  const maxLength = 20;
  const shouldTruncate = text.length > maxLength;
  const truncatedText = shouldTruncate ? `${text.substring(0, maxLength)}...` : text;

  if (!shouldTruncate) {
    return <span>{text}</span>;
  }

  return (
    <Dialog>
      <DialogTrigger asChild>
        <span className="cursor-pointer underline">
          {truncatedText}
        </span>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Full Summarization</DialogTitle>
        </DialogHeader>
        <div className="mt-4">
          <p className="text-sm text-gray-700">{text}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface TraceIdCellProps {
  traceId: string;
}

function TraceIdCell({ traceId }: TraceIdCellProps) {
  const maxLength = 15;
  const shouldTruncate = traceId.length > maxLength;
  const truncatedText = shouldTruncate ? `${traceId.substring(0, maxLength)}...` : traceId;

  if (!shouldTruncate) {
    return <span>{traceId}</span>;
  }

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">
          {truncatedText}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{traceId}</p>
      </TooltipContent>
    </Tooltip>
  );
}

export default function RightPanel() {
  const [summarization, setSummarization] = useState<boolean>(false);
  const [issueCreation, setIssueCreation] = useState<boolean>(false);
  const [prCreation, setPrCreation] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [tableData, setTableData] = useState<WorkflowTableData[]>([]);
  const [dataLoading, setDataLoading] = useState<boolean>(true);
  const [workflowItems, setWorkflowItems] = useState<WorkflowTableData[]>([]);

  // Load trace data with polling
  useEffect(() => {
          const loadTraceData = async () => {
        try {
          // Calculate time range: current time and 6 hours ago
          const endTime = new Date();
          const startTime = new Date(endTime.getTime() - 6 * 60 * 60 * 1000); // 6 hours ago

          const response = await fetch(
            `/api/list_trace?startTime=${encodeURIComponent(startTime.toISOString())}&endTime=${encodeURIComponent(endTime.toISOString())}`,
            {
              method: 'GET',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
              },
            }
          );

          if (response.ok) {
            const data = await response.json();
            if (data.success && data.data) {
              // Transform trace data to table format
              const transformedData: WorkflowTableData[] = data.data.map((trace: any) => ({
                service_name: trace.service_name || 'Unknown Service',
                trace_id: trace.id,
                error_count: (trace.num_error_logs || 0) + (trace.num_critical_logs || 0),
                summarization: '-',
                created_issue: '-',
                created_pr: '-',
                pattern: {
                  pattern_id: `pattern_${trace.id.slice(-8)}`,
                  pattern_description: '-'
                },
                timestamp: trace.start_time ? new Date(trace.start_time * 1000).toISOString() : new Date().toISOString()
              }));

              // Check for new traces not in existing workflow items and post them
              const existingTraceIds = new Set(workflowItems.map(item => item.trace_id));
              const newTraces = transformedData.filter(trace => !existingTraceIds.has(trace.trace_id));

              if (newTraces.length > 0) {
                console.log(`Found ${newTraces.length} new traces not in workflow items:`, newTraces.map(t => t.trace_id));

                // Post each new trace as a workflow item
                const postPromises = newTraces.map(async (trace) => {
                  try {
                    const response = await fetch('/api/post_workflow_items', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
                      },
                      body: JSON.stringify({
                        trace_id: trace.trace_id,
                        service_name: trace.service_name,
                        error_count: trace.error_count,
                        summarization: trace.summarization,
                        created_issue: trace.created_issue,
                        created_pr: trace.created_pr,
                        pattern: trace.pattern,
                        timestamp: trace.timestamp,
                      }),
                    });

                    if (response.ok) {
                      const data = await response.json();
                      if (data.success) {
                        console.log(`Successfully posted workflow item for trace: ${trace.trace_id}`);
                        return trace;
                      } else {
                        console.error(`Failed to post workflow item for trace ${trace.trace_id}:`, data.error);
                        return null;
                      }
                    } else {
                      console.error(`Failed to post workflow item for trace ${trace.trace_id}:`, response.statusText);
                      return null;
                    }
                  } catch (error) {
                    console.error(`Error posting workflow item for trace ${trace.trace_id}:`, error);
                    return null;
                  }
                });

                // Wait for all posts to complete and update workflowItems state
                try {
                  const results = await Promise.all(postPromises);
                  const successfullyPosted = results.filter(result => result !== null);

                  if (successfullyPosted.length > 0) {
                    // Update workflowItems state with the newly added items
                    setWorkflowItems(prevItems => [...prevItems, ...successfullyPosted]);
                    console.log(`Successfully added ${successfullyPosted.length} new workflow items`);
                  }
                } catch (error) {
                  console.error('Error posting workflow items:', error);
                }
              }

              // Create unified dataset: merge existing workflow items with current trace data
              // Use workflow items as the source of truth, but update with fresh trace data
              const unifiedData = transformedData.map(trace => {
                const existingItem = workflowItems.find(item => item.trace_id === trace.trace_id);
                return existingItem || trace; // Use existing workflow item if available, otherwise use trace data
              });

              // Sort by timestamp (newest first)
              unifiedData.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
              setTableData(unifiedData);
            }
          } else {
            console.error('Failed to load trace data:', response.statusText);
          }
      } catch (error) {
        console.error('Error loading trace data:', error);
      } finally {
        setDataLoading(false);
      }
    };

    // Initial load
    loadTraceData();

    // Set up polling every 3 seconds
    const interval = setInterval(() => {
      loadTraceData();
    }, 3000);

    // Cleanup interval on component unmount
    return () => clearInterval(interval);
  }, [workflowItems]);

  // Load existing workflow items
  useEffect(() => {
    const loadWorkflowItems = async () => {
      try {
        const response = await fetch('/api/get_workflow_items', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          if (data.success && data.workflow_items) {
            setWorkflowItems(data.workflow_items);
          }
        } else {
          console.error('Failed to load workflow items:', response.statusText);
        }
      } catch (error) {
        console.error('Error loading workflow items:', error);
      }
    };

    loadWorkflowItems();
  }, []);

  // Load initial workflow state
  useEffect(() => {
    const loadWorkflowState = async () => {
      try {
        const response = await fetch('/api/get_workflow', {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
          },
        });

        if (response.ok) {
          const data = await response.json();
          if (data.success && data.workflow) {
            setSummarization(data.workflow.summarization);
            setIssueCreation(data.workflow.issue_creation);
            setPrCreation(data.workflow.pr_creation);
          }
        } else {
          console.error('Failed to load workflow state:', response.statusText);
        }
      } catch (error) {
        console.error('Error loading workflow state:', error);
      } finally {
        setLoading(false);
      }
    };

    loadWorkflowState();
  }, []);

  const handleCheckboxChange = async (
    checkboxType: 'summarization' | 'issue_creation' | 'pr_creation',
    checked: boolean,
    setter: React.Dispatch<React.SetStateAction<boolean>>
  ) => {
    try {
      const endpoint = checked ? '/api/post_workflow' : '/api/delete_workflow';
      const method = checked ? 'POST' : 'DELETE';

      const response = await fetch(endpoint, {
        method,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
        },
        body: JSON.stringify({ checkbox_type: checkboxType }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          setter(checked);
        } else {
          console.error('API request failed:', data.error);
        }
      } else {
        console.error('Failed to update workflow:', response.statusText);
      }
    } catch (error) {
      console.error('Error updating workflow:', error);
    }
  };

  const handleDeleteWorkflowItem = async (traceId: string) => {
    try {
      const response = await fetch('/api/delete_workflow_items', {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
        },
        body: JSON.stringify({ trace_id: traceId }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          // Remove the deleted item from both tableData and workflowItems
          setTableData(prevData => prevData.filter(item => item.trace_id !== traceId));
          setWorkflowItems(prevItems => prevItems.filter(item => item.trace_id !== traceId));
          console.log(`Successfully deleted workflow item for trace: ${traceId}`);
        } else {
          console.error('Failed to delete workflow item:', data.error);
        }
      } else {
        console.error('Failed to delete workflow item:', response.statusText);
      }
    } catch (error) {
      console.error('Error deleting workflow item:', error);
    }
  };

  return (
    <div className="min-h-full flex flex-col p-2">
      {/* Container with 75% width and max-width constraint */}
      <div className="w-4/5 max-w-6xl mx-auto bg-white m-5 p-10 rounded-lg font-mono bg-zinc-50">
        <h2 className="scroll-m-20 mb-5 text-3xl font-semibold first:mt-0">
          Workflow
        </h2>
        <h3 className="leading-7 [&:not(:first-child)]:mb-5">
          Let TraceRoot.AI agents automatically summarize error logs and create issues or PRs for you.
        </h3>

        <div className="flex items-center space-x-8 p-1">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="summarization_checkbox"
              checked={summarization}
              disabled={loading}
              onCheckedChange={(checked) =>
                handleCheckboxChange('summarization', checked === true, setSummarization)
              }
            />
            <Label
              htmlFor="summarization_checkbox"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Summarization
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="issue_checkbox"
              checked={issueCreation}
              disabled={loading}
              onCheckedChange={(checked) =>
                handleCheckboxChange('issue_creation', checked === true, setIssueCreation)
              }
            />
            <Label
              htmlFor="issue_checkbox"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Issue Creation
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="pr_checkbox"
              checked={prCreation}
              disabled={loading}
              onCheckedChange={(checked) =>
                handleCheckboxChange('pr_creation', checked === true, setPrCreation)
              }
            />
            <Label
              htmlFor="pr_checkbox"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              PR Creation
            </Label>
          </div>
        </div>
      </div>

      {/* Data Table - separate container with white background */}
      <div className="w-4/5 max-w-6xl mx-auto bg-white m-5 p-10 rounded-lg font-mono bg-zinc-50">
        <h3 className="text-xl font-semibold mb-4">Results</h3>
        {dataLoading ? (
          <div className="flex justify-center items-center py-8">
            <p className="text-gray-500">Loading trace data...</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Timestamp</TableHead>
                <TableHead>Trace ID</TableHead>
                <TableHead>Service Name</TableHead>
                <TableHead># Errors</TableHead>
                {summarization && <TableHead>Summarization</TableHead>}
                {issueCreation && <TableHead>Created Issue</TableHead>}
                {prCreation && <TableHead>Created PR</TableHead>}
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6 + (summarization ? 2 : 0) + (issueCreation ? 2 : 0) + (prCreation ? 2 : 0)} className="text-center py-8 text-gray-500">
                    No trace data available for the last 6 hours
                  </TableCell>
                </TableRow>
              ) : (
                tableData.map((row, index) => (
                  <TableRow key={index}>
                    <TableCell className="text-sm text-gray-600">
                      {new Date(row.timestamp).toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <TraceIdCell traceId={row.trace_id} />
                    </TableCell>
                    <TableCell className="font-medium">{row.service_name}</TableCell>
                    <TableCell>{row.error_count}</TableCell>
                    {summarization && (
                      <TableCell>
                        <SummarizationCell text={row.summarization} />
                      </TableCell>
                    )}
                    {issueCreation && <TableCell>{row.created_issue}</TableCell>}
                    {prCreation && <TableCell>{row.created_pr}</TableCell>}
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleDeleteWorkflowItem(row.trace_id)}
                        className="h-8 w-8 p-0 text-red-500 hover:text-red-700 hover:bg-red-50"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        )}
      </div>
    </div>
  );
}
