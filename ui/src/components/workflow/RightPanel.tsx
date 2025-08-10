'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { ChatRequest, ChatResponse } from '@/models/chat';
import { OPENAI_MODELS, PROVIDERS, CHAT_MODE } from '@/constants/model';
import { generateUuidHex } from '@/utils/uuid';

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
  is_duplicate?: boolean;
}

function FancyLoadingSpinner({ type }: { type: 'summarization' | 'issue' | 'pr' }) {
  const colors = {
    summarization: {
      gradient: 'from-purple-400 via-pink-500 to-red-500',
      glow: 'shadow-purple-500/50',
      ring: 'ring-purple-500/30'
    },
    issue: {
      gradient: 'from-blue-400 via-cyan-500 to-teal-500',
      glow: 'shadow-blue-500/50',
      ring: 'ring-blue-500/30'
    },
    pr: {
      gradient: 'from-green-400 via-emerald-500 to-cyan-500',
      glow: 'shadow-green-500/50',
      ring: 'ring-green-500/30'
    }
  };

  const color = colors[type];

  return (
    <div className="flex items-center space-x-3">
      {/* Main spinner with gradient and glow */}
      <div className="relative">
        <div className={`absolute inset-0 rounded-full bg-gradient-to-r ${color.gradient} opacity-75 blur-sm animate-pulse`}></div>
        <div className={`relative w-5 h-5 rounded-full bg-gradient-to-r ${color.gradient} animate-spin shadow-lg ${color.glow}`}>
          <div className="absolute inset-1 rounded-full bg-white/20 backdrop-blur-sm"></div>
          <div className="absolute inset-2 rounded-full bg-white/40"></div>
        </div>
      </div>

      {/* Animated dots */}
      <div className="flex space-x-1">
        <div className={`w-1.5 h-1.5 rounded-full bg-gradient-to-r ${color.gradient} animate-bounce`} style={{ animationDelay: '0ms' }}></div>
        <div className={`w-1.5 h-1.5 rounded-full bg-gradient-to-r ${color.gradient} animate-bounce`} style={{ animationDelay: '150ms' }}></div>
        <div className={`w-1.5 h-1.5 rounded-full bg-gradient-to-r ${color.gradient} animate-bounce`} style={{ animationDelay: '300ms' }}></div>
      </div>

      {/* Pulsing ring */}
      <div className={`absolute w-8 h-8 rounded-full ring-2 ${color.ring} animate-ping opacity-20 pointer-events-none`}></div>
    </div>
  );
}

interface SummarizationCellProps {
  text: string;
  isDuplicate?: boolean;
  isLoading?: boolean;
}

function SummarizationCell({ text, isDuplicate, isLoading }: SummarizationCellProps) {
  if (isDuplicate) {
    return <Badge variant="outline">DUPLICATED</Badge>;
  }

  if (isLoading && text === '-') {
    return <FancyLoadingSpinner type="summarization" />;
  }

  const maxLength = 15;
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

interface IssueCellProps {
  text: string;
  isDuplicate?: boolean;
  isLoading?: boolean;
}

function IssueCell({ text, isDuplicate, isLoading }: IssueCellProps) {
  if (isDuplicate) {
    return <Badge variant="outline">DUPLICATED</Badge>;
  }

  if (isLoading && text === '-') {
    return <FancyLoadingSpinner type="issue" />;
  }

  // Check if the text contains a GitHub issue URL pattern
  const githubIssueRegex = /https:\/\/github\.com\/[^\/]+\/[^\/]+\/issues\/(\d+)/;
  const match = text.match(githubIssueRegex);

  if (match) {
    const issueNumber = match[1];
    const issueUrl = match[0];

    return (
      <a
        href={issueUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-black hover:text-gray-700 underline font-medium"
      >
        #{issueNumber}
      </a>
    );
  }

  // If no GitHub issue URL found, display the text normally with truncation if needed
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
          <DialogTitle>Created Issue</DialogTitle>
        </DialogHeader>
        <div className="mt-4">
          <p className="text-sm text-gray-700">{text}</p>
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface PRCellProps {
  text: string;
  isDuplicate?: boolean;
  isLoading?: boolean;
}

function PRCell({ text, isDuplicate, isLoading }: PRCellProps) {
  if (isDuplicate) {
    return <Badge variant="outline">DUPLICATED</Badge>;
  }

  if (isLoading && text === '-') {
    return <FancyLoadingSpinner type="pr" />;
  }

  // Check if the text contains a GitHub PR URL pattern
  const githubPRRegex = /https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/(\d+)/;
  const match = text.match(githubPRRegex);

  if (match) {
    const prNumber = match[1];
    const prUrl = match[0];

    return (
      <a
        href={prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-black hover:text-gray-700 underline font-medium"
      >
        #{prNumber}
      </a>
    );
  }

  // If no GitHub PR URL found, display the text normally with truncation if needed
  const maxLength = 15;
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
          <DialogTitle>Created PR</DialogTitle>
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
  const maxLength = 10;
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
  const [workflowItemsLoading, setWorkflowItemsLoading] = useState<boolean>(true);
  const [processingItems, setProcessingItems] = useState<Set<string>>(new Set());
  const [processingSummarization, setProcessingSummarization] = useState<Set<string>>(new Set());
  const [processingIssues, setProcessingIssues] = useState<Set<string>>(new Set());
  const [processingPRs, setProcessingPRs] = useState<Set<string>>(new Set());
  // Local set to track existing workflow item trace IDs
  const [existingTraceIds, setExistingTraceIds] = useState<Set<string>>(new Set());
  // Ref to always have the latest workflowItems inside polling closures
  const workflowItemsRef = useRef<WorkflowTableData[]>([]);

  // Keep ref in sync with state
  useEffect(() => {
    workflowItemsRef.current = workflowItems;
  }, [workflowItems]);

  // Load trace data with polling - ONLY start after workflow items are loaded
  useEffect(() => {
    // Don't start polling until workflow items are loaded
    if (workflowItemsLoading) return;

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

            // Check for new traces not in existing local set
            const newTraces = transformedData.filter(trace => !existingTraceIds.has(trace.trace_id));

              if (newTraces.length > 0) {
                console.log(`Found ${newTraces.length} new traces not in workflow items:`, newTraces.map(t => t.trace_id));

                // Check if service names already exist in current workflow items
                // Mark new traces as duplicates if their service name already exists
                const existingServiceNames = new Set(workflowItemsRef.current.map(item => item.service_name));
                const tracesWithDuplicateCheck = newTraces.map(trace => {
                  if (existingServiceNames.has(trace.service_name)) {
                    console.log(`Marking new trace ${trace.trace_id} as duplicate due to existing service name: ${trace.service_name}`);
                    return { ...trace, is_duplicate: true };
                  }
                  return trace;
                });

                // Post each new trace as a workflow item
                const postPromises = tracesWithDuplicateCheck.map(async (trace) => {
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
                        is_duplicate: trace.is_duplicate || false,
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

                    // Add new trace IDs to the local set
                    setExistingTraceIds(prev => {
                      const newSet = new Set(prev);
                      successfullyPosted.forEach(trace => newSet.add(trace.trace_id));
                      return newSet;
                    });

                    console.log(`Successfully added ${successfullyPosted.length} new workflow items`);
                  }
                } catch (error) {
                  console.error('Error posting workflow items:', error);
                }
              }

              // Create unified dataset: merge existing workflow items with current trace data
              // Use workflow items as the source of truth for workflow fields, but update with fresh trace data
              const unifiedData = transformedData.map(trace => {
                const existingItem = workflowItemsRef.current.find(item => item.trace_id === trace.trace_id);

                if (existingItem) {
                  // Merge: use fresh trace data but preserve workflow-specific fields from database
                  return {
                    ...trace,  // Fresh data (error_count, timestamp, etc.)
                    summarization: existingItem.summarization,
                    created_issue: existingItem.created_issue,
                    created_pr: existingItem.created_pr,
                    summarization_chat_id: existingItem.summarization_chat_id,
                    created_issue_chat_id: existingItem.created_issue_chat_id,
                    created_pr_chat_id: existingItem.created_pr_chat_id,
                    is_duplicate: existingItem.is_duplicate, // Preserve duplicate status from database
                  };
                } else {
                  // New item, use trace data with defaults
                  return trace;
                }
              });

              // Sort by timestamp (newest first)
              unifiedData.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

              // Mark duplicates by service name
              const processedData = markDuplicatesByServiceName(unifiedData);
              setTableData(processedData);
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

    // Set up workflow items refresh every 10 seconds to ensure we have latest data
    const workflowRefreshInterval = setInterval(async () => {
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
            console.log('Refreshed workflow items:', data.workflow_items.length);
          }
        }
      } catch (error) {
        console.error('Error refreshing workflow items:', error);
      }
    }, 10000); // Every 10 seconds

    // Cleanup intervals on component unmount
    return () => {
      clearInterval(interval);
      clearInterval(workflowRefreshInterval);
    };
  }, [workflowItemsLoading, existingTraceIds]);

  // Load existing workflow items FIRST and populate local set
  useEffect(() => {
    const loadWorkflowItems = async () => {
      try {
        setWorkflowItemsLoading(true);
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

            // Populate local set with existing trace IDs
            const traceIdSet = new Set<string>(data.workflow_items.map((item: WorkflowTableData) => item.trace_id));
            setExistingTraceIds(traceIdSet);

            console.log('Loaded workflow items:', data.workflow_items.length);
            console.log('Existing trace IDs:', traceIdSet.size);
          }
        } else {
          console.error('Failed to load workflow items:', response.statusText);
        }
      } catch (error) {
        console.error('Error loading workflow items:', error);
      } finally {
        setWorkflowItemsLoading(false);
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

  // Process summarization when checkbox is checked and table data is loaded
  useEffect(() => {
    if (summarization && !dataLoading && tableData.length > 0) {
      processSummarization();
    }
  }, [summarization, dataLoading, tableData.length]);

  // Process issue creation when checkbox is checked and table data is loaded
  useEffect(() => {
    if (issueCreation && !dataLoading && tableData.length > 0) {
      processIssueCreation();
    }
  }, [issueCreation, dataLoading, tableData.length]);

  // Process PR creation when checkbox is checked and table data is loaded
  useEffect(() => {
    if (prCreation && !dataLoading && tableData.length > 0) {
      processPRCreation();
    }
  }, [prCreation, dataLoading, tableData.length]);

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

  const generateSummarizationForItem = async (item: WorkflowTableData): Promise<{message: string, chatId: string} | null> => {
    try {
      // Calculate reasonable time range for the trace (use current time as fallback)
      const currentTime = new Date();
      const sixHoursAgo = new Date(currentTime.getTime() - (6 * 60 * 60 * 1000)); // 6 hours ago

      const chatRequest: ChatRequest = {
        time: currentTime.getTime(),
        message: 'Summarize the log errors',
        message_type: 'user',
        trace_id: item.trace_id,
        span_ids: [], // Empty span_ids to avoid span processing issues
        start_time: sixHoursAgo.getTime(),
        end_time: currentTime.getTime(),
        model: OPENAI_MODELS.GPT_4O,
        mode: CHAT_MODE.AGENT,
        chat_id: generateUuidHex(), // Generate unique UUID for summarization
        provider: PROVIDERS.OPENAI,
      };

      console.log(`Making chat request for trace ${item.trace_id}:`, {
        trace_id: chatRequest.trace_id,
        message: chatRequest.message,
        model: chatRequest.model
      });

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
        },
        body: JSON.stringify(chatRequest),
      });

      if (response.ok) {
        const chatResponse: ChatResponse = await response.json();
        if (chatResponse.success && chatResponse.data) {
          console.log(`Chat API succeeded for trace ${item.trace_id}`);
          return {
            message: chatResponse.data.message,
            chatId: chatResponse.data.chat_id
          };
        } else {
          console.error('Chat API request failed:', chatResponse.error);
          // Return a fallback message instead of null to avoid blocking the process
          return {
            message: `Error summarization failed for trace ${item.trace_id}. Please check the logs manually.`,
            chatId: ''
          };
        }
      } else {
        console.error('Chat API request failed:', response.status, response.statusText || 'Unknown error');
        // Return a fallback message instead of null
        return {
          message: `Summarization service unavailable for trace ${item.trace_id}. Please try again later.`,
          chatId: ''
        };
      }
    } catch (error) {
      console.error('Error generating summarization:', error);
      // Return a fallback message instead of null
      return {
        message: `Summarization error for trace ${item.trace_id}. Please check the system status.`,
        chatId: ''
      };
    }
  };

  const generateIssueForItem = async (item: WorkflowTableData): Promise<{message: string, chatId: string} | null> => {
    try {
      // Calculate reasonable time range for the trace (use current time as fallback)
      const currentTime = new Date();
      const sixHoursAgo = new Date(currentTime.getTime() - (6 * 60 * 60 * 1000)); // 6 hours ago

      const chatRequest: ChatRequest = {
        time: currentTime.getTime(),
        message: 'Create a GitHub issue for the error logs',
        message_type: 'user',
        trace_id: item.trace_id,
        span_ids: [], // Empty span_ids to avoid span processing issues
        start_time: sixHoursAgo.getTime(),
        end_time: currentTime.getTime(),
        model: OPENAI_MODELS.GPT_4O,
        mode: CHAT_MODE.AGENT,
        chat_id: generateUuidHex(), // Generate unique UUID for issue creation
        provider: PROVIDERS.OPENAI,
      };

      console.log(`Making chat request for issue creation for trace ${item.trace_id}:`, {
        trace_id: chatRequest.trace_id,
        message: chatRequest.message,
        model: chatRequest.model
      });

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
        },
        body: JSON.stringify(chatRequest),
      });

      if (response.ok) {
        const chatResponse: ChatResponse = await response.json();
        if (chatResponse.success && chatResponse.data) {
          console.log(`Chat API succeeded for issue creation for trace ${item.trace_id}`);
          return {
            message: chatResponse.data.message,
            chatId: chatResponse.data.chat_id
          };
        } else {
          console.error('Chat API request failed for issue creation:', chatResponse.error);
          // Return a fallback message instead of null to avoid blocking the process
          return {
            message: `Issue creation failed for trace ${item.trace_id}. Please check the logs manually.`,
            chatId: ''
          };
        }
      } else {
        console.error('Chat API request failed for issue creation:', response.status, response.statusText || 'Unknown error');
        // Return a fallback message instead of null
        return {
          message: `Issue creation service unavailable for trace ${item.trace_id}. Please try again later.`,
          chatId: ''
        };
      }
    } catch (error) {
      console.error('Error generating issue:', error);
      // Return a fallback message instead of null
      return {
        message: `Issue creation error for trace ${item.trace_id}. Please check the system status.`,
        chatId: ''
      };
    }
  };

  const generatePRForItem = async (item: WorkflowTableData): Promise<{message: string, chatId: string} | null> => {
    try {
      // Calculate reasonable time range for the trace (use current time as fallback)
      const currentTime = new Date();
      const sixHoursAgo = new Date(currentTime.getTime() - (6 * 60 * 60 * 1000)); // 6 hours ago

      const chatRequest: ChatRequest = {
        time: currentTime.getTime(),
        message: 'Create a GitHub PR to fix the error logs',
        message_type: 'user',
        trace_id: item.trace_id,
        span_ids: [], // Empty span_ids to avoid span processing issues
        start_time: sixHoursAgo.getTime(),
        end_time: currentTime.getTime(),
        model: OPENAI_MODELS.GPT_4O,
        mode: CHAT_MODE.AGENT,
        chat_id: generateUuidHex(), // Generate unique UUID for PR creation
        provider: PROVIDERS.OPENAI,
      };

      console.log(`Making chat request for PR creation for trace ${item.trace_id}:`, {
        trace_id: chatRequest.trace_id,
        message: chatRequest.message,
        model: chatRequest.model
      });

      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
        },
        body: JSON.stringify(chatRequest),
      });

      if (response.ok) {
        const chatResponse: ChatResponse = await response.json();
        if (chatResponse.success && chatResponse.data) {
          console.log(`Chat API succeeded for PR creation for trace ${item.trace_id}`);
          return {
            message: chatResponse.data.message,
            chatId: chatResponse.data.chat_id
          };
        } else {
          console.error('Chat API request failed for PR creation:', chatResponse.error);
          // Return a fallback message instead of null to avoid blocking the process
          return {
            message: `PR creation failed for trace ${item.trace_id}. Please check the logs manually.`,
            chatId: ''
          };
        }
      } else {
        console.error('Chat API request failed for PR creation:', response.status, response.statusText || 'Unknown error');
        // Return a fallback message instead of null
        return {
          message: `PR creation service unavailable for trace ${item.trace_id}. Please try again later.`,
          chatId: ''
        };
      }
    } catch (error) {
      console.error('Error generating PR:', error);
      // Return a fallback message instead of null
      return {
        message: `PR creation error for trace ${item.trace_id}. Please check the system status.`,
        chatId: ''
      };
    }
  };

  const updateWorkflowItemSummarization = async (traceId: string, summarization: string, chatId?: string) => {
    try {
      // Find the existing workflow item to get all required fields
      const existingItem = workflowItemsRef.current.find(item => item.trace_id === traceId);
      if (!existingItem) {
        console.error(`Workflow item not found for trace: ${traceId}`);
        return false;
      }

      // Create the complete update data with all required fields
      const updateData = {
        trace_id: traceId,
        service_name: existingItem.service_name,
        error_count: existingItem.error_count,
        summarization: summarization,
        created_issue: existingItem.created_issue || '-',
        created_pr: existingItem.created_pr || '-',
        summarization_chat_id: chatId || existingItem.summarization_chat_id,
        created_issue_chat_id: existingItem.created_issue_chat_id,
        created_pr_chat_id: existingItem.created_pr_chat_id,
        pattern: existingItem.pattern,
        timestamp: existingItem.timestamp
      };

      const response = await fetch('/api/post_workflow_items', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
        },
        body: JSON.stringify(updateData),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          console.log(`Successfully updated summarization for trace: ${traceId}`);
          return true;
        } else {
          console.error('Failed to update workflow item:', data.error);
          return false;
        }
      } else {
        console.error('Failed to update workflow item:', response.status, response.statusText || 'Unknown error');
        return false;
      }
    } catch (error) {
      console.error('Error updating workflow item:', error);
      return false;
    }
  };

  const updateWorkflowItemIssue = async (traceId: string, createdIssue: string, chatId?: string) => {
    try {
      // Find the existing workflow item to get all required fields
      const existingItem = workflowItemsRef.current.find(item => item.trace_id === traceId);
      if (!existingItem) {
        console.error(`Workflow item not found for trace: ${traceId}`);
        return false;
      }

      // Create the complete update data with all required fields
      const updateData = {
        trace_id: traceId,
        service_name: existingItem.service_name,
        error_count: existingItem.error_count,
        summarization: existingItem.summarization || '-',
        created_issue: createdIssue,
        created_pr: existingItem.created_pr || '-',
        summarization_chat_id: existingItem.summarization_chat_id,
        created_issue_chat_id: chatId || existingItem.created_issue_chat_id,
        created_pr_chat_id: existingItem.created_pr_chat_id,
        pattern: existingItem.pattern,
        timestamp: existingItem.timestamp
      };

      const response = await fetch('/api/post_workflow_items', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
        },
        body: JSON.stringify(updateData),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          console.log(`Successfully updated issue creation for trace: ${traceId}`);
          return true;
        } else {
          console.error('Failed to update workflow item for issue creation:', data.error);
          return false;
        }
      } else {
        console.error('Failed to update workflow item for issue creation:', response.status, response.statusText || 'Unknown error');
        return false;
      }
    } catch (error) {
      console.error('Error updating workflow item for issue creation:', error);
      return false;
    }
  };

  const updateWorkflowItemPR = async (traceId: string, createdPR: string, chatId?: string) => {
    try {
      // Find the existing workflow item to get all required fields
      const existingItem = workflowItemsRef.current.find(item => item.trace_id === traceId);
      if (!existingItem) {
        console.error(`Workflow item not found for trace: ${traceId}`);
        return false;
      }

      // Create the complete update data with all required fields
      const updateData = {
        trace_id: traceId,
        service_name: existingItem.service_name,
        error_count: existingItem.error_count,
        summarization: existingItem.summarization || '-',
        created_issue: existingItem.created_issue || '-',
        created_pr: createdPR,
        summarization_chat_id: existingItem.summarization_chat_id,
        created_issue_chat_id: existingItem.created_issue_chat_id,
        created_pr_chat_id: chatId || existingItem.created_pr_chat_id,
        pattern: existingItem.pattern,
        timestamp: existingItem.timestamp
      };

      const response = await fetch('/api/post_workflow_items', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NEXT_PUBLIC_USER_SECRET || 'demo-secret'}`,
        },
        body: JSON.stringify(updateData),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success) {
          console.log(`Successfully updated PR creation for trace: ${traceId}`);
          return true;
        } else {
          console.error('Failed to update workflow item for PR creation:', data.error);
          return false;
        }
      } else {
        console.error('Failed to update workflow item for PR creation:', response.status, response.statusText || 'Unknown error');
        return false;
      }
    } catch (error) {
      console.error('Error updating workflow item for PR creation:', error);
      return false;
    }
  };

  const markDuplicatesByServiceName = (items: WorkflowTableData[]): WorkflowTableData[] => {
    // Group items by service name
    const serviceGroups = new Map<string, WorkflowTableData[]>();

    items.forEach(item => {
      const serviceName = item.service_name;
      if (!serviceGroups.has(serviceName)) {
        serviceGroups.set(serviceName, []);
      }
      serviceGroups.get(serviceName)!.push(item);
    });

    // Mark duplicates - keep oldest, mark others as duplicates
    const processedItems = items.map(item => {
      const group = serviceGroups.get(item.service_name)!;

      if (group.length === 1) {
        // Only one item with this service name - not a duplicate
        return { ...item, is_duplicate: false };
      }

      // Multiple items with same service name - find the oldest one
      const sortedGroup = [...group].sort((a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
      );
      const oldestItem = sortedGroup[0];

      return {
        ...item,
        is_duplicate: item.trace_id !== oldestItem.trace_id
      };
    });

    console.log('Duplicate marking results:', {
      totalItems: items.length,
      duplicateCount: processedItems.filter(item => item.is_duplicate).length
    });

    return processedItems;
  };

  const processSummarization = async () => {
    if (!summarization) return;

    // Process traces that are NOT duplicated AND have summarization = "-" (both new and existing)
    const tracesToProcess = tableData.filter(item => {
      // Must NOT be a duplicate
      const isDuplicate = (item as any).is_duplicate === true;

      // Must not be currently processing summarization
      const isNotProcessing = !processingSummarization.has(item.trace_id);

      // Must have summarization = "-" (needs summarization)
      const needsSummarization = item.summarization === '-';

      console.log(`Summarization - Item ${item.trace_id}: isDuplicate=${isDuplicate}, isNotProcessing=${isNotProcessing}, needsSummarization=${needsSummarization}`);

      // ONLY process if not duplicate AND not currently processing AND needs summarization
      return !isDuplicate && isNotProcessing && needsSummarization;
    });

    if (tracesToProcess.length === 0) {
      console.log('No traces need summarization');
      return;
    }

    console.log(`Processing summarization for ${tracesToProcess.length} traces:`, tracesToProcess.map(item => item.trace_id));

    // Process each item sequentially to avoid overwhelming the API
    for (const item of tracesToProcess) {
      // Mark item as being processed for summarization
      setProcessingSummarization(prev => new Set([...prev, item.trace_id]));

      try {
        console.log(`Generating summarization for trace: ${item.trace_id}`);
        let result = null;
        if (item.summarization === '-' || item.summarization === null || item.summarization === undefined) {
          result = await generateSummarizationForItem(item);
        } else {
          console.log(`Skipping summarization for trace: ${item.trace_id} because it already has a summarization`);
        }

        if (result) {
          // Update the database with both message and chat_id
          const success = await updateWorkflowItemSummarization(item.trace_id, result.message, result.chatId);

          if (success) {
            // Update the local state
            setWorkflowItems(prevItems =>
              prevItems.map(workflowItem =>
                workflowItem.trace_id === item.trace_id
                  ? { ...workflowItem, summarization: result.message, summarization_chat_id: result.chatId }
                  : workflowItem
              )
            );

            setTableData(prevData => {
              const updatedData = prevData.map(dataItem =>
                dataItem.trace_id === item.trace_id
                  ? { ...dataItem, summarization: result.message, summarization_chat_id: result.chatId }
                  : dataItem
              );
              // Reapply duplicate marking after updating summarization
              return markDuplicatesByServiceName(updatedData);
            });

            console.log(`Successfully processed summarization for trace: ${item.trace_id} with chat_id: ${result.chatId}`);
          }
        } else {
          console.error(`Failed to generate summarization for trace: ${item.trace_id}`);
        }
      } catch (error) {
        console.error(`Error processing summarization for trace ${item.trace_id}:`, error);
      } finally {
        // Remove item from summarization processing set regardless of success or failure
        setProcessingSummarization(prev => {
          const newSet = new Set(prev);
          newSet.delete(item.trace_id);
          return newSet;
        });
      }
    }
  };

  const processIssueCreation = async () => {
    if (!issueCreation) return;

    // Process traces that are NOT duplicated AND have created_issue = "-" (both new and existing)
    const tracesToProcess = tableData.filter(item => {
      // Must NOT be a duplicate
      const isDuplicate = (item as any).is_duplicate === true;

      // Must not be currently processing issues
      const isNotProcessing = !processingIssues.has(item.trace_id);

      // Must have created_issue = "-" (needs issue creation)
      const needsIssueCreation = item.created_issue === '-';

      console.log(`Issue Creation - Item ${item.trace_id}: isDuplicate=${isDuplicate}, isNotProcessing=${isNotProcessing}, needsIssueCreation=${needsIssueCreation}`);

      // ONLY process if not duplicate AND not currently processing AND needs issue creation
      return !isDuplicate && isNotProcessing && needsIssueCreation;
    });

    if (tracesToProcess.length === 0) {
      console.log('No traces need issue creation');
      return;
    }

    console.log(`Processing issue creation for ${tracesToProcess.length} traces:`, tracesToProcess.map(item => item.trace_id));

    // Process each item sequentially to avoid overwhelming the API
    for (const item of tracesToProcess) {
      // Mark item as being processed for issue creation
      setProcessingIssues(prev => new Set([...prev, item.trace_id]));

      try {
        console.log(`Generating issue for trace: ${item.trace_id}`);
        let result = null;
        if (item.created_issue === '-' || item.created_issue === null || item.created_issue === undefined) {
          result = await generateIssueForItem(item);
        } else {
          console.log(`Skipping issue creation for trace: ${item.trace_id} because it already has an issue`);
        }

        if (result) {
          // Update the database with both message and chat_id
          const success = await updateWorkflowItemIssue(item.trace_id, result.message, result.chatId);

          if (success) {
            // Update the local state
            setWorkflowItems(prevItems =>
              prevItems.map(workflowItem =>
                workflowItem.trace_id === item.trace_id
                  ? { ...workflowItem, created_issue: result.message, created_issue_chat_id: result.chatId }
                  : workflowItem
              )
            );

            setTableData(prevData => {
              const updatedData = prevData.map(dataItem =>
                dataItem.trace_id === item.trace_id
                  ? { ...dataItem, created_issue: result.message, created_issue_chat_id: result.chatId }
                  : dataItem
              );
              // Reapply duplicate marking after updating issue creation
              return markDuplicatesByServiceName(updatedData);
            });

            console.log(`Successfully processed issue creation for trace: ${item.trace_id} with chat_id: ${result.chatId}`);
          }
        } else {
          console.error(`Failed to generate issue for trace: ${item.trace_id}`);
        }
      } catch (error) {
        console.error(`Error processing issue creation for trace ${item.trace_id}:`, error);
      } finally {
        // Remove item from issue processing set regardless of success or failure
        setProcessingIssues(prev => {
          const newSet = new Set(prev);
          newSet.delete(item.trace_id);
          return newSet;
        });
      }
    }
  };

  const processPRCreation = async () => {
    if (!prCreation) return;

    // Process traces that are NOT duplicated AND have created_pr = "-" (both new and existing)
    const tracesToProcess = tableData.filter(item => {
      // Must NOT be a duplicate
      const isDuplicate = (item as any).is_duplicate === true;

      // Must not be currently processing PRs
      const isNotProcessing = !processingPRs.has(item.trace_id);

      // Must have created_pr = "-" (needs PR creation)
      const needsPRCreation = item.created_pr === '-';

      console.log(`PR Creation - Item ${item.trace_id}: isDuplicate=${isDuplicate}, isNotProcessing=${isNotProcessing}, needsPRCreation=${needsPRCreation}`);

      // ONLY process if not duplicate AND not currently processing AND needs PR creation
      return !isDuplicate && isNotProcessing && needsPRCreation;
    });

    if (tracesToProcess.length === 0) {
      console.log('No traces need PR creation');
      return;
    }

    console.log(`Processing PR creation for ${tracesToProcess.length} traces:`, tracesToProcess.map(item => item.trace_id));

    // Process each item sequentially to avoid overwhelming the API
    for (const item of tracesToProcess) {
      // Mark item as being processed for PR creation
      setProcessingPRs(prev => new Set([...prev, item.trace_id]));

      try {
        console.log(`Generating PR for trace: ${item.trace_id}`);
        let result = null;
        if (item.created_pr === '-' || item.created_pr === null || item.created_pr === undefined) {
          result = await generatePRForItem(item);
        } else {
          console.log(`Skipping PR creation for trace: ${item.trace_id} because it already has a PR`);
        }

        if (result) {
          // Update the database with both message and chat_id
          const success = await updateWorkflowItemPR(item.trace_id, result.message, result.chatId);

          if (success) {
            // Update the local state
            setWorkflowItems(prevItems =>
              prevItems.map(workflowItem =>
                workflowItem.trace_id === item.trace_id
                  ? { ...workflowItem, created_pr: result.message, created_pr_chat_id: result.chatId }
                  : workflowItem
              )
            );

            setTableData(prevData => {
              const updatedData = prevData.map(dataItem =>
                dataItem.trace_id === item.trace_id
                  ? { ...dataItem, created_pr: result.message, created_pr_chat_id: result.chatId }
                  : dataItem
              );
              // Reapply duplicate marking after updating PR creation
              return markDuplicatesByServiceName(updatedData);
            });

            console.log(`Successfully processed PR creation for trace: ${item.trace_id} with chat_id: ${result.chatId}`);
          }
        } else {
          console.error(`Failed to generate PR for trace: ${item.trace_id}`);
        }
      } catch (error) {
        console.error(`Error processing PR creation for trace ${item.trace_id}:`, error);
      } finally {
        // Remove item from PR processing set regardless of success or failure
        setProcessingPRs(prev => {
          const newSet = new Set(prev);
          newSet.delete(item.trace_id);
          return newSet;
        });
      }
    }
  };

  return (
    <div className="min-h-full flex flex-col p-2">
      {/* Container with 75% width and max-width constraint */}
      <div className="w-4/5 max-w-6xl mx-auto bg-white m-5 p-10 rounded-lg font-mono bg-zinc-50">
        <h2 className="scroll-m-20 mb-5 text-3xl font-semibold first:mt-0">
          Workflow (Experimental)
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
                    No trace data available
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
                        <SummarizationCell
                          text={row.summarization}
                          isDuplicate={row.is_duplicate}
                          isLoading={processingSummarization.has(row.trace_id)}
                        />
                      </TableCell>
                    )}
                    {issueCreation && (
                      <TableCell>
                        <IssueCell
                          text={row.created_issue}
                          isDuplicate={row.is_duplicate}
                          isLoading={processingIssues.has(row.trace_id)}
                        />
                      </TableCell>
                    )}
                    {prCreation && (
                      <TableCell>
                        <PRCell
                          text={row.created_pr}
                          isDuplicate={row.is_duplicate}
                          isLoading={processingPRs.has(row.trace_id)}
                        />
                      </TableCell>
                    )}
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
