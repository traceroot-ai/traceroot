'use client';

import React, { useState, useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
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

interface WorkflowCheckbox {
  summarization: boolean;
  issue_creation: boolean;
  pr_creation: boolean;
}

interface WorkflowTableData {
  service_name: string;
  trace_id: string;
  error_count: number;
  summarization: string;
  created_issue: string;
  created_pr: string;
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

export default function RightPanel() {
  const [summarization, setSummarization] = useState<boolean>(false);
  const [issueCreation, setIssueCreation] = useState<boolean>(false);
  const [prCreation, setPrCreation] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [tableData, setTableData] = useState<WorkflowTableData[]>([]);
  const [dataLoading, setDataLoading] = useState<boolean>(true);

  // Load trace data
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
              created_pr: '-'
            }));
            setTableData(transformedData);
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

    loadTraceData();
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

  return (
    <div className="min-h-full flex flex-col p-2">
      {/* Container with 75% width and max-width constraint */}
      <div className="w-3/4 max-w-6xl mx-auto bg-white m-5 p-10 rounded-lg font-mono bg-zinc-50">
        <h2 className="scroll-m-20 mb-5 text-3xl font-semibold first:mt-0">
          Workflow
        </h2>
        <h3 className="leading-7 [&:not(:first-child)]:mb-5">
          Let TraceRoot AI agents automatically summarize error logs and create issues or PRs for you.
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
      <div className="w-3/4 max-w-6xl mx-auto bg-white m-5 p-10 rounded-lg font-mono bg-zinc-50">
        <h3 className="text-xl font-semibold mb-4">Results</h3>
        {dataLoading ? (
          <div className="flex justify-center items-center py-8">
            <p className="text-gray-500">Loading trace data...</p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Trace ID</TableHead>
                <TableHead>Service Name</TableHead>
                <TableHead>Number of Errors</TableHead>
                {summarization && <TableHead>Summarization</TableHead>}
                {issueCreation && <TableHead>Created Issue</TableHead>}
                {prCreation && <TableHead>Created PR</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableData.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3 + (summarization ? 1 : 0) + (issueCreation ? 1 : 0) + (prCreation ? 1 : 0)} className="text-center py-8 text-gray-500">
                    No trace data available for the last 6 hours
                  </TableCell>
                </TableRow>
              ) : (
                tableData.map((row, index) => (
                  <TableRow key={index}>
                    <TableCell>{row.trace_id}</TableCell>
                    <TableCell className="font-medium">{row.service_name}</TableCell>
                    <TableCell>{row.error_count}</TableCell>
                    {summarization && (
                      <TableCell>
                        <SummarizationCell text={row.summarization} />
                      </TableCell>
                    )}
                    {issueCreation && <TableCell>{row.created_issue}</TableCell>}
                    {prCreation && <TableCell>{row.created_pr}</TableCell>}
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
