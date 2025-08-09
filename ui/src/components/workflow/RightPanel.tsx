'use client';

import React, { useState, useEffect } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

interface WorkflowCheckbox {
  summarization: boolean;
  issue_creation: boolean;
  pr_creation: boolean;
}

export default function RightPanel() {
  const [summarization, setSummarization] = useState<boolean>(false);
  const [issueCreation, setIssueCreation] = useState<boolean>(false);
  const [prCreation, setPrCreation] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);

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
    </div>
  );
}
