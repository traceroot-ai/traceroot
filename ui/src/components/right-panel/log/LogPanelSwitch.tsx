'use client';

import React from 'react';
import LogOverview from './LogOverview';
import LogDetail from './LogDetail';
import { Span } from '@/models/trace';
import { ViewType } from '../ModeToggle';

interface LogPanelSwitchProps {
  traceId?: string;
  spanIds?: string[];
  traceQueryStartTime?: Date;
  traceQueryEndTime?: Date;
  segments?: Span[];
  traceDurations?: number[];
  traceStartTimes?: Date[];
  traceEndTimes?: Date[];
  traceIDs?: string[];
  tracePercentiles?: string[];
  onTraceSelect?: (traceId: string) => void;
  viewType?: ViewType;
}

export default function LogPanelSwitch({
  traceId,
  spanIds = [],
  traceQueryStartTime,
  traceQueryEndTime,
  segments,
  traceDurations = [],
  traceStartTimes = [],
  traceEndTimes = [],
  traceIDs = [],
  tracePercentiles = [],
  onTraceSelect,
  viewType
}: LogPanelSwitchProps) {
  return (
    <div className="h-screen flex flex-col">
      {traceId ? (
        <LogDetail
          traceId={traceId}
          spanIds={spanIds}
          traceQueryStartTime={traceQueryStartTime}
          traceQueryEndTime={traceQueryEndTime}
          segments={segments}
          viewType={viewType}
        />
      ) : (
        <LogOverview
          traceQueryStartTime={traceQueryStartTime}
          traceQueryEndTime={traceQueryEndTime}
          traceDurations={traceDurations}
          traceStartTimes={traceStartTimes}
          traceEndTimes={traceEndTimes}
          traceIDs={traceIDs}
          tracePercentiles={tracePercentiles}
          onTraceSelect={onTraceSelect}
        />
      )}
    </div>
  );
}
