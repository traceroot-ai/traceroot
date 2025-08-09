'use client';

import React, { useState } from 'react';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

export default function RightPanel() {
  const [checkbox1, setCheckbox1] = useState<boolean>(false);
  const [checkbox2, setCheckbox2] = useState<boolean>(false);
  const [checkbox3, setCheckbox3] = useState<boolean>(false);

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
        
        <div className="space-y-5 p-1">
          <div className="flex items-center space-x-2">
            <Checkbox
              id="checkbox1"
              checked={checkbox1}
              onCheckedChange={(checked) => setCheckbox1(checked === true)}
            />
            <Label
              htmlFor="checkbox1"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Summarization
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="checkbox2"
              checked={checkbox2}
              onCheckedChange={(checked) => setCheckbox2(checked === true)}
            />
            <Label
              htmlFor="checkbox2"
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              Issue Creation
            </Label>
          </div>

          <div className="flex items-center space-x-2">
            <Checkbox
              id="checkbox3"
              checked={checkbox3}
              onCheckedChange={(checked) => setCheckbox3(checked === true)}
            />
            <Label
              htmlFor="checkbox3"
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
